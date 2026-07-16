import {
  createId,
  normalizeStoredSessionState,
  type ChatSession,
  type SessionFile,
  type SessionState
} from "../../domain/chat/sessionModel";
import {
  requestSessions,
  saveSerializedSessionState,
  uploadSessionFile,
  type SessionFileUploadInput
} from "./sessionApi";
import {
  nextSessionSaveRevision,
  serializeSessionStateForSave
} from "./sessionPersistence";

type FetchSessions = (clientId: string) => Promise<Response>;
type PersistSessions = (
  serializedState: string,
  clientId: string
) => Promise<Response>;
type UploadFile = (
  sessionId: string,
  input: SessionFileUploadInput,
  clientId: string
) => Promise<SessionFile>;

export type LocalWorkspaceMergeDependencies = {
  requestSessions: FetchSessions;
  persistSessions: PersistSessions;
  uploadFile: UploadFile;
  nextRevision(clientId: string): number;
  createImportSuffix(): string;
  now(): number;
};

const defaultDependencies: LocalWorkspaceMergeDependencies = {
  requestSessions,
  persistSessions: (serializedState, clientId) =>
    saveSerializedSessionState(serializedState, clientId),
  uploadFile: uploadSessionFile,
  nextRevision: nextSessionSaveRevision,
  createImportSuffix: () => createId("retry"),
  now: Date.now
};

function importedSessionBaseId(localSessionId: string): string {
  return `browser-import:${localSessionId}`;
}

function isImportedSessionId(
  sessionId: string,
  localSessionId: string
): boolean {
  const baseId = importedSessionBaseId(localSessionId);
  return sessionId === baseId || sessionId.startsWith(`${baseId}:`);
}

function existingImportedSession(
  accountState: SessionState,
  localSessionId: string
): ChatSession | undefined {
  const candidates = accountState.sessions.filter((session) =>
    isImportedSessionId(session.id, localSessionId)
  );
  return (
    candidates.find(
      (session) => session.id === importedSessionBaseId(localSessionId)
    ) ?? candidates.sort((left, right) => right.updatedAt - left.updatedAt)[0]
  );
}

function serverFileIdentity(file: SessionFile): string {
  return JSON.stringify([
    file.kind,
    file.name,
    file.mimeType,
    file.sourceMessageId ?? "",
    file.width ?? null,
    file.height ?? null,
    file.summary ?? ""
  ]);
}

function isServerBackedFile(file: SessionFile): boolean {
  return Boolean(
    file.storageKey || file.contentHash || file.accessToken || file.downloadUrl
  );
}

function matchUploadedFiles(
  localFiles: readonly SessionFile[],
  serverFiles: readonly SessionFile[]
): Map<string, SessionFile> {
  const candidates = new Map<string, SessionFile[]>();
  for (const file of serverFiles.filter(isServerBackedFile)) {
    const identity = serverFileIdentity(file);
    const matches = candidates.get(identity) ?? [];
    matches.push(file);
    candidates.set(identity, matches);
  }

  const result = new Map<string, SessionFile>();
  for (const localFile of localFiles) {
    const matches = candidates.get(serverFileIdentity(localFile));
    const match = matches?.shift();
    if (match) {
      result.set(localFile.id, match);
    }
  }
  return result;
}

function remapMessages(
  session: ChatSession,
  uploadedFiles: ReadonlyMap<string, SessionFile>
): ChatSession["messages"] {
  return session.messages.map((message) => {
    if (!message.fileIds?.length) {
      return message;
    }
    const fileIds = message.fileIds
      .map((fileId) => uploadedFiles.get(fileId)?.id)
      .filter((fileId): fileId is string => Boolean(fileId));
    return {
      ...message,
      fileIds: fileIds.length ? fileIds : undefined
    };
  });
}

function importedSession(
  session: ChatSession,
  targetSessionId: string,
  uploadedFiles: ReadonlyMap<string, SessionFile>
): ChatSession {
  return {
    ...session,
    id: targetSessionId,
    messages: remapMessages(session, uploadedFiles),
    files: session.files
      .map((file) => uploadedFiles.get(file.id))
      .filter((file): file is SessionFile => Boolean(file))
  };
}

function mergeImportedSessions(
  accountState: SessionState,
  imports: readonly ChatSession[]
): SessionState {
  const importedIds = new Set(imports.map((session) => session.id));
  return {
    sessions: [
      ...accountState.sessions.filter((session) => !importedIds.has(session.id)),
      ...imports
    ],
    activeSessionId: accountState.activeSessionId
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)])
    );
  }
  return value;
}

function sessionVerificationFingerprint(session: ChatSession): string {
  const serialized = JSON.parse(
    serializeSessionStateForSave(
      { sessions: [session], activeSessionId: session.id },
      "local-import-verification",
      [],
      1
    )
  ) as { sessions?: ChatSession[] };
  const normalized = normalizeStoredSessionState(
    { sessions: serialized.sessions ?? [], activeSessionId: session.id }
  ).sessions[0];
  return JSON.stringify(canonicalize(normalized));
}

async function readAccountState(
  clientId: string,
  dependencies: LocalWorkspaceMergeDependencies
): Promise<SessionState> {
  const response = await dependencies.requestSessions(clientId);
  if (!response.ok) {
    throw new Error(`Account sessions could not be loaded (HTTP ${response.status}).`);
  }
  return normalizeStoredSessionState(await response.json(), dependencies.now());
}

