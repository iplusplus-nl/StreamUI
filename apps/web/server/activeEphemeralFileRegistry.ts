export type ActiveEphemeralFileRegistration = {
  stateKey: string;
  sessionId: string;
  storageKeys: readonly string[];
};

export type EphemeralFileLockIdentity = {
  stateKey: string;
  sessionId: string;
  storageKey: string;
};

export type EphemeralFileDeletionLease = {
  storageKeys: readonly string[];
  release(): void;
};

export type ActiveEphemeralFileLease = {
  release(): void;
  acquireCleanupLease(): EphemeralFileDeletionLease;
};

export class ActiveEphemeralFileDeletionError extends Error {
  readonly code = "EPHEMERAL_FILE_IN_USE";

  constructor() {
    super("A temporary file is in use or is being deleted.");
    this.name = "ActiveEphemeralFileDeletionError";
  }
}

type RegistryEntry = EphemeralFileLockIdentity & { key: string };

function fileKey(stateKey: string, sessionId: string, storageKey: string) {
  return `${stateKey}\u0000${sessionId}\u0000${storageKey}`;
}

function uniqueEntries(
  identities: readonly EphemeralFileLockIdentity[]
): RegistryEntry[] {
  const entries = new Map<string, RegistryEntry>();
  for (const identity of identities) {
    if (!identity.storageKey) {
      continue;
    }
    const key = fileKey(
      identity.stateKey,
      identity.sessionId,
      identity.storageKey
    );
    entries.set(key, { ...identity, key });
  }
  return Array.from(entries.values());
}

export function createActiveEphemeralFileRegistry() {
  const readerTokensByFile = new Map<string, Set<symbol>>();
  const deletionTokensByFile = new Map<string, symbol>();

  const isActive = (
    stateKey: string,
    sessionId: string,
    storageKey: string
  ) =>
    Boolean(
      readerTokensByFile.get(fileKey(stateKey, sessionId, storageKey))?.size
    );

  const isDeletionReserved = (
    stateKey: string,
    sessionId: string,
    storageKey: string
  ) => deletionTokensByFile.has(fileKey(stateKey, sessionId, storageKey));

  const createDeletionLease = (
    entries: readonly RegistryEntry[]
  ): EphemeralFileDeletionLease => {
    const token = Symbol("ephemeral-file-deletion");
    for (const { key } of entries) {
      deletionTokensByFile.set(key, token);
    }
    let released = false;
    return {
      storageKeys: entries.map((entry) => entry.storageKey),
      release() {
        if (released) {
          return;
        }
        released = true;
        for (const { key } of entries) {
          if (deletionTokensByFile.get(key) === token) {
            deletionTokensByFile.delete(key);
          }
        }
      }
    };
  };

  const acquireDeletion = (
    identities: readonly EphemeralFileLockIdentity[]
  ): EphemeralFileDeletionLease => {
    const entries = uniqueEntries(identities);
    if (
      entries.some(
        ({ key }) =>
          readerTokensByFile.get(key)?.size || deletionTokensByFile.has(key)
      )
    ) {
      throw new ActiveEphemeralFileDeletionError();
    }
    return createDeletionLease(entries);
  };

  return {
    register({
      stateKey,
      sessionId,
      storageKeys
    }: ActiveEphemeralFileRegistration): ActiveEphemeralFileLease {
      const entries = uniqueEntries(
        storageKeys.map((storageKey) => ({ stateKey, sessionId, storageKey }))
      );
      if (entries.some(({ key }) => deletionTokensByFile.has(key))) {
        throw new ActiveEphemeralFileDeletionError();
      }

      const token = Symbol("active-ephemeral-file");
      for (const { key } of entries) {
        const tokens = readerTokensByFile.get(key) ?? new Set<symbol>();
        tokens.add(token);
        readerTokensByFile.set(key, tokens);
      }

      let released = false;
      const releaseReaders = () => {
        if (released) {
          return;
        }
        released = true;
        for (const { key } of entries) {
          const tokens = readerTokensByFile.get(key);
          tokens?.delete(token);
          if (!tokens?.size) {
            readerTokensByFile.delete(key);
          }
        }
      };

      return {
        release: releaseReaders,
        acquireCleanupLease() {
          releaseReaders();
          const inactiveEntries = entries.filter(
            ({ key }) =>
              !readerTokensByFile.get(key)?.size &&
              !deletionTokensByFile.has(key)
          );
          return createDeletionLease(inactiveEntries);
        }
      };
    },

    acquireDeletion,
    isActive,
    isDeletionReserved
  };
}

export const activeEphemeralFileRegistry =
  createActiveEphemeralFileRegistry();

export async function cleanupReleasedEphemeralFiles(
  lease: ActiveEphemeralFileLease,
  cleanup: (inactiveStorageKeys: readonly string[]) => void | Promise<void>
): Promise<void> {
  const deletionLease = lease.acquireCleanupLease();
  try {
    if (deletionLease.storageKeys.length) {
      await cleanup(deletionLease.storageKeys);
    }
  } finally {
    deletionLease.release();
  }
}
