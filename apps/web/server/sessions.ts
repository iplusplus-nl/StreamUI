import type { Request, Response } from "express";
import "./env.js";
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Database as SqliteDatabase } from "sqlite";
import {
  createFileAccessToken,
  createStoredFileId,
  deleteStoredFile,
  putStoredFile,
  readStoredFile,
  type StoredFileKind
} from "./fileStore.js";
import {
  TombstonedSessionUploadError,
  applyUploadedSessionFileMetadata,
  assertSessionFileUploadAllowed,
  mergeSessionFilesForClientSave,
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

type StoredMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  attachments?: unknown[];
  fileIds?: unknown[];
  reasoning?: string;
  sessionTitle?: string;
  rawStream?: string;
  hasStreamUi?: boolean;
  streamUiComplete?: boolean;
  artifactContext?: unknown;
  runtimeErrors?: unknown[];
  repairOfMessageId?: string;
  repairAttempt?: number;
  branchGroupId?: string;
  branchVariantId?: string;
  branchAnchor?: boolean;
  artifactEditBaseRawStream?: string;
  artifactEdits?: unknown[];
  activeArtifactEditId?: string;
  generationRunId?: string;
  streamSequence?: number;
  status?: "streaming" | "complete" | "error";
  error?: string;
};

export type StoredSessionFile = {
  id: string;
  kind: "image" | "artifact" | "text";
  name: string;
  mimeType: string;
  size: number;
  createdAt: number;
  sourceMessageId?: string;
  storageKey?: string;
  contentHash?: string;
  accessToken?: string;
  embedUrl?: string;
  downloadUrl?: string;
  draft?: boolean;
  dataUrl?: string;
  text?: string;
  width?: number;
  height?: number;
  summary?: string;
};

type StoredBugReportImage = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  dataUrl: string;
  width?: number;
  height?: number;
  captured?: boolean;
  createdAt: number;
};

type StoredBugReportDraft = {
  text: string;
  images: StoredBugReportImage[];
  updatedAt: number;
  screenshotCapturedAt?: number;
};

type StoredSession = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  model?: string;
  branchSelections?: Record<string, string>;
  messages: StoredMessage[];
  files?: StoredSessionFile[];
  bugReportDraft?: StoredBugReportDraft;
};

type StoredSessionState = {
  sessions: StoredSession[];
  activeSessionId: string;
  deletedSessionIds?: string[];
};

export type SessionMessageInput = {
  id: string;
  role: "user" | "assistant";
  content?: string;
  fileIds?: string[];
  reasoning?: string;
  sessionTitle?: string;
  rawStream?: string;
  hasStreamUi?: boolean;
  streamUiComplete?: boolean;
  artifactContext?: unknown;
  runtimeErrors?: unknown[];
  repairOfMessageId?: string;
  repairAttempt?: number;
  branchGroupId?: string;
  branchVariantId?: string;
  branchAnchor?: boolean;
  artifactEditBaseRawStream?: string;
  artifactEdits?: unknown[];
  activeArtifactEditId?: string;
  generationRunId?: string;
  streamSequence?: number;
  status?: "streaming" | "complete" | "error";
  error?: string;
};

export type SessionMessagePatch = Partial<Omit<SessionMessageInput, "id" | "role">>;
export type SessionMessageSnapshot = Omit<SessionMessageInput, "fileIds"> & {
  fileIds?: unknown[];
};

const SESSION_MESSAGE_PATCH_KEYS: Array<keyof SessionMessagePatch> = [
  "content",
  "fileIds",
  "reasoning",
  "sessionTitle",
  "rawStream",
  "hasStreamUi",
  "streamUiComplete",
  "artifactContext",
  "runtimeErrors",
  "repairOfMessageId",
  "repairAttempt",
  "branchGroupId",
  "branchVariantId",
  "branchAnchor",
  "artifactEditBaseRawStream",
  "artifactEdits",
  "activeArtifactEditId",
  "generationRunId",
  "streamSequence",
  "status",
  "error"
];

export function selectPresentSessionMessagePatch(
  input: SessionMessageInput,
  normalized: SessionMessageSnapshot
): SessionMessagePatch {
  const patch: SessionMessagePatch = {};
  for (const key of SESSION_MESSAGE_PATCH_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) {
      continue;
    }
    Object.assign(patch, { [key]: normalized[key] });
  }
  return patch;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const workspaceRoot = path.resolve(projectRoot, "../..");
const sessionsDir = path.resolve(
  process.env.STREAMUI_SESSION_DIR || path.join(workspaceRoot, "sessions")
);
const stateFile = path.join(sessionsDir, "state.json");
const sqliteFile = path.resolve(
  process.env.STREAMUI_SESSION_DB ||
    process.env.STREAMUI_SQLITE_PATH ||
    path.join(sessionsDir, "state.sqlite")
);
const DEFAULT_SESSION_STATE_KEY = "global";
const SESSION_CLIENT_ID_HEADER = "x-chathtml-client-id";
const LEGACY_SESSION_CLIENT_ID_HEADER = "x-streamui-client-id";
const STREAM_INTERRUPTED_ERROR =
  "The stream was interrupted before it completed.";
