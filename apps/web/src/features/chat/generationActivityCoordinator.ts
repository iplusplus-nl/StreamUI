export type LocalGenerationLease = {
  release(): void;
};

export type ChatGenerationLease = {
  release(): void;
};

export type GenerationActivitySnapshot = {
  busy: boolean;
  chatRunCount: number;
  localOwnerId: string | null;
};

export type GenerationActivityCoordinator = {
  isBusy(): boolean;
  getSnapshot(): GenerationActivitySnapshot;
  tryAcquireChatRun(runId: string): ChatGenerationLease | undefined;
  registerRestoredChatRun(runId: string): ChatGenerationLease | undefined;
  promoteLocalToChat(
    localLease: LocalGenerationLease,
    runId: string
  ): ChatGenerationLease | undefined;
  finishChatRun(runId: string): boolean;
  tryAcquireLocal(ownerId: string): LocalGenerationLease | undefined;
  reset(): void;
};

export type GenerationActivityCoordinatorPorts = {
  onBusyChange(busy: boolean): void;
};

export function createGenerationActivityCoordinator(
  ports: GenerationActivityCoordinatorPorts
): GenerationActivityCoordinator {
  const chatRunTokens = new Map<string, symbol>();
  let localOwner: { id: string; token: symbol } | null = null;
  const localLeaseTokens = new WeakMap<LocalGenerationLease, symbol>();
  let lastEmittedBusy = false;

  const isBusy = () => chatRunTokens.size > 0 || localOwner !== null;
  const emitBusyChange = () => {
    const busy = isBusy();
    if (busy === lastEmittedBusy) {
      return;
    }
    lastEmittedBusy = busy;
    ports.onBusyChange(busy);
  };
  const createChatLease = (
    runId: string,
    token: symbol
  ): ChatGenerationLease => {
    let released = false;
    return {
      release() {
        if (released) {
          return;
        }
        released = true;
        if (chatRunTokens.get(runId) === token) {
          chatRunTokens.delete(runId);
          emitBusyChange();
        }
      }
    };
  };

  return {
    isBusy,

    getSnapshot() {
      return {
        busy: isBusy(),
        chatRunCount: chatRunTokens.size,
        localOwnerId: localOwner?.id ?? null
      };
    },

    tryAcquireChatRun(runId) {
      const normalizedRunId = runId.trim();
      if (!normalizedRunId || isBusy()) {
        return undefined;
      }

      const token = Symbol(normalizedRunId);
      chatRunTokens.set(normalizedRunId, token);
      emitBusyChange();
      return createChatLease(normalizedRunId, token);
    },

    registerRestoredChatRun(runId) {
      const normalizedRunId = runId.trim();
      if (!normalizedRunId || chatRunTokens.has(normalizedRunId)) {
        return undefined;
      }

      const token = Symbol(normalizedRunId);
      chatRunTokens.set(normalizedRunId, token);
      emitBusyChange();
      return createChatLease(normalizedRunId, token);
    },

    promoteLocalToChat(localLease, runId) {
      const normalizedRunId = runId.trim();
      const localToken = localLeaseTokens.get(localLease);
      if (
        !normalizedRunId ||
        !localToken ||
        localOwner?.token !== localToken ||
        chatRunTokens.size > 0
      ) {
        return undefined;
      }

      const chatToken = Symbol(normalizedRunId);
      chatRunTokens.set(normalizedRunId, chatToken);
      localOwner = null;
      emitBusyChange();
      return createChatLease(normalizedRunId, chatToken);
    },

    finishChatRun(runId) {
      if (!chatRunTokens.delete(runId)) {
        return false;
      }

      emitBusyChange();
      return true;
    },

    tryAcquireLocal(ownerId) {
      const normalizedOwnerId = ownerId.trim();
      if (!normalizedOwnerId || isBusy()) {
        return undefined;
      }

      const token = Symbol(normalizedOwnerId);
      localOwner = { id: normalizedOwnerId, token };
      emitBusyChange();
      let released = false;
      const lease: LocalGenerationLease = {
        release() {
          if (released) {
            return;
          }
          released = true;
          if (localOwner?.token !== token) {
            return;
          }
          localOwner = null;
          emitBusyChange();
        }
      };
      localLeaseTokens.set(lease, token);
      return lease;
    },

    reset() {
      chatRunTokens.clear();
      localOwner = null;
      emitBusyChange();
    }
  };
}
