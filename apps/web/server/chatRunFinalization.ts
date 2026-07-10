export type ChatRunTerminalOutcome = "complete" | "error" | "cancelled";

type ChatRunTerminalFinalization = {
  outcome: ChatRunTerminalOutcome;
  persistTerminalState: (outcome: ChatRunTerminalOutcome) => void | Promise<void>;
  waitForExecution: (outcome: ChatRunTerminalOutcome) => void | Promise<void>;
  cleanupEphemeralFiles: (outcome: ChatRunTerminalOutcome) => void | Promise<void>;
  cleanupAttempts?: number;
};

export async function finalizeChatRunTerminal({
  outcome,
  persistTerminalState,
  waitForExecution,
  cleanupEphemeralFiles,
  cleanupAttempts = 3
}: ChatRunTerminalFinalization): Promise<void> {
  try {
    await persistTerminalState(outcome);
  } finally {
    await waitForExecution(outcome);
    let cleanupError: unknown;
    let cleaned = false;
    const attempts = Math.max(1, Math.round(cleanupAttempts));
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await cleanupEphemeralFiles(outcome);
        cleaned = true;
        break;
      } catch (error) {
        cleanupError = error;
      }
    }
    if (!cleaned) {
      throw cleanupError;
    }
  }
}