const MAX_DELETED_SESSION_TOMBSTONES = 5000;
const MAX_BUG_REPORT_IMAGES = 8;
const MAX_BUG_REPORT_TEXT_LENGTH = 12_000;
const MAX_BUG_REPORT_IMAGE_DATA_URL_CHARS = 20_000_000;
const BUG_REPORT_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif"
]);

let saveQueue = Promise.resolve();
let database: SqliteDatabase | null = null;

function now(): number {
  return Date.now();
}

function createId(prefix: string): string {
  return `${prefix}-${now()}-${randomUUID().slice(0, 8)}`;
}

function createEmptyState(deletedSessionIds: string[] = []): StoredSessionState {
  const timestamp = now();
  const session: StoredSession = {
    id: createId("session"),
    title: "New Session",
    createdAt: timestamp,
    updatedAt: timestamp,
    messages: [],
    files: []
  };

  return {
    sessions: [session],
    activeSessionId: session.id,
    deletedSessionIds
  };
}

function finiteTimestamp(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function normalizeClientId(input: unknown): string {
  const value = stringValue(input)
    .trim()
    .slice(0, 160)
    .replace(/[^a-z0-9._:-]/gi, "");
  return value.length >= 8 ? value : "";
}

export function getSessionStateKeyFromClientId(_input: unknown): string {
  return DEFAULT_SESSION_STATE_KEY;
}

function getRequestClientId(req: Request): string {
  const headerId = normalizeClientId(
    req.get(SESSION_CLIENT_ID_HEADER) ?? req.get(LEGACY_SESSION_CLIENT_ID_HEADER)
  );
  if (headerId) {
    return headerId;
  }

  const queryId = normalizeClientId(req.query.clientId);
  if (queryId) {
    return queryId;
  }

  const body =
    req.body && typeof req.body === "object"
      ? (req.body as { clientId?: unknown })
      : {};
  return normalizeClientId(body.clientId);
}

function getRequestStateKey(req: Request): string {
  getRequestClientId(req);
  return DEFAULT_SESSION_STATE_KEY;
}

function normalizeStringArray(input: unknown): string[] | undefined {
  if (!Array.isArray(input)) {
    return undefined;
  }

  const seen = new Set<string>();
  const values: string[] = [];
  for (const item of input) {
    const value = stringValue(item).trim();
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    values.push(value);
  }

  return values.length ? values : undefined;
}

function normalizeArtifactEdits(input: unknown): unknown[] | undefined {
  if (!Array.isArray(input)) {
    return undefined;
  }

  const edits = input.filter(
    (item) => item && typeof item === "object" && !Array.isArray(item)
  );
  return edits.length ? edits : undefined;
}

function normalizeBranchSelections(input: unknown): Record<string, string> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }

  const selections: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(input)) {
    const key = rawKey.trim().slice(0, 160);
    const value = typeof rawValue === "string" ? rawValue.trim().slice(0, 160) : "";
    if (key && value) {
      selections[key] = value;
    }
  }

  return Object.keys(selections).length ? selections : undefined;
}

function normalizeBugReportImage(input: unknown): StoredBugReportImage | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  const image = input as Partial<StoredBugReportImage>;
  const id = stringValue(image.id).trim();
  const name = stringValue(image.name).trim();
  const mimeType = stringValue(image.mimeType).trim().toLowerCase();
  const dataUrl = stringValue(image.dataUrl).trim();

  if (
    !id ||
    !name ||
    !BUG_REPORT_IMAGE_MIME_TYPES.has(mimeType) ||
    !dataUrl.startsWith(`data:${mimeType};base64,`) ||
    dataUrl.length > MAX_BUG_REPORT_IMAGE_DATA_URL_CHARS
  ) {
    return null;
  }

  return {
    id: id.slice(0, 160),
    name: name.slice(0, 180),
    mimeType,
    size:
      typeof image.size === "number" && Number.isFinite(image.size)
        ? Math.max(0, Math.round(image.size))
        : 0,
    dataUrl,
    width:
      typeof image.width === "number" && Number.isFinite(image.width)
        ? Math.max(1, Math.round(image.width))
        : undefined,
    height:
      typeof image.height === "number" && Number.isFinite(image.height)
        ? Math.max(1, Math.round(image.height))
        : undefined,
    captured: image.captured ? true : undefined,
    createdAt: finiteTimestamp(image.createdAt, now())
  };
}

