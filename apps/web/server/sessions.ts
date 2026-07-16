import type { Request, Response } from "express";
import "./env.js";
import {
  createFileAccessToken,
  createStoredFileId,
  deleteStoredFile,
  putStoredFile,
  readStoredFile,
  type StoredFileKind
} from "./fileStore.js";
import { getSessionFileResponsePolicy } from "./sessionFileResponsePolicy.js";
import {
  TombstonedSessionUploadError,
  applyUploadedSessionFileMetadata,
  assertSessionFileUploadAllowed,
  removeOwnedEphemeralFilesFromSession,
  runSessionFileDeletionTransaction,
  runSessionFileUploadTransaction,
  selectTombstonedSessionStorageKeys,
  type EphemeralSessionFileIdentity
} from "./sessionFileUploadSafety.js";
import {
  ActiveEphemeralFileDeletionError,
  activeEphemeralFileRegistry
} from "./activeEphemeralFileRegistry.js";
import {
  DEFAULT_SESSION_STATE_KEY,
  enqueueSessionRepositoryOperation,
  enqueueSessionStateInspection,
  enqueueSessionStateUpdate,
  findStoredFileCapability,
  deleteSessionState,
  readSessionState,
  readAllSessionStateEntries,
  readSessionStateSnapshot,
  readSessionStateVersion,
  writeSessionState
} from "./sessionRepository.js";
import {
  getAuthenticatedServiceUser,
  getAuthenticatedStateKey
} from "./chatHtmlService.js";
import {
  compactEmptyStoredSessions,
  ensureStoredSession,
  findStoredSession,
  isStoredSessionDeleted,
  mergeStoredMessage,
  mergeStoredSessionFiles,
  normalizeDeletedSessionIds,
  normalizeStoredSessionState,
  sessionStateNow,
  stringValue,
  upsertStoredMessages
} from "./sessionStateModel.js";
import { resolveClientSessionSave } from "./sessionSavePolicy.js";
import { normalizeSessionSaveClientId } from "./sessionSaveRevision.js";
import type {
  SessionMessageInput,
  SessionMessagePatch,
  SessionMessageSnapshot,
  StoredSession,
  StoredSessionFile,
  StoredSessionState
} from "./sessionStateTypes.js";

export { selectPresentSessionMessagePatch } from "./sessionStateModel.js";
export { mergeClientSaveState } from "./sessionStateMerge.js";
export type {
  SessionMessageInput,
  SessionMessagePatch,
  SessionMessageSnapshot,
  StoredSessionFile
} from "./sessionStateTypes.js";

const SESSION_CLIENT_ID_HEADER = "x-chathtml-client-id";
const LEGACY_SESSION_CLIENT_ID_HEADER = "x-streamui-client-id";