async function persistAccountState(
  state: SessionState,
  clientId: string,
  dependencies: LocalWorkspaceMergeDependencies
): Promise<boolean> {
  const response = await dependencies.persistSessions(
    serializeSessionStateForSave(
      state,
      clientId,
      [],
      dependencies.nextRevision(clientId)
    ),
    clientId
  );
  if (!response.ok) {
    throw new Error(`Account sessions could not be saved (HTTP ${response.status}).`);
  }
  const result = (await response.json().catch(() => null)) as {
    applied?: unknown;
  } | null;
  return result?.applied !== false;
}

type LocalSessionImport = {
  localSession: ChatSession;
  targetSessionId: string;
  uploadedFiles: Map<string, SessionFile>;
};

function materializeImports(
  imports: readonly LocalSessionImport[]
): ChatSession[] {
  return imports.map((entry) =>
    importedSession(
      entry.localSession,
      entry.targetSessionId,
      entry.uploadedFiles
    )
  );
}

async function stageImportsUnderLiveIds(
  imports: LocalSessionImport[],
  accountState: SessionState,
  clientId: string,
  dependencies: LocalWorkspaceMergeDependencies
): Promise<SessionState> {
  let latestState = accountState;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const applied = await persistAccountState(
      mergeImportedSessions(latestState, materializeImports(imports)),
      clientId,
      dependencies
    );
    latestState = await readAccountState(clientId, dependencies);
    if (!applied) {
      continue;
    }
    const liveIds = new Set(latestState.sessions.map((session) => session.id));
    const missing = imports.filter(
      (entry) => !liveIds.has(entry.targetSessionId)
    );
    if (!missing.length) {
      return latestState;
    }
    if (attempt === 4) {
      throw new Error(
        "The account rejected a previously deleted local session id. Your browser copy was kept."
      );
    }

    for (const entry of missing) {
      entry.targetSessionId = `${importedSessionBaseId(
        entry.localSession.id
      )}:${dependencies.createImportSuffix()}`;
      entry.uploadedFiles = new Map();
    }
  }

  throw new Error(
    "Newer account updates repeatedly won the merge. Your browser copy was kept; please retry."
  );
}

async function persistCompletedImports(
  accountState: SessionState,
  imports: readonly ChatSession[],
  clientId: string,
  dependencies: LocalWorkspaceMergeDependencies
): Promise<void> {
  let latestState = accountState;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (
      await persistAccountState(
        mergeImportedSessions(latestState, imports),
        clientId,
        dependencies
      )
    ) {
      return;
    }
    latestState = await readAccountState(clientId, dependencies);
  }
  throw new Error(
    "Newer account updates repeatedly won the merge. Your browser copy was kept; please retry."
  );
}

function uploadInput(file: SessionFile): SessionFileUploadInput {
  if (!file.dataUrl && file.text === undefined) {
    throw new Error(`Local file “${file.name}” no longer has browser content.`);
  }
  return {
    kind: file.kind,
    name: file.name,
    mimeType: file.mimeType,
    dataUrl: file.dataUrl,
    text: file.text,
    width: file.width,
    height: file.height,
    sourceMessageId: file.sourceMessageId,
    summary: file.summary
  };
}

async function runBoundedUploads(
  tasks: ReadonlyArray<() => Promise<void>>,
  concurrency = 4
): Promise<void> {
  let nextTask = 0;
  let firstError: unknown;
  let failed = false;
  const worker = async () => {
    while (nextTask < tasks.length) {
      const task = tasks[nextTask];
      nextTask += 1;
      try {
        await task();
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, concurrency), tasks.length) },
      () => worker()
    )
  );
  if (failed) {
    throw firstError;
  }
}

export async function mergeLocalWorkspaceIntoAccount(
  localState: SessionState,
  clientId: string,
  dependencyOverrides: Partial<LocalWorkspaceMergeDependencies> = {}
): Promise<SessionState> {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  const accountState = await readAccountState(clientId, dependencies);
  const imports: LocalSessionImport[] = localState.sessions.map(
    (localSession) => {
      const existing = existingImportedSession(accountState, localSession.id);
      return {
        localSession,
        targetSessionId:
          existing?.id ?? importedSessionBaseId(localSession.id),
        uploadedFiles: matchUploadedFiles(
          localSession.files,
          existing?.files ?? []
        )
      };
    }
  );

  await stageImportsUnderLiveIds(
    imports,
    accountState,
    clientId,
    dependencies
  );

  await runBoundedUploads(
    imports.flatMap((entry) =>
      entry.localSession.files
        .filter((file) => !entry.uploadedFiles.has(file.id))
        .map((file) => async () => {
          const serverFile = await dependencies.uploadFile(
            entry.targetSessionId,
            uploadInput(file),
            clientId
          );
          entry.uploadedFiles.set(file.id, serverFile);
        })
    )
  );

  const latestAccountState = await readAccountState(clientId, dependencies);
  const completedImports = materializeImports(imports);
  await persistCompletedImports(
    latestAccountState,
    completedImports,
    clientId,
    dependencies
  );

  const verifiedState = await readAccountState(clientId, dependencies);
  const verifiedById = new Map(
    verifiedState.sessions.map((session) => [session.id, session])
  );
  for (const expected of completedImports) {
    const actual = verifiedById.get(expected.id);
    if (
      !actual ||
      sessionVerificationFingerprint(actual) !==
        sessionVerificationFingerprint(expected)
    ) {
      throw new Error(
        "The imported session content and files could not be verified on the account. Your browser copy was kept."
      );
    }
  }
  return verifiedState;
}