function normalizeBugReportDraft(
  input: unknown
): StoredBugReportDraft | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }

  const draft = input as Partial<StoredBugReportDraft>;
  const seen = new Set<string>();
  const images: StoredBugReportImage[] = [];
  if (Array.isArray(draft.images)) {
    for (const item of draft.images) {
      const image = normalizeBugReportImage(item);
      if (!image || seen.has(image.id)) {
        continue;
      }
      seen.add(image.id);
      images.push(image);
      if (images.length >= MAX_BUG_REPORT_IMAGES) {
        break;
      }
    }
  }

  const text = stringValue(draft.text).slice(0, MAX_BUG_REPORT_TEXT_LENGTH);
  const screenshotCapturedAt =
    typeof draft.screenshotCapturedAt === "number" &&
    Number.isFinite(draft.screenshotCapturedAt)
      ? draft.screenshotCapturedAt
      : undefined;

  if (!text.trim() && images.length === 0 && !screenshotCapturedAt) {
    return undefined;
  }

  return {
    text,
    images,
    updatedAt: finiteTimestamp(draft.updatedAt, now()),
    screenshotCapturedAt
  };
}

function normalizeDeletedSessionIdList(input: unknown): string[] {
  const ids = normalizeStringArray(input);
  return (ids ?? []).slice(-MAX_DELETED_SESSION_TOMBSTONES);
}

function normalizeDeletedSessionIds(input: unknown): Set<string> {
  return new Set(normalizeDeletedSessionIdList(input));
}

function mergeDeletedSessionIdLists(...inputs: Array<unknown>): string[] {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const input of inputs) {
    for (const id of normalizeDeletedSessionIdList(input)) {
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      values.push(id);
    }
  }

  return values.slice(-MAX_DELETED_SESSION_TOMBSTONES);
}

function normalizeSessionFile(input: unknown): StoredSessionFile | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  const file = input as Partial<StoredSessionFile>;
  const kind =
    file.kind === "image" || file.kind === "artifact" || file.kind === "text"
      ? file.kind
      : null;
  const id = stringValue(file.id).trim();
  const name = stringValue(file.name).trim();
  if (!kind || !id || !name) {
    return null;
  }

  const dataUrl = stringValue(file.dataUrl);
  const text = stringValue(file.text);
  const storageKey = stringValue(file.storageKey);
  const accessToken = stringValue(file.accessToken);
  if (kind === "image" && !dataUrl && !storageKey) {
    return null;
  }
  if ((kind === "artifact" || kind === "text") && !text && !storageKey) {
    return null;
  }

  return {
    id,
    kind,
    name: name.slice(0, 180),
    mimeType: stringValue(file.mimeType, kind === "image" ? "image/png" : "text/plain")
      .trim()
      .slice(0, 120),
    size:
      typeof file.size === "number" && Number.isFinite(file.size)
        ? Math.max(0, Math.round(file.size))
        : text.length,
    createdAt: finiteTimestamp(file.createdAt, now()),
    sourceMessageId: stringValue(file.sourceMessageId) || undefined,
    storageKey: storageKey || undefined,
    contentHash: stringValue(file.contentHash) || undefined,
    accessToken: accessToken || undefined,
    embedUrl: stringValue(file.embedUrl) || undefined,
    downloadUrl: stringValue(file.downloadUrl) || undefined,
    draft: Boolean(file.draft),
    dataUrl: dataUrl || undefined,
    text: text || undefined,
    width:
      typeof file.width === "number" && Number.isFinite(file.width)
        ? Math.max(1, Math.round(file.width))
        : undefined,
    height:
      typeof file.height === "number" && Number.isFinite(file.height)
        ? Math.max(1, Math.round(file.height))
        : undefined,
    summary: stringValue(file.summary).slice(0, 1_200) || undefined
  };
}

function normalizeSessionFiles(input: unknown): StoredSessionFile[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const seen = new Set<string>();
  const files: StoredSessionFile[] = [];
  for (const item of input) {
    const file = normalizeSessionFile(item);
    if (!file || seen.has(file.id)) {
      continue;
    }
    seen.add(file.id);
    files.push(file);
  }

  return files;
}