function positiveQuota(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const MAX_ACCOUNT_SESSIONS = positiveQuota(
  process.env.CHATHTML_MAX_ACCOUNT_SESSIONS,
  200
);
const MAX_ACCOUNT_MESSAGES = positiveQuota(
  process.env.CHATHTML_MAX_ACCOUNT_MESSAGES,
  5_000
);
const MAX_ACCOUNT_FILES = positiveQuota(
  process.env.CHATHTML_MAX_ACCOUNT_FILES,
  200
);
const MAX_ACCOUNT_FILE_BYTES = positiveQuota(
  process.env.CHATHTML_MAX_ACCOUNT_FILE_BYTES,
  100 * 1024 * 1024
);

class AccountQuotaError extends Error {}

function assertAccountQuota(
  state: StoredSessionState,
  additionalFileBytes = 0,
  additionalFiles = 0
): void {
  const sessions = state.sessions.length;
  const messages = state.sessions.reduce(
    (total, session) => total + session.messages.length,
    0
  );
  const files = state.sessions.reduce(
    (total, session) => total + (session.files?.length ?? 0),
    0
  );
  const fileBytes = state.sessions.reduce(
    (total, session) =>
      total +
      (session.files ?? []).reduce(
        (sessionTotal, file) => sessionTotal + Math.max(0, file.size ?? 0),
        0
      ),
    0
  );
  if (sessions > MAX_ACCOUNT_SESSIONS) {
    throw new AccountQuotaError(
      `An account can store at most ${MAX_ACCOUNT_SESSIONS} sessions during alpha.`
    );
  }
  if (messages > MAX_ACCOUNT_MESSAGES) {
    throw new AccountQuotaError(
      `An account can store at most ${MAX_ACCOUNT_MESSAGES} messages during alpha.`
    );
  }
  if (files + additionalFiles > MAX_ACCOUNT_FILES) {
    throw new AccountQuotaError(
      `An account can store at most ${MAX_ACCOUNT_FILES} files during alpha.`
    );
  }
  if (fileBytes + additionalFileBytes > MAX_ACCOUNT_FILE_BYTES) {
    throw new AccountQuotaError(
      `The account's ${Math.floor(MAX_ACCOUNT_FILE_BYTES / 1024 / 1024)} MB file-storage allowance has been reached.`
    );
  }
}

export function getSessionStateKeyFromClientId(_input: unknown): string {
  return DEFAULT_SESSION_STATE_KEY;
}

function getRequestClientId(req: Request): string {
  const headerId = normalizeSessionSaveClientId(
    req.get(SESSION_CLIENT_ID_HEADER) ?? req.get(LEGACY_SESSION_CLIENT_ID_HEADER)
  );
  if (headerId) {
    return headerId;
  }

  const queryId = normalizeSessionSaveClientId(req.query.clientId);
  if (queryId) {
    return queryId;
  }

  const body =
    req.body && typeof req.body === "object"
      ? (req.body as { clientId?: unknown })
      : {};
  return normalizeSessionSaveClientId(body.clientId);
}

function getRequestStateKey(req: Request): string {
  getRequestClientId(req);
  return getAuthenticatedStateKey(req);
}

function getRequestBasePath(req: Request): string {
  const forwardedPrefix = stringValue(req.headers["x-forwarded-prefix"])
    .split(",")[0]
    .trim();
  if (
    !forwardedPrefix ||
    forwardedPrefix === "/" ||
    !/^\/(?:[A-Za-z0-9._~-]+\/?)*$/.test(forwardedPrefix)
  ) {
    return "";
  }
  return forwardedPrefix.replace(/\/+$/, "");
}

export function buildSessionFileContentUrl(
  basePath: string,
  fileId: string,
  accessToken: string,
  download = false
): string {
  const id = encodeURIComponent(fileId);
  const token = encodeURIComponent(accessToken);
  return `${basePath}/api/files/${id}/content?token=${token}${
    download ? "&download=1" : ""
  }`;
}

function withFileUrls(req: Request, file: StoredSessionFile): StoredSessionFile {
  if (!file.accessToken) {
    return file;
  }

  const basePath = getRequestBasePath(req);
  return {
    ...file,
    // Keep browser-facing file URLs on the application origin. In the
    // two-port development topology, absolute backend URLs look external to
    // the opaque preview iframe and are incorrectly sent through the public
    // media proxy, which intentionally rejects loopback addresses.
    embedUrl: buildSessionFileContentUrl(
      basePath,
      file.id,
      file.accessToken
    ),
    downloadUrl: buildSessionFileContentUrl(
      basePath,
      file.id,
      file.accessToken,
      true
    )
  };
}

function presentState(req: Request, state: StoredSessionState): StoredSessionState {
  const compacted = compactEmptyStoredSessions(
    state.sessions,
    state.activeSessionId
  );

  return {
    activeSessionId: compacted.activeSessionId,
    sessions: compacted.sessions.map((session) => ({
      ...session,
      files: (session.files ?? [])
        .filter((file) => !file.draft)
        .map((file) => withFileUrls(req, file))
    })),
    deletedSessionIds: []
  };
}

function presentSessionIndex(state: StoredSessionState) {
  const compacted = compactEmptyStoredSessions(
    state.sessions,
    state.activeSessionId
  );

  return {
    activeSessionId: compacted.activeSessionId,
    sessions: compacted.sessions.map((session) => ({
      id: session.id,
      title: session.title || "New Session",
      updatedAt: session.updatedAt
    }))
  };
}

function stateEtag(kind: "sessions" | "session-index", version: number): string {
  return `"chathtml-${kind}-${version}"`;
}

function requestHasEtag(req: Request, etag: string): boolean {
  return (req.get("if-none-match") ?? "")
    .split(",")
    .some((candidate) => {
      const normalized = candidate.trim();
      return normalized === etag || normalized === `W/${etag}`;
    });
}

function setPrivateStateCacheHeaders(res: Response, etag: string): void {
  res.setHeader("Cache-Control", "private, no-cache");
  res.setHeader("Vary", "Cookie");
  res.setHeader("ETag", etag);
}

async function sendVersionedState(
  req: Request,
  res: Response,
  kind: "sessions" | "session-index"
): Promise<void> {
  const stateKey = getRequestStateKey(req);
  const knownVersion = await readSessionStateVersion(stateKey);
  if (knownVersion !== null) {
    const knownEtag = stateEtag(kind, knownVersion);
    if (requestHasEtag(req, knownEtag)) {
      setPrivateStateCacheHeaders(res, knownEtag);
      res.status(304).end();
      return;
    }
  }

  const snapshot = await readSessionStateSnapshot(stateKey);
  setPrivateStateCacheHeaders(res, stateEtag(kind, snapshot.version));
  res.json(
    kind === "sessions"
      ? presentState(req, snapshot.state)
      : presentSessionIndex(snapshot.state)
  );
}

export async function deleteEphemeralSessionFiles({
  stateKey = DEFAULT_SESSION_STATE_KEY,
  sessionId,
  expectedFiles
}: {
  stateKey?: string;
  sessionId: string;
  expectedFiles: readonly EphemeralSessionFileIdentity[];
}): Promise<number> {
  if (!sessionId || !expectedFiles.length) {
    return 0;
  }

  let removedCount = 0;
  await enqueueSessionRepositoryOperation(stateKey, () =>
    runSessionFileDeletionTransaction({
      prepare: async () => {
        const state = await readSessionState(stateKey);
        const result = removeOwnedEphemeralFilesFromSession(
          state.sessions,
          sessionId,
          expectedFiles
        );
        return {
          storageKeys: result.removedStorageKeys,
          persistMetadata: async () => {
            if (!result.removedStorageKeys.length) {
              return;
            }
            state.sessions = result.sessions;
            await writeSessionState(state, stateKey);
            removedCount = result.removedStorageKeys.length;
          }
        };
      },
      deleteBlob: deleteStoredFile
    })
  );
  return removedCount;
}

export async function upsertSessionMessages({
  stateKey = DEFAULT_SESSION_STATE_KEY,
  sessionId,
  messages,
  files
}: {
  stateKey?: string;
  sessionId: string;
  messages: SessionMessageInput[];
  files?: StoredSessionFile[];
}): Promise<void> {
  await enqueueSessionStateUpdate(stateKey, (state) => {
    if (isStoredSessionDeleted(state, sessionId)) {
      return;
    }
    const session = ensureStoredSession(state, sessionId);
    upsertStoredMessages(session, messages);
    if (files?.length) {
      session.files = mergeStoredSessionFiles(session.files, files);
    }
    session.updatedAt = sessionStateNow();
  });
}

export async function patchSessionMessage({
  stateKey = DEFAULT_SESSION_STATE_KEY,
  sessionId,
  messageId,
  patch
}: {
  stateKey?: string;
  sessionId: string;
  messageId: string;
  patch: SessionMessagePatch;
}): Promise<void> {
  await enqueueSessionStateUpdate(stateKey, (state) => {
    if (isStoredSessionDeleted(state, sessionId)) {
      return;
    }
    const session = findStoredSession(state, sessionId);
    if (!session) {
      return;
    }

    const index = session.messages.findIndex((message) => message.id === messageId);
    if (index < 0) {
      return;
    }

    session.messages[index] = mergeStoredMessage(session.messages[index], patch);
    session.updatedAt = sessionStateNow();
  });
}

export async function updateSessionMessageAtomically({
  stateKey = DEFAULT_SESSION_STATE_KEY,
  sessionId,
  messageId,
  update
}: {
  stateKey?: string;
  sessionId: string;
  messageId: string;
  update: (
    message: Readonly<SessionMessageSnapshot>
  ) => SessionMessagePatch | undefined;
}): Promise<boolean> {
  let didUpdate = false;
  await enqueueSessionStateUpdate(stateKey, (state) => {
    if (isStoredSessionDeleted(state, sessionId)) {
      return;
    }
    const session = findStoredSession(state, sessionId);
    if (!session) {
      return;
    }

    const index = session.messages.findIndex((message) => message.id === messageId);
    if (index < 0) {
      return;
    }

    const patch = update(session.messages[index]);
    if (!patch) {
      return;
    }

    session.messages[index] = mergeStoredMessage(session.messages[index], patch);
    session.updatedAt = sessionStateNow();
    didUpdate = true;
  });
  return didUpdate;
}

function findFileById(
  state: StoredSessionState,
  fileId: string
): { session: StoredSession; file: StoredSessionFile } | null {
  for (const session of state.sessions) {
    const file = (session.files ?? []).find((candidate) => candidate.id === fileId);
    if (file) {
      return { session, file };
    }
  }

  return null;
}

function getUploadKind(value: unknown): StoredFileKind | null {
  return value === "image" || value === "artifact" || value === "text"
    ? value
    : null;
}

function decodeDataUrl(dataUrl: string): { mimeType: string; buffer: Buffer } {
  const match = /^data:([^;,]+);base64,([a-z0-9+/=\s]+)$/i.exec(dataUrl.trim());
  if (!match) {
    throw new Error("Invalid data URL.");
  }

  return {
    mimeType: match[1].toLowerCase(),
    buffer: Buffer.from(match[2].replace(/\s+/g, ""), "base64")
  };
}

async function getFileBuffer(file: StoredSessionFile): Promise<{
  buffer: Buffer;
  mimeType: string;
}> {
  if (file.storageKey) {
    return readStoredFile(file.storageKey, file.mimeType);
  }

  if (file.dataUrl) {
    return decodeDataUrl(file.dataUrl);
  }

  if (file.text) {
    return {
      buffer: Buffer.from(file.text, "utf8"),
      mimeType: file.mimeType || "text/plain"
    };
  }

  throw new Error("File content is unavailable.");
}

function filenameHeader(name: string): string {
  return `filename="${name.replace(/["\\]/g, "_")}"`;
}

export async function handleGetSessions(
  req: Request,
  res: Response
): Promise<void> {
  try {
    await sendVersionedState(req, res, "sessions");
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

export async function handleGetSessionIndex(
  req: Request,
  res: Response
): Promise<void> {
  try {
    await sendVersionedState(req, res, "session-index");
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

export async function handleExportAccountData(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const state = await readSessionState(getRequestStateKey(req));
    const sessions = await Promise.all(
      state.sessions.map(async (session) => ({
        ...session,
        files: await Promise.all(
          (session.files ?? [])
            .filter((file) => !file.draft)
            .map(async (file) => {
              const { buffer, mimeType } = await getFileBuffer(file);
              return {
                ...file,
                accessToken: undefined,
                embedUrl: undefined,
                downloadUrl: undefined,
                exportedContent: {
                  encoding: "base64",
                  mimeType,
                  data: buffer.toString("base64")
                }
              };
            })
        )
      }))
    );
    res
      .status(200)
      .set({
        "Cache-Control": "private, no-store",
        "Content-Disposition": 'attachment; filename="chathtml-account-export.json"',
        "Content-Type": "application/json; charset=utf-8"
      })
      .send(
        JSON.stringify({
          format: "chathtml-account-export",
          version: 1,
          exportedAt: new Date().toISOString(),
          state: { ...state, sessions }
        })
      );
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

export async function handleAdminGetAllSessions(
  req: Request,
  res: Response
): Promise<void> {
  const user = getAuthenticatedServiceUser(req);
  if (user?.role !== "admin") {
    res.status(403).json({ error: "Administrator access is required." });
    return;
  }

  try {
    const entries = await readAllSessionStateEntries();
    const accounts = entries
      .filter((entry) => entry.stateKey.startsWith("user:"))
      .map((entry) => ({
        accountId: entry.stateKey.slice("user:".length),
        updatedAt: entry.version,
        ...presentState(req, entry.state)
      }))
      .sort((left, right) => left.accountId.localeCompare(right.accountId));
    res.setHeader("Cache-Control", "private, no-store");
    res.json({ accounts });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

export async function deleteAccountSessionData(req: Request): Promise<void> {
  const stateKey = getRequestStateKey(req);
  await enqueueSessionRepositoryOperation(stateKey, async () => {
    const state = await readSessionState(stateKey);
    const storageKeys = Array.from(
      new Set(
        state.sessions.flatMap((session) =>
          (session.files ?? [])
            .map((file) => file.storageKey)
            .filter((key): key is string => Boolean(key))
        )
      )
    );
    await Promise.all(storageKeys.map((key) => deleteStoredFile(key)));
    await deleteSessionState(stateKey);
  });
}

export async function handleSaveSessions(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const stateKey = getRequestStateKey(req);
    const clientId = getRequestClientId(req);
    const body =
      req.body && typeof req.body === "object"
        ? (req.body as {
            deletedSessionIds?: unknown;
            saveRevision?: unknown;
          })
        : {};
    const state = normalizeStoredSessionState(req.body);
    const deletedSessionIds = normalizeDeletedSessionIds(
      body.deletedSessionIds
    );
    let applied = true;
    let saveRevision: number | undefined;
    let currentSaveRevision: number | undefined;
    await enqueueSessionRepositoryOperation(stateKey, () => {
      const sessionIdsByStorageKey = new Map<string, Set<string>>();
      return runSessionFileDeletionTransaction({
        prepare: async () => {
          const current = await readSessionState(stateKey);
          const resolution = resolveClientSessionSave({
            current,
            incoming: state,
            deletedSessionIds,
            clientId,
            saveRevision: body.saveRevision
          });
          applied = resolution.applied;
          saveRevision = resolution.saveRevision;
          currentSaveRevision = resolution.currentSaveRevision;
          if (!resolution.applied) {
            return {
              storageKeys: [],
              persistMetadata: () => undefined
            };
          }

          const merged = resolution.state;
          assertAccountQuota(merged);
          const tombstones = new Set(merged.deletedSessionIds ?? []);
          for (const session of current.sessions) {
            if (!tombstones.has(session.id)) {
              continue;
            }
            for (const file of session.files ?? []) {
              if (!file.storageKey) {
                continue;
              }
              const owners =
                sessionIdsByStorageKey.get(file.storageKey) ?? new Set<string>();
              owners.add(session.id);
              sessionIdsByStorageKey.set(file.storageKey, owners);
            }
          }
          return {
            storageKeys: selectTombstonedSessionStorageKeys(
              current.sessions,
              merged.deletedSessionIds ?? []
            ),
            persistMetadata: () => writeSessionState(merged, stateKey)
          };
        },
        acquireDeletion: (storageKeys) =>
          activeEphemeralFileRegistry.acquireDeletion(
            storageKeys.flatMap((storageKey) =>
              Array.from(sessionIdsByStorageKey.get(storageKey) ?? []).map(
                (sessionId) => ({ stateKey, sessionId, storageKey })
              )
            )
          ),
        deleteBlob: deleteStoredFile
      });
    });
    res.json(
      saveRevision === undefined
        ? { ok: true }
        : {
            ok: true,
            applied,
            saveRevision,
            ...(currentSaveRevision === undefined
              ? {}
              : { currentSaveRevision })
          }
    );
  } catch (error) {
    res
      .status(
        error instanceof ActiveEphemeralFileDeletionError
          ? 409
          : error instanceof AccountQuotaError
            ? 413
            : 500
      )
      .json({
        error: error instanceof Error ? error.message : String(error)
      });
  }
}

export async function handleGetSessionFiles(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const state = await readSessionState(getRequestStateKey(req));
    const session = findStoredSession(state, req.params.sessionId);
    if (!session) {
      res.status(404).json({ error: "Session not found." });
      return;
    }

    res.json({
      files: (session.files ?? [])
        .filter((file) => !file.draft)
        .map((file) => withFileUrls(req, file))
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

export async function handleCreateSessionFile(
  req: Request,
  res: Response
): Promise<void> {
  const sessionId = req.params.sessionId;
  const stateKey = getRequestStateKey(req);
  const body = req.body as Record<string, unknown>;
  const kind = getUploadKind(body.kind);

  if (!kind) {
    res.status(400).json({ error: "File kind must be image, artifact, or text." });
    return;
  }

  try {
    const fileId = createStoredFileId(kind);
    const name = stringValue(body.name, `${kind}-${fileId}`).slice(0, 180);
    const input = {
      kind,
      sessionId,
      name,
      mimeType: stringValue(
        body.mimeType,
        kind === "image" ? "image/png" : kind === "artifact" ? "text/html" : "text/plain"
      ),
      dataUrl: stringValue(body.dataUrl) || undefined,
      text: stringValue(body.text) || undefined
    };
    const requestedBytes = input.dataUrl
      ? decodeDataUrl(input.dataUrl).buffer.byteLength
      : Buffer.byteLength(input.text ?? "", "utf8");
    const file = await runSessionFileUploadTransaction({
      assertUploadAllowed: () =>
        enqueueSessionStateInspection(stateKey, (state) => {
          assertSessionFileUploadAllowed(state, sessionId);
          assertAccountQuota(state, requestedBytes, 1);
        }),
      storeBlob: () => putStoredFile(fileId, input),
      createFile: (stored): StoredSessionFile => ({
        id: fileId,
        kind,
        name,
        mimeType: stored.mimeType,
        size: stored.size,
        createdAt: sessionStateNow(),
        sourceMessageId: stringValue(body.sourceMessageId) || undefined,
        storageKey: stored.storageKey,
        contentHash: stored.contentHash,
        accessToken: createFileAccessToken(),
        draft: Boolean(body.draft),
        width:
          typeof body.width === "number" && Number.isFinite(body.width)
            ? Math.max(1, Math.round(body.width))
            : undefined,
        height:
          typeof body.height === "number" && Number.isFinite(body.height)
            ? Math.max(1, Math.round(body.height))
            : undefined,
        summary: stringValue(body.summary).slice(0, 1_200) || undefined
      }),
      persistMetadata: (uploadedFile) =>
        enqueueSessionStateUpdate(stateKey, (state) => {
          applyUploadedSessionFileMetadata(
            state,
            sessionId,
            uploadedFile,
            sessionStateNow()
          );
        }),
      rollbackBlob: (stored) => deleteStoredFile(stored.storageKey)
    });

    res.json({ file: withFileUrls(req, file) });
  } catch (error) {
    res.status(
      error instanceof TombstonedSessionUploadError
        ? 409
        : error instanceof AccountQuotaError
          ? 413
          : 400
    ).json({
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

export type SessionFileContentHandlerDependencies = {
  findCapability?(
    fileId: string,
    accessToken: string
  ): Promise<{ stateKey?: string; file: StoredSessionFile } | null>;
  readStates?(): Promise<StoredSessionState[]>;
  readFile(file: StoredSessionFile): Promise<{
    buffer: Buffer;
    mimeType: string;
  }>;
};

export function createSessionFileContentHandler(
  dependencies: SessionFileContentHandlerDependencies = {
    findCapability: findStoredFileCapability,
    readFile: getFileBuffer
  }
): (req: Request, res: Response) => Promise<void> {
  return async (req, res) => {
    try {
      const token = stringValue(req.query.token);
      const found = dependencies.findCapability
        ? await dependencies.findCapability(req.params.fileId, token)
        : (await dependencies.readStates?.())
            ?.map((state) => findFileById(state, req.params.fileId))
            .find(
              (
                candidate
              ): candidate is {
                session: StoredSession;
                file: StoredSessionFile;
              } => Boolean(candidate)
            );
      if (
        !found ||
        !found.file.accessToken ||
        token !== found.file.accessToken ||
        ("stateKey" in found &&
          found.stateKey !== undefined &&
          found.stateKey !== getRequestStateKey(req))
      ) {
        res.status(404).send("File not found.");
        return;
      }

      const { buffer, mimeType } = await dependencies.readFile(found.file);
      const policy = getSessionFileResponsePolicy(found.file.kind, mimeType);
      const disposition = req.query.download
        ? "attachment"
        : policy.disposition;
      res.status(200).type(policy.contentType).set({
        "Cache-Control": "private, no-store",
        "Content-Disposition": `${disposition}; ${filenameHeader(found.file.name)}`,
        "Content-Length": String(buffer.byteLength),
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cross-Origin-Resource-Policy": policy.crossOriginResourcePolicy,
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff"
      });
      if (policy.allowCrossOriginRead) {
        res.setHeader("Access-Control-Allow-Origin", "*");
      }
      res.send(buffer);
    } catch (error) {
      res.status(500).send(error instanceof Error ? error.message : String(error));
    }
  };
}

export const handleGetFileContent = createSessionFileContentHandler();

export async function handleDeleteSessionFile(
  req: Request,
  res: Response
): Promise<void> {
  const sessionId = req.params.sessionId;
  const fileId = req.params.fileId;
  const stateKey = getRequestStateKey(req);

  try {
    await enqueueSessionRepositoryOperation(stateKey, () =>
      runSessionFileDeletionTransaction({
        prepare: async () => {
          const state = await readSessionState(stateKey);
          const session = findStoredSession(state, sessionId);
          const removed = (session?.files ?? []).find(
            (file) => file.id === fileId
          );
          return {
            storageKeys: removed?.storageKey ? [removed.storageKey] : [],
            persistMetadata: async () => {
              if (!session || !removed) {
                return;
              }
              session.files = (session.files ?? []).filter(
                (file) => file.id !== fileId
              );
              session.updatedAt = sessionStateNow();
              await writeSessionState(state, stateKey);
            }
          };
        },
        acquireDeletion: (storageKeys) =>
          activeEphemeralFileRegistry.acquireDeletion(
            storageKeys.map((storageKey) => ({
              stateKey,
              sessionId,
              storageKey
            }))
          ),
        deleteBlob: deleteStoredFile
      })
    );

    res.json({ ok: true });
  } catch (error) {
    res
      .status(error instanceof ActiveEphemeralFileDeletionError ? 409 : 500)
      .json({
        error: error instanceof Error ? error.message : String(error)
      });
  }
}
