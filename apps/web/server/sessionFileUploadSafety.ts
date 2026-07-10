const MAX_EPHEMERAL_FILE_IDS = 200;
const MAX_FILE_ID_LENGTH = 120;

export class TombstonedSessionUploadError extends Error {
  readonly code = "SESSION_TOMBSTONED";

  constructor(sessionId: string) {
    super(`Session ${sessionId || "(empty)"} was deleted.`);
    this.name = "TombstonedSessionUploadError";
  }
}

export class SessionFileUploadRollbackError extends Error {
  readonly uploadError: unknown;
  readonly rollbackError: unknown;

  constructor(uploadError: unknown, rollbackError: unknown) {
    super("Session file upload failed and its stored blob could not be rolled back.");
    this.name = "SessionFileUploadRollbackError";
    this.uploadError = uploadError;
    this.rollbackError = rollbackError;
  }
}

export function normalizeEphemeralFileIds(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const seen = new Set<string>();
  const ids: string[] = [];
  for (const item of input) {
    if (typeof item !== "string") {
      continue;
    }
    const id = item.trim().slice(0, MAX_FILE_ID_LENGTH);
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    ids.push(id);
    if (ids.length >= MAX_EPHEMERAL_FILE_IDS) {
      break;
    }
  }
  return ids;
}

export function selectDurableSessionFiles<T extends { id: string }>(
  files: readonly T[],
  ephemeralFileIds: readonly string[]
): T[] {
  if (!ephemeralFileIds.length) {
    return [...files];
  }

  const ephemeralIds = new Set(ephemeralFileIds);
  return files.filter((file) => !ephemeralIds.has(file.id));
}

export function mergeSessionFilesForClientSave<
  TFile extends { id: string; draft?: boolean }
>(
  current: readonly TFile[] | undefined,
  incoming: readonly TFile[] | undefined,
  preserveAllCurrentFiles: boolean
): TFile[] {
  const files = new Map<string, TFile>();
  for (const file of current ?? []) {
    if (preserveAllCurrentFiles || file.draft) {
      files.set(file.id, file);
    }
  }
  for (const file of incoming ?? []) {
    files.set(file.id, file);
  }
  return Array.from(files.values());
}

export function selectTombstonedSessionStorageKeys<
  TFile extends { storageKey?: string },
  TSession extends { id: string; files?: readonly TFile[] }
>(sessions: readonly TSession[], deletedSessionIds: Iterable<string>): string[] {
  const tombstones = new Set(deletedSessionIds);
  const storageKeys = new Set<string>();
  for (const session of sessions) {
    if (!tombstones.has(session.id)) {
      continue;
    }
    for (const file of session.files ?? []) {
      if (file.storageKey) {
        storageKeys.add(file.storageKey);
      }
    }
  }
  return Array.from(storageKeys);
}

export type EphemeralSessionFileIdentity = {
  id: string;
  storageKey: string;
  contentHash?: string;
};

export function selectEphemeralSessionFileIdentities<
  TFile extends { id: string; storageKey?: string; contentHash?: string }
>(
  files: readonly TFile[],
  ephemeralFileIds: readonly string[]
): EphemeralSessionFileIdentity[] {
  const ephemeralIds = new Set(ephemeralFileIds);
  const identities = new Map<string, EphemeralSessionFileIdentity>();
  for (const file of files) {
    if (!ephemeralIds.has(file.id) || !file.storageKey) {
      continue;
    }
    identities.set(file.id, {
      id: file.id,
      storageKey: file.storageKey,
      ...(file.contentHash ? { contentHash: file.contentHash } : {})
    });
  }
  return Array.from(identities.values());
}

export function removeOwnedEphemeralSessionFiles<
  TFile extends {
    id: string;
    draft?: boolean;
    storageKey?: string;
    contentHash?: string;
  }
>(
  files: readonly TFile[] | undefined,
  expectedFiles: readonly EphemeralSessionFileIdentity[]
): { files: TFile[]; removedStorageKeys: string[] } {
  const expectedById = new Map(expectedFiles.map((file) => [file.id, file]));
  const keptFiles: TFile[] = [];
  const removedStorageKeys = new Set<string>();

  for (const file of files ?? []) {
    const expected = expectedById.get(file.id);
    const matchesIdentity = Boolean(
      file.draft &&
        file.storageKey &&
        expected?.storageKey === file.storageKey &&
        (!expected.contentHash || expected.contentHash === file.contentHash)
    );
    if (!matchesIdentity) {
      keptFiles.push(file);
      continue;
    }
    removedStorageKeys.add(file.storageKey as string);
  }

  return {
    files: keptFiles,
    removedStorageKeys: Array.from(removedStorageKeys)
  };
}