function normalizeMessage(input: unknown): StoredMessage | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  const message = input as Partial<StoredMessage>;
  if (
    typeof message.id !== "string" ||
    (message.role !== "user" && message.role !== "assistant")
  ) {
    return null;
  }

  const status =
    message.role === "assistant"
      ? message.status === "streaming" ||
        message.status === "complete" ||
        message.status === "error"
        ? message.status
        : "complete"
      : undefined;

  return {
    id: message.id,
    role: message.role,
    content: stringValue(message.content),
    attachments: Array.isArray(message.attachments)
      ? message.attachments
      : undefined,
    fileIds: normalizeStringArray(message.fileIds),
    reasoning: stringValue(message.reasoning) || undefined,
    sessionTitle: stringValue(message.sessionTitle) || undefined,
    rawStream: stringValue(message.rawStream) || undefined,
    hasStreamUi: Boolean(message.hasStreamUi),
    streamUiComplete: Boolean(message.streamUiComplete),
    artifactContext:
      message.artifactContext && typeof message.artifactContext === "object"
        ? message.artifactContext
        : undefined,
    runtimeErrors: Array.isArray(message.runtimeErrors)
      ? message.runtimeErrors
      : undefined,
    repairOfMessageId: stringValue(message.repairOfMessageId) || undefined,
    repairAttempt:
      typeof message.repairAttempt === "number" &&
      Number.isFinite(message.repairAttempt)
        ? Math.max(1, Math.round(message.repairAttempt))
        : undefined,
    branchGroupId: stringValue(message.branchGroupId) || undefined,
    branchVariantId: stringValue(message.branchVariantId) || undefined,
    branchAnchor: message.branchAnchor ? true : undefined,
    artifactEditBaseRawStream:
      typeof message.artifactEditBaseRawStream === "string"
        ? message.artifactEditBaseRawStream
        : undefined,
    artifactEdits: normalizeArtifactEdits(message.artifactEdits),
    activeArtifactEditId: stringValue(message.activeArtifactEditId) || undefined,
    generationRunId: stringValue(message.generationRunId) || undefined,
    streamSequence:
      typeof message.streamSequence === "number" &&
      Number.isFinite(message.streamSequence)
        ? Math.max(0, Math.round(message.streamSequence))
        : undefined,
    status,
    error: stringValue(message.error) || undefined
  };
}

function normalizeSession(input: unknown): StoredSession | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  const session = input as Partial<StoredSession>;
  if (typeof session.id !== "string") {
    return null;
  }

  const timestamp = now();
  const createdAt = finiteTimestamp(session.createdAt, timestamp);
  const updatedAt = finiteTimestamp(session.updatedAt, createdAt);
  const messages = Array.isArray(session.messages)
    ? session.messages
        .map(normalizeMessage)
        .filter((message): message is StoredMessage => message !== null)
    : [];

  return {
    id: session.id,
    title: stringValue(session.title, "New Session").trim() || "New Session",
    createdAt,
    updatedAt,
    model: stringValue(session.model).trim().slice(0, 180) || undefined,
    branchSelections: normalizeBranchSelections(session.branchSelections),
    messages,
    files: normalizeSessionFiles(session.files),
    bugReportDraft: normalizeBugReportDraft(session.bugReportDraft)
  };
}

function hasCommittedSessionFiles(session: StoredSession): boolean {
  return Boolean((session.files ?? []).some((file) => !file.draft));
}

function hasDraftSessionFiles(session: StoredSession): boolean {
  return Boolean((session.files ?? []).some((file) => file.draft));
}

function isStoredSessionEmpty(session: StoredSession): boolean {
  return (
    session.messages.length === 0 &&
    !hasCommittedSessionFiles(session) &&
    !session.bugReportDraft?.text.trim() &&
    !(session.bugReportDraft?.images.length)
  );
}

function compactEmptyStoredSessions(
  sessions: StoredSession[],
  activeSessionId: string
): { sessions: StoredSession[]; activeSessionId: string } {
  const nonEmptySessions = sessions.filter(
    (session) => !isStoredSessionEmpty(session)
  );
  const compactedSessions = nonEmptySessions.length
    ? nonEmptySessions
    : sessions.slice(0, 1);
  const compactedActiveSessionId = compactedSessions.some(
    (session) => session.id === activeSessionId
  )
    ? activeSessionId
    : compactedSessions[0]?.id ?? activeSessionId;

  return {
    sessions: compactedSessions,
    activeSessionId: compactedActiveSessionId
  };
}

function normalizeState(input: unknown): StoredSessionState {
  if (!input || typeof input !== "object") {
    return createEmptyState();
  }

  const state = input as Partial<StoredSessionState>;
  const deletedSessionIds = normalizeDeletedSessionIdList(
    state.deletedSessionIds
  );
  const deletedSessionIdSet = new Set(deletedSessionIds);
  const sessions = Array.isArray(state.sessions)
    ? state.sessions
        .map(normalizeSession)
        .filter((session): session is StoredSession => session !== null)
        .filter((session) => !deletedSessionIdSet.has(session.id))
        .sort((a, b) => b.updatedAt - a.updatedAt)
    : [];

  if (!sessions.length) {
    return createEmptyState(deletedSessionIds);
  }

  const requestedActiveId =
    typeof state.activeSessionId === "string" ? state.activeSessionId : "";
  const activeSessionId = sessions.some(
    (session) => session.id === requestedActiveId
  )
    ? requestedActiveId
    : sessions[0].id;

  return {
    sessions,
    activeSessionId,
    deletedSessionIds
  };
}

