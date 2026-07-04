import type { Request, Response } from "express";
import "./env.js";
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Database as SqliteDatabase } from "sqlite";

type StoredMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  attachments?: unknown[];
  reasoning?: string;
  sessionTitle?: string;
  rawStream?: string;
  hasStreamUi?: boolean;
  streamUiComplete?: boolean;
  artifactContext?: unknown;
  runtimeErrors?: unknown[];
  repairOfMessageId?: string;
  repairAttempt?: number;
  status?: "complete" | "error";
  error?: string;
};

type StoredSession = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: StoredMessage[];
};

type StoredSessionState = {
  sessions: StoredSession[];
  activeSessionId: string;
};

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
const SESSION_STATE_KEY = "global";

let saveQueue = Promise.resolve();
let database: SqliteDatabase | null = null;

function now(): number {
  return Date.now();
}

function createId(prefix: string): string {
  return `${prefix}-${now()}-${randomUUID().slice(0, 8)}`;
}

function createEmptyState(): StoredSessionState {
  const timestamp = now();
  const session: StoredSession = {
    id: createId("session"),
    title: "New Session",
    createdAt: timestamp,
    updatedAt: timestamp,
    messages: []
  };

  return {
    sessions: [session],
    activeSessionId: session.id
  };
}

function finiteTimestamp(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
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

  return {
    id: message.id,
    role: message.role,
    content: stringValue(message.content),
    attachments: Array.isArray(message.attachments)
      ? message.attachments
      : undefined,
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
    status:
      message.status === "error"
        ? "error"
        : message.role === "assistant"
          ? "complete"
          : undefined,
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
    messages
  };
}

function normalizeState(input: unknown): StoredSessionState {
  if (!input || typeof input !== "object") {
    return createEmptyState();
  }

  const state = input as Partial<StoredSessionState>;
  const sessions = Array.isArray(state.sessions)
    ? state.sessions
        .map(normalizeSession)
        .filter((session): session is StoredSession => session !== null)
        .sort((a, b) => b.updatedAt - a.updatedAt)
    : [];

  if (!sessions.length) {
    return createEmptyState();
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
    activeSessionId
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
      console.warn("Could not read StreamUI sessions.", error);
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
  db: SqliteDatabase
): Promise<StoredSessionState | null> {
  const row = (await db.get(
    "SELECT value FROM streamui_state WHERE key = ?",
    SESSION_STATE_KEY
  )) as { value?: unknown } | undefined;

  if (typeof row?.value !== "string") {
    return null;
  }

  return normalizeState(JSON.parse(row.value));
}

async function writeSqliteState(
  db: SqliteDatabase,
  state: StoredSessionState
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
    SESSION_STATE_KEY,
    JSON.stringify(normalized),
    now()
  );
}

async function readSessionState(): Promise<StoredSessionState> {
  await ensureSessionsDir();
  const db = await getDatabase();

  try {
    const sqliteState = await readSqliteState(db);
    if (sqliteState) {
      return sqliteState;
    }
  } catch (error) {
    console.warn("Could not read StreamUI SQLite sessions.", error);
  }

  const legacyState = await readLegacyJsonState();
  const state = legacyState ?? createEmptyState();
  await writeSqliteState(db, state);
  return state;
}

async function writeSessionState(state: StoredSessionState): Promise<void> {
  await ensureSessionsDir();
  const db = await getDatabase();
  await writeSqliteState(db, state);
}

export async function handleGetSessions(
  _req: Request,
  res: Response
): Promise<void> {
  try {
    res.json(await readSessionState());
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
    const state = normalizeState(req.body);
    saveQueue = saveQueue.then(() => writeSessionState(state));
    await saveQueue;
    res.json({ ok: true });
  } catch (error) {
    saveQueue = Promise.resolve();
    res.status(500).json({
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