export function removeOwnedEphemeralFilesFromSession<
  TFile extends {
    id: string;
    draft?: boolean;
    storageKey?: string;
    contentHash?: string;
  },
  TSession extends { id: string; files?: TFile[] }
>(
  sessions: readonly TSession[],
  sessionId: string | undefined,
  expectedFiles: readonly EphemeralSessionFileIdentity[]
): { sessions: TSession[]; removedStorageKeys: string[] } {
  if (!sessionId || !expectedFiles.length) {
    return { sessions: [...sessions], removedStorageKeys: [] };
  }

  let removedStorageKeys: string[] = [];
  const nextSessions = sessions.map((session) => {
    if (session.id !== sessionId) {
      return session;
    }
    const result = removeOwnedEphemeralSessionFiles(
      session.files,
      expectedFiles
    );
    if (!result.removedStorageKeys.length) {
      return session;
    }
    removedStorageKeys = result.removedStorageKeys;
    return { ...session, files: result.files };
  });

  return { sessions: nextSessions, removedStorageKeys };
}

export type SessionFileMetadataSession<TFile> = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: unknown[];
  files?: TFile[];
};

export type SessionFileMetadataState<TFile> = {
  sessions: SessionFileMetadataSession<TFile>[];
  activeSessionId: string;
  deletedSessionIds?: string[];
};

export function assertSessionFileUploadAllowed(
  state: Pick<SessionFileMetadataState<unknown>, "deletedSessionIds">,
  sessionId: string
): void {
  if (state.deletedSessionIds?.includes(sessionId)) {
    throw new TombstonedSessionUploadError(sessionId);
  }
}

export function applyUploadedSessionFileMetadata<TFile extends { id: string }>(
  state: SessionFileMetadataState<TFile>,
  sessionId: string,
  file: TFile,
  timestamp: number
): void {
  assertSessionFileUploadAllowed(state, sessionId);

  let session = state.sessions.find((candidate) => candidate.id === sessionId);
  if (!session) {
    session = {
      id: sessionId,
      title: "New Session",
      createdAt: timestamp,
      updatedAt: timestamp,
      messages: [],
      files: []
    };
    state.sessions.unshift(session);
    state.activeSessionId = sessionId;
  }

  session.files = [
    ...(session.files ?? []).filter((candidate) => candidate.id !== file.id),
    file
  ];
  session.updatedAt = timestamp;
}

type SessionFileUploadTransaction<TStored, TFile> = {
  assertUploadAllowed: () => void | Promise<void>;
  storeBlob: () => TStored | Promise<TStored>;
  createFile: (stored: TStored) => TFile;
  persistMetadata: (file: TFile) => void | Promise<void>;
  rollbackBlob: (stored: TStored) => void | Promise<void>;
};

export async function runSessionFileUploadTransaction<TStored, TFile>({
  assertUploadAllowed,
  storeBlob,
  createFile,
  persistMetadata,
  rollbackBlob
}: SessionFileUploadTransaction<TStored, TFile>): Promise<TFile> {
  await assertUploadAllowed();

  let stored: TStored | undefined;
  try {
    stored = await storeBlob();
    const file = createFile(stored);
    await persistMetadata(file);
    return file;
  } catch (error) {
    if (stored === undefined) {
      throw error;
    }

    try {
      await rollbackBlob(stored);
    } catch (rollbackError) {
      throw new SessionFileUploadRollbackError(error, rollbackError);
    }
    throw error;
  }
}

type SessionFileDeletionPlan = {
  storageKeys: readonly string[];
  persistMetadata(): void | Promise<void>;
};

export async function runSessionFileDeletionTransaction({
  prepare,
  deleteBlob,
  acquireDeletion = () => ({ release() {} })
}: {
  prepare(): SessionFileDeletionPlan | Promise<SessionFileDeletionPlan>;
  deleteBlob(storageKey: string): void | Promise<void>;
  acquireDeletion?(storageKeys: readonly string[]):
    | { release(): void }
    | Promise<{ release(): void }>;
}): Promise<number> {
  const plan = await prepare();
  const storageKeys = Array.from(new Set(plan.storageKeys.filter(Boolean)));
  const deletionLease = await acquireDeletion(storageKeys);
  try {
    await Promise.all(storageKeys.map((storageKey) => deleteBlob(storageKey)));
    await plan.persistMetadata();
    return storageKeys.length;
  } finally {
    deletionLease.release();
  }
}