async function ensureSessionsDir(): Promise<void> {
  await mkdir(path.dirname(sqliteFile), { recursive: true, mode: 0o700 });
}

async function readLegacyJsonState(): Promise<StoredSessionState | null> {
  try {
    const raw = await readFile(stateFile, "utf8");
    return normalizeState(JSON.parse(raw));
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code !== "ENOENT") {
      console.warn("Could not read ChatHTML sessions.", error);
    }

    return null;
  }
}

async function getDatabase(): Promise<SqliteDatabase> {
  if (database) {
    return database;
  }

  const [{ open }, sqlite3] = await Promise.all([
    import("sqlite"),
    import("sqlite3")
  ]);
  const driver = sqlite3.default?.Database ?? sqlite3.Database;

  database = await open({
    filename: sqliteFile,
    driver
  });
  await database.exec("PRAGMA busy_timeout = 5000");
  await database.exec("PRAGMA journal_mode = WAL");
  await database.exec("PRAGMA synchronous = NORMAL");
  await database.exec(`
    CREATE TABLE IF NOT EXISTS streamui_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  return database;
}

async function readSqliteState(
  db: SqliteDatabase,
  stateKey: string
): Promise<StoredSessionState | null> {
  const row = (await db.get(
    "SELECT value FROM streamui_state WHERE key = ?",
    stateKey
  )) as { value?: unknown } | undefined;

  if (typeof row?.value !== "string") {
    return null;
  }

  return normalizeState(JSON.parse(row.value));
}

async function writeSqliteState(
  db: SqliteDatabase,
  state: StoredSessionState,
  stateKey: string
): Promise<void> {
  const normalized = normalizeState(state);
  await db.run(
    `
      INSERT INTO streamui_state (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `,
    stateKey,
    JSON.stringify(normalized),
    now()
  );
}

async function readSessionState(
  stateKey = DEFAULT_SESSION_STATE_KEY
): Promise<StoredSessionState> {
  await ensureSessionsDir();
  const db = await getDatabase();

  try {
    const sqliteState = await readSqliteState(db, stateKey);
    if (sqliteState) {
      return sqliteState;
    }
  } catch (error) {
    console.warn("Could not read ChatHTML SQLite sessions.", error);
  }

  const legacyState =
    stateKey === DEFAULT_SESSION_STATE_KEY ? await readLegacyJsonState() : null;
  const state = legacyState ?? createEmptyState();
  await writeSqliteState(db, state, stateKey);
  return state;
}

async function writeSessionState(
  state: StoredSessionState,
  stateKey = DEFAULT_SESSION_STATE_KEY
): Promise<void> {
  await ensureSessionsDir();
  const db = await getDatabase();
  await writeSqliteState(db, state, stateKey);
}

async function readAllSessionStates(): Promise<StoredSessionState[]> {
  await ensureSessionsDir();
  const db = await getDatabase();
  const rows = (await db.all("SELECT value FROM streamui_state")) as Array<{
    value?: unknown;
  }>;
  const states: StoredSessionState[] = [];
  for (const row of rows) {
    if (typeof row.value !== "string") {
      continue;
    }
    try {
      states.push(normalizeState(JSON.parse(row.value)));
    } catch (error) {
      console.warn("Could not parse ChatHTML session row.", error);
    }
  }
  return states;
}

function getRequestOrigin(req: Request): string {
  const forwardedProto = stringValue(req.headers["x-forwarded-proto"])
    .split(",")[0]
    .trim();
  const forwardedHost = stringValue(req.headers["x-forwarded-host"])
    .split(",")[0]
    .trim();
  const protocol = forwardedProto || req.protocol || "http";
  const host = forwardedHost || req.get("host") || "127.0.0.1:8787";
  return `${protocol}://${host}`;
}

function withFileUrls(req: Request, file: StoredSessionFile): StoredSessionFile {
  if (!file.accessToken) {
    return file;
  }

  const origin = getRequestOrigin(req);
  const id = encodeURIComponent(file.id);
  const token = encodeURIComponent(file.accessToken);
  return {
    ...file,
    embedUrl: `${origin}/api/files/${id}/content?token=${token}`,
    downloadUrl: `${origin}/api/files/${id}/content?token=${token}&download=1`
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

function findSession(
  state: StoredSessionState,
  sessionId: string
): StoredSession | undefined {
  return state.sessions.find((session) => session.id === sessionId);
}

function ensureSession(
  state: StoredSessionState,
  sessionId: string
): StoredSession {
  const existing = findSession(state, sessionId);
  if (existing) {
    existing.files = existing.files ?? [];
    return existing;
  }

  const timestamp = now();
  const session: StoredSession = {
    id: sessionId,
    title: "New Session",
    createdAt: timestamp,
    updatedAt: timestamp,
    messages: [],
    files: []
  };
  state.sessions.unshift(session);
  state.activeSessionId = sessionId;
  return session;
}

function isSessionDeleted(state: StoredSessionState, sessionId: string): boolean {
  return Boolean(state.deletedSessionIds?.includes(sessionId));
}

function hasActiveRunMessage(session: StoredSession): boolean {
  return session.messages.some(
    (message) =>
      message.role === "assistant" &&
      message.status === "streaming" &&
      Boolean(message.generationRunId)
  );
}

function mergeSessionFiles(
  current: StoredSessionFile[] | undefined,
  incoming: StoredSessionFile[] | undefined
): StoredSessionFile[] {
  const files = new Map<string, StoredSessionFile>();
  for (const file of current ?? []) {
    files.set(file.id, file);
  }
  for (const file of incoming ?? []) {
    files.set(file.id, file);
  }
  return Array.from(files.values()).sort((a, b) => a.createdAt - b.createdAt);
}

function shouldPreserveCurrentRunMessage(
  current: StoredMessage | undefined,
  incoming: StoredMessage
): boolean {
  if (
    !current ||
    current.role !== "assistant" ||
    !current.generationRunId ||
    current.generationRunId !== incoming.generationRunId
  ) {
    return false;
  }

  const currentSequence = current.streamSequence ?? -1;
  const incomingSequence = incoming.streamSequence ?? -1;
  const incomingInterrupted =
    incoming.status === "error" && incoming.error === STREAM_INTERRUPTED_ERROR;

  if (currentSequence > incomingSequence) {
    return true;
  }

  if (current.status === "complete" && incoming.status !== "complete") {
    return true;
  }

  if (
    current.status === "streaming" &&
    incomingInterrupted &&
    currentSequence > incomingSequence
  ) {
    return true;
  }

  return false;
}

function artifactEditObjects(
  message: StoredMessage | undefined
): Record<string, unknown>[] {
  return (message?.artifactEdits ?? []).filter(
    (item): item is Record<string, unknown> =>
      Boolean(item) && typeof item === "object" && !Array.isArray(item)
  );
}

function artifactEditId(edit: Record<string, unknown>): string {
  return stringValue(edit.id).trim();
}

function artifactEditVariants(
  edit: Record<string, unknown> | undefined
): Record<string, unknown>[] {
  return (Array.isArray(edit?.variants) ? edit.variants : []).filter(
    (item): item is Record<string, unknown> =>
      Boolean(item) && typeof item === "object" && !Array.isArray(item)
  );
}

function hasCompletedArtifactEditVariant(
  edit: Record<string, unknown> | undefined
): boolean {
  return artifactEditVariants(edit).some(
    (variant) =>
      variant.status === "complete" &&
      typeof variant.rawStream === "string" &&
      Boolean(variant.rawStream.trim())
  );
}

function hasArtifactEditState(message: StoredMessage | undefined): boolean {
  return Boolean(
    message?.artifactEditBaseRawStream ||
      message?.activeArtifactEditId ||
      artifactEditObjects(message).length
  );
}

function shouldPreserveCurrentArtifactEditMessage(
  current: StoredMessage | undefined,
  incoming: StoredMessage
): boolean {
  if (!current || !hasArtifactEditState(current)) {
    return false;
  }

  if (!hasArtifactEditState(incoming)) {
    return true;
  }

  const currentEdits = artifactEditObjects(current);
  const incomingEdits = artifactEditObjects(incoming);
  const incomingById = new Map(
    incomingEdits.map((edit) => [artifactEditId(edit), edit])
  );

  if (currentEdits.length > incomingEdits.length) {
    return true;
  }

  for (const edit of currentEdits) {
    const id = artifactEditId(edit);
    const incomingEdit = incomingById.get(id);
    if (!id || !incomingEdit) {
      return true;
    }

    if (
      hasCompletedArtifactEditVariant(edit) &&
      !hasCompletedArtifactEditVariant(incomingEdit)
    ) {
      return true;
    }
  }

  const currentActiveId = stringValue(current.activeArtifactEditId).trim();
  const incomingActiveId = stringValue(incoming.activeArtifactEditId).trim();
  if (currentActiveId && currentActiveId !== incomingActiveId) {
    return true;
  }

  return false;
}

function mergeMessagesForClientSave(
  current: StoredMessage[],
  incoming: StoredMessage[],
  options: { preserveStaleArtifactEdits?: boolean } = {}
): StoredMessage[] {
  const currentById = new Map(current.map((message) => [message.id, message]));
  const incomingIds = new Set(incoming.map((message) => message.id));
  const missingActiveRun = current.some(
    (message) =>
      message.role === "assistant" &&
      message.status === "streaming" &&
      Boolean(message.generationRunId) &&
      !incomingIds.has(message.id)
  );

  if (missingActiveRun) {
    return current;
  }

  return incoming.map((message) => {
    const currentMessage = currentById.get(message.id);
    if (
      options.preserveStaleArtifactEdits &&
      shouldPreserveCurrentArtifactEditMessage(currentMessage, message)
    ) {
      return currentMessage ?? message;
    }

    return shouldPreserveCurrentRunMessage(currentMessage, message)
      ? currentMessage ?? message
      : message;
  });
}

function mergeBugReportDraftForClientSave(
  current: StoredBugReportDraft | undefined,
  incoming: StoredBugReportDraft | undefined,
  incomingIsOlder: boolean
): StoredBugReportDraft | undefined {
  if (
    incomingIsOlder &&
    current &&
    (!incoming || current.updatedAt > incoming.updatedAt)
  ) {
    return current;
  }

  return incoming;
}

export function mergeClientSaveState(
  current: StoredSessionState,
  incoming: StoredSessionState,
  deletedSessionIds = new Set<string>()
): StoredSessionState {
  const mergedDeletedSessionIds = mergeDeletedSessionIdLists(
    current.deletedSessionIds,
    incoming.deletedSessionIds,
    Array.from(deletedSessionIds)
  );
  const tombstones = new Set(mergedDeletedSessionIds);
  const currentSessions = current.sessions.filter(
    (session) => !tombstones.has(session.id)
  );
  const compactedIncoming = compactEmptyStoredSessions(
    incoming.sessions.filter((session) => !tombstones.has(session.id)),
    incoming.activeSessionId
  );
  const incomingSessions = compactedIncoming.sessions.filter(
    (session) => !tombstones.has(session.id)
  );
  const currentById = new Map(
    currentSessions.map((session) => [session.id, session])
  );
  const incomingIds = new Set(incomingSessions.map((session) => session.id));
  const sessions = incomingSessions.map((session) => {
    const currentSession = currentById.get(session.id);
    if (!currentSession) {
      return session;
    }
    const hasActiveRun = hasActiveRunMessage(currentSession);
    const incomingIsOlder = session.updatedAt <= currentSession.updatedAt;

    return {
      ...session,
      updatedAt: hasActiveRun
        ? Math.max(session.updatedAt, currentSession.updatedAt)
        : session.updatedAt,
      messages: mergeMessagesForClientSave(currentSession.messages, session.messages, {
        preserveStaleArtifactEdits: incomingIsOlder
      }),
      files: mergeSessionFilesForClientSave(
        currentSession.files,
        session.files,
        hasActiveRun
      ),
      bugReportDraft: mergeBugReportDraftForClientSave(
        currentSession.bugReportDraft,
        session.bugReportDraft,
        incomingIsOlder
      )
    };
  });

  for (const session of currentSessions) {
    if (
      !incomingIds.has(session.id) &&
      (!isStoredSessionEmpty(session) || hasDraftSessionFiles(session))
    ) {
      sessions.push(session);
    }
  }

  const activeSessionId = sessions.some(
    (session) => session.id === compactedIncoming.activeSessionId
  )
    ? compactedIncoming.activeSessionId
    : sessions[0]?.id ?? compactedIncoming.activeSessionId;

  return normalizeState({
    sessions,
    activeSessionId,
    deletedSessionIds: mergedDeletedSessionIds
  });
}

function mergeMessage(
  current: StoredMessage,
  patch: Partial<StoredMessage>
): StoredMessage {
  return (
    normalizeMessage({
      ...current,
      ...patch,
      id: current.id,
      role: current.role,
      content:
        Object.prototype.hasOwnProperty.call(patch, "content")
          ? patch.content
          : current.content
    }) ?? current
  );
}

function upsertMessages(
  session: StoredSession,
  inputs: SessionMessageInput[]
): void {
  for (const input of inputs) {
    const message = normalizeMessage(input);
    if (!message) {
      continue;
    }

    const index = session.messages.findIndex(
      (candidate) => candidate.id === message.id
    );
    if (index >= 0) {
      session.messages[index] = mergeMessage(
        session.messages[index],
        selectPresentSessionMessagePatch(input, message)
      );
    } else {
      session.messages.push(message);
    }
  }
}

async function enqueueSessionStateUpdate(
  stateKey: string,
  updater: (state: StoredSessionState) => void | StoredSessionState
): Promise<void> {
  const operation = saveQueue.then(async () => {
    const state = await readSessionState(stateKey);
    const updated = updater(state) ?? state;
    await writeSessionState(updated, stateKey);
  });
  saveQueue = operation.then(
    () => undefined,
    () => undefined
  );
  await operation;
}

async function enqueueSessionStateInspection(
  stateKey: string,
  inspector: (state: StoredSessionState) => void
): Promise<void> {
  const operation = saveQueue.then(async () => {
    inspector(await readSessionState(stateKey));
  });
  saveQueue = operation.then(
    () => undefined,
    () => undefined
  );
  await operation;
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
  const operation = saveQueue.then(() =>
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
  saveQueue = operation.then(
    () => undefined,
    () => undefined
  );
  await operation;
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
    if (isSessionDeleted(state, sessionId)) {
      return;
    }
    const session = ensureSession(state, sessionId);
    upsertMessages(session, messages);
    if (files?.length) {
      session.files = mergeSessionFiles(session.files, files);
    }
    session.updatedAt = now();
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
    if (isSessionDeleted(state, sessionId)) {
      return;
    }
    const session = findSession(state, sessionId);
    if (!session) {
      return;
    }

    const index = session.messages.findIndex((message) => message.id === messageId);
    if (index < 0) {
      return;
    }

    session.messages[index] = mergeMessage(session.messages[index], patch);
    session.updatedAt = now();
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
    if (isSessionDeleted(state, sessionId)) {
      return;
    }
    const session = findSession(state, sessionId);
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

    session.messages[index] = mergeMessage(session.messages[index], patch);
    session.updatedAt = now();
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
    res.json(presentState(req, await readSessionState(getRequestStateKey(req))));
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
    res.json(presentSessionIndex(await readSessionState(getRequestStateKey(req))));
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

export async function handleSaveSessions(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const stateKey = getRequestStateKey(req);
    const state = normalizeState(req.body);
    const deletedSessionIds = normalizeDeletedSessionIds(
      (req.body as { deletedSessionIds?: unknown })?.deletedSessionIds
    );
    const operation = saveQueue.then(() => {
      const sessionIdsByStorageKey = new Map<string, Set<string>>();
      return runSessionFileDeletionTransaction({
        prepare: async () => {
          const current = await readSessionState(stateKey);
          const merged = mergeClientSaveState(
            current,
            state,
            deletedSessionIds
          );
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
    saveQueue = operation.then(
      () => undefined,
      () => undefined
    );
    await operation;
    res.json({ ok: true });
  } catch (error) {
    res
      .status(error instanceof ActiveEphemeralFileDeletionError ? 409 : 500)
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
    const session = findSession(state, req.params.sessionId);
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
    const file = await runSessionFileUploadTransaction({
      assertUploadAllowed: () =>
        enqueueSessionStateInspection(stateKey, (state) => {
          assertSessionFileUploadAllowed(state, sessionId);
        }),
      storeBlob: () => putStoredFile(fileId, input),
      createFile: (stored): StoredSessionFile => ({
        id: fileId,
        kind,
        name,
        mimeType: stored.mimeType,
        size: stored.size,
        createdAt: now(),
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
            now()
          );
        }),
      rollbackBlob: (stored) => deleteStoredFile(stored.storageKey)
    });

    res.json({ file: withFileUrls(req, file) });
  } catch (error) {
    res.status(error instanceof TombstonedSessionUploadError ? 409 : 400).json({
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

export async function handleGetFileContent(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const states = await readAllSessionStates();
    const found = states
      .map((state) => findFileById(state, req.params.fileId))
      .find((candidate): candidate is { session: StoredSession; file: StoredSessionFile } =>
        Boolean(candidate)
      );
    const token = stringValue(req.query.token);
    if (!found || !found.file.accessToken || token !== found.file.accessToken) {
      res.status(404).send("File not found.");
      return;
    }

    const { buffer, mimeType } = await getFileBuffer(found.file);
    const disposition = req.query.download
      ? `attachment; ${filenameHeader(found.file.name)}`
      : `inline; ${filenameHeader(found.file.name)}`;

    res
      .status(200)
      .type(mimeType)
      .set({
        "Cache-Control": "private, max-age=31536000, immutable",
        "Content-Disposition": disposition,
        "Content-Length": String(buffer.byteLength),
        "Access-Control-Allow-Origin": "*",
        "Cross-Origin-Resource-Policy": "cross-origin",
        "X-Content-Type-Options": "nosniff"
      })
      .send(buffer);
  } catch (error) {
    res.status(500).send(error instanceof Error ? error.message : String(error));
  }
}

export async function handleDeleteSessionFile(
  req: Request,
  res: Response
): Promise<void> {
  const sessionId = req.params.sessionId;
  const fileId = req.params.fileId;
  const stateKey = getRequestStateKey(req);

  try {
    const operation = saveQueue.then(() =>
      runSessionFileDeletionTransaction({
        prepare: async () => {
          const state = await readSessionState(stateKey);
          const session = findSession(state, sessionId);
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
              session.updatedAt = now();
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
    saveQueue = operation.then(
      () => undefined,
      () => undefined
    );
    await operation;

    res.json({ ok: true });
  } catch (error) {
    res
      .status(error instanceof ActiveEphemeralFileDeletionError ? 409 : 500)
      .json({
        error: error instanceof Error ? error.message : String(error)
      });
  }
}
