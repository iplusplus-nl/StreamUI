import "./env.js";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { fileURLToPath } from "node:url";
import type { Database as SqliteDatabase } from "sqlite";
import { Pool, type PoolClient } from "pg";
import {
  createEmptySessionState,
  normalizeStoredSessionState,
  sessionStateNow
} from "./sessionStateModel.js";
import type {
  StoredSessionFile,
  StoredSessionState
} from "./sessionStateTypes.js";

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
const databaseUrl = (
  process.env.CHATHTML_DATABASE_URL ??
  process.env.DATABASE_URL ??
  ""
).trim();

export const DEFAULT_SESSION_STATE_KEY = "global";

export type SessionRepositoryBackend = "postgres" | "sqlite";

export type StoredFileCapability = {
  stateKey: string;
  sessionId: string;
  file: StoredSessionFile;
};

export type SessionStateSnapshot = {
  state: StoredSessionState;
  version: number;
};

export type SessionStateEntry = SessionStateSnapshot & {
  stateKey: string;
};

type PostgresTransactionContext = {
  client: PoolClient;
  stateKey: string;
};

const transactionContext = new AsyncLocalStorage<PostgresTransactionContext>();
const stateQueues = new Map<string, Promise<void>>();
let sqliteDatabase: SqliteDatabase | null = null;
let postgresPool: Pool | null = null;
let postgresReady: Promise<Pool> | null = null;

export function getSessionRepositoryBackend(): SessionRepositoryBackend {
  return databaseUrl ? "postgres" : "sqlite";
}

function capabilityHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function collectFileCapabilities(state: StoredSessionState): Array<{
  file: StoredSessionFile;
  sessionId: string;
}> {
  return state.sessions.flatMap((session) =>
    (session.files ?? [])
      .filter((file) => Boolean(file.id && file.accessToken))
      .map((file) => ({ file, sessionId: session.id }))
  );
}

async function ensureSessionsDir(): Promise<void> {
  await mkdir(path.dirname(sqliteFile), { recursive: true, mode: 0o700 });
}

async function readLegacyJsonState(): Promise<StoredSessionState | null> {
  try {
    const raw = await readFile(stateFile, "utf8");
    return normalizeStoredSessionState(JSON.parse(raw));
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function rebuildSqliteCapabilities(
  db: SqliteDatabase,
  stateKey: string,
  state: StoredSessionState
): Promise<void> {
  await db.run(
    "DELETE FROM streamui_file_capability WHERE state_key = ?",
    stateKey
  );
  for (const { file, sessionId } of collectFileCapabilities(state)) {
    await db.run(
      `INSERT INTO streamui_file_capability (
         file_id, token_hash, state_key, session_id, file_json
       ) VALUES (?, ?, ?, ?, ?)`,
      file.id,
      capabilityHash(file.accessToken ?? ""),
      stateKey,
      sessionId,
      JSON.stringify(file)
    );
  }
}

async function getSqliteDatabase(): Promise<SqliteDatabase> {
  if (sqliteDatabase) {
    return sqliteDatabase;
  }

  await ensureSessionsDir();
  const [{ open }, sqlite3] = await Promise.all([
    import("sqlite"),
    import("sqlite3")
  ]);
  const driver = sqlite3.default?.Database ?? sqlite3.Database;
  sqliteDatabase = await open({ filename: sqliteFile, driver });
  await sqliteDatabase.exec("PRAGMA busy_timeout = 5000");
  await sqliteDatabase.exec("PRAGMA journal_mode = WAL");
  await sqliteDatabase.exec("PRAGMA synchronous = NORMAL");
  await sqliteDatabase.exec(`
    CREATE TABLE IF NOT EXISTS streamui_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS streamui_file_capability (
      file_id TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      state_key TEXT NOT NULL,
      session_id TEXT NOT NULL,
      file_json TEXT NOT NULL,
      PRIMARY KEY (file_id, token_hash),
      FOREIGN KEY (state_key) REFERENCES streamui_state(key) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS streamui_file_capability_state_idx
      ON streamui_file_capability(state_key);
  `);

  const capabilityCount = (await sqliteDatabase.get(
    "SELECT COUNT(*) AS count FROM streamui_file_capability"
  )) as { count?: number } | undefined;
  if (Number(capabilityCount?.count ?? 0) === 0) {
    const rows = (await sqliteDatabase.all(
      "SELECT key, value FROM streamui_state"
    )) as Array<{ key?: unknown; value?: unknown }>;
    for (const row of rows) {
      if (typeof row.key !== "string" || typeof row.value !== "string") {
        continue;
      }
      try {
        await rebuildSqliteCapabilities(
          sqliteDatabase,
          row.key,
          normalizeStoredSessionState(JSON.parse(row.value))
        );
      } catch (error) {
        console.warn("Could not index legacy ChatHTML file capabilities.", error);
      }
    }
  }

  return sqliteDatabase;
}

async function getPostgresPool(): Promise<Pool> {
  if (postgresReady) {
    return postgresReady;
  }

  postgresPool = new Pool({
    connectionString: databaseUrl,
    max: Math.max(
      1,
      Math.min(50, Number(process.env.CHATHTML_DATABASE_POOL_SIZE ?? 10) || 10)
    ),
    application_name: "chathtml-web"
  });
  postgresPool.on("error", (error) => {
    console.error("Unexpected ChatHTML PostgreSQL pool error.", error);
  });
  const pool = postgresPool;
  postgresReady = (async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS chathtml_state (
          state_key TEXT PRIMARY KEY,
          value JSONB NOT NULL,
          updated_at BIGINT NOT NULL
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS chathtml_file_capability (
          file_id TEXT NOT NULL,
          token_hash TEXT NOT NULL,
          state_key TEXT NOT NULL REFERENCES chathtml_state(state_key)
            ON DELETE CASCADE,
          session_id TEXT NOT NULL,
          file_json JSONB NOT NULL,
          PRIMARY KEY (file_id, token_hash)
        )
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS chathtml_file_capability_state_idx
          ON chathtml_file_capability(state_key)
      `);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return pool;
  })();
  return postgresReady;
}

function normalizedPostgresValue(value: unknown): StoredSessionState {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  return normalizeStoredSessionState(parsed);
}

async function writeSqliteState(
  state: StoredSessionState,
  stateKey: string
): Promise<void> {
  const db = await getSqliteDatabase();
  const normalized = normalizeStoredSessionState(state);
  await db.run("BEGIN IMMEDIATE");
  try {
    await db.run(
      `INSERT INTO streamui_state (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = MAX(streamui_state.updated_at + 1, excluded.updated_at)`,
      stateKey,
      JSON.stringify(normalized),
      sessionStateNow()
    );
    await rebuildSqliteCapabilities(db, stateKey, normalized);
    await db.run("COMMIT");
  } catch (error) {
    await db.run("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function rebuildPostgresCapabilities(
  client: PoolClient,
  stateKey: string,
  state: StoredSessionState
): Promise<void> {
  await client.query(
    "DELETE FROM chathtml_file_capability WHERE state_key = $1",
    [stateKey]
  );
  for (const { file, sessionId } of collectFileCapabilities(state)) {
    await client.query(
      `INSERT INTO chathtml_file_capability (
         file_id, token_hash, state_key, session_id, file_json
       ) VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (file_id, token_hash) DO UPDATE SET
         state_key = excluded.state_key,
         session_id = excluded.session_id,
         file_json = excluded.file_json`,
      [
        file.id,
        capabilityHash(file.accessToken ?? ""),
        stateKey,
        sessionId,
        JSON.stringify(file)
      ]
    );
  }
}

async function writePostgresState(
  state: StoredSessionState,
  stateKey: string
): Promise<void> {
  const context = transactionContext.getStore();
  const normalized = normalizeStoredSessionState(state);
  if (context) {
    if (context.stateKey !== stateKey) {
      throw new Error("A session transaction cannot write another user's state.");
    }
    await context.client.query(
      `INSERT INTO chathtml_state (state_key, value, updated_at)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (state_key) DO UPDATE SET
         value = excluded.value,
         updated_at = GREATEST(chathtml_state.updated_at + 1, excluded.updated_at)`,
      [stateKey, JSON.stringify(normalized), sessionStateNow()]
    );
    await rebuildPostgresCapabilities(context.client, stateKey, normalized);
    return;
  }

  await withPostgresTransaction(stateKey, async () => {
    await writePostgresState(normalized, stateKey);
  });
}

async function withPostgresTransaction<T>(
  stateKey: string,
  operation: () => Promise<T>
): Promise<T> {
  const existing = transactionContext.getStore();
  if (existing) {
    if (existing.stateKey !== stateKey) {
      throw new Error("Nested session transactions must use the same state key.");
    }
    return operation();
  }

  const pool = await getPostgresPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO chathtml_state (state_key, value, updated_at)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (state_key) DO NOTHING`,
      [
        stateKey,
        JSON.stringify(createEmptySessionState()),
        sessionStateNow()
      ]
    );
    await client.query(
      "SELECT state_key FROM chathtml_state WHERE state_key = $1 FOR UPDATE",
      [stateKey]
    );
    const result = await transactionContext.run(
      { client, stateKey },
      operation
    );
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function readSessionState(
  stateKey = DEFAULT_SESSION_STATE_KEY
): Promise<StoredSessionState> {
  return (await readSessionStateSnapshot(stateKey)).state;
}

export async function readSessionStateVersion(
  stateKey = DEFAULT_SESSION_STATE_KEY
): Promise<number | null> {
  if (getSessionRepositoryBackend() === "postgres") {
    const context = transactionContext.getStore();
    const executor = context?.client ?? (await getPostgresPool());
    const result = await executor.query(
      "SELECT updated_at FROM chathtml_state WHERE state_key = $1",
      [stateKey]
    );
    return result.rowCount ? Number(result.rows[0].updated_at) : null;
  }

  const db = await getSqliteDatabase();
  const row = (await db.get(
    "SELECT updated_at FROM streamui_state WHERE key = ?",
    stateKey
  )) as { updated_at?: unknown } | undefined;
  return row && Number.isFinite(Number(row.updated_at))
    ? Number(row.updated_at)
    : null;
}

export async function readSessionStateSnapshot(
  stateKey = DEFAULT_SESSION_STATE_KEY
): Promise<SessionStateSnapshot> {
  if (getSessionRepositoryBackend() === "postgres") {
    const context = transactionContext.getStore();
    const executor = context?.client ?? (await getPostgresPool());
    let result = await executor.query(
      "SELECT value, updated_at FROM chathtml_state WHERE state_key = $1",
      [stateKey]
    );
    if (!result.rowCount) {
      const state = createEmptySessionState();
      await executor.query(
        `INSERT INTO chathtml_state (state_key, value, updated_at)
         VALUES ($1, $2::jsonb, $3)
         ON CONFLICT (state_key) DO NOTHING`,
        [stateKey, JSON.stringify(state), sessionStateNow()]
      );
      result = await executor.query(
        "SELECT value, updated_at FROM chathtml_state WHERE state_key = $1",
        [stateKey]
      );
    }
    if (!result.rowCount) {
      throw new Error("Could not initialize the ChatHTML PostgreSQL state row.");
    }
    return {
      state: normalizedPostgresValue(result.rows[0].value),
      version: Number(result.rows[0].updated_at)
    };
  }

  const db = await getSqliteDatabase();
  let row = (await db.get(
    "SELECT value, updated_at FROM streamui_state WHERE key = ?",
    stateKey
  )) as { updated_at?: unknown; value?: unknown } | undefined;
  if (!row) {
    const legacyState =
      stateKey === DEFAULT_SESSION_STATE_KEY ? await readLegacyJsonState() : null;
    await writeSqliteState(legacyState ?? createEmptySessionState(), stateKey);
    row = (await db.get(
      "SELECT value, updated_at FROM streamui_state WHERE key = ?",
      stateKey
    )) as { updated_at?: unknown; value?: unknown } | undefined;
  }
  if (
    !row ||
    typeof row.value !== "string" ||
    !Number.isFinite(Number(row.updated_at))
  ) {
    throw new TypeError(
      `ChatHTML session row ${JSON.stringify(stateKey)} is unreadable.`
    );
  }
  return {
    state: normalizeStoredSessionState(JSON.parse(row.value)),
    version: Number(row.updated_at)
  };
}

export async function writeSessionState(
  state: StoredSessionState,
  stateKey = DEFAULT_SESSION_STATE_KEY
): Promise<void> {
  if (getSessionRepositoryBackend() === "postgres") {
    await writePostgresState(state, stateKey);
    return;
  }
  await writeSqliteState(state, stateKey);
}

export async function readAllSessionStateEntries(): Promise<
  SessionStateEntry[]
> {
  if (getSessionRepositoryBackend() === "postgres") {
    const pool = await getPostgresPool();
    const result = await pool.query(
      "SELECT state_key, value, updated_at FROM chathtml_state"
    );
    return result.rows.map((row) => ({
      stateKey: String(row.state_key),
      state: normalizedPostgresValue(row.value),
      version: Number(row.updated_at)
    }));
  }

  const db = await getSqliteDatabase();
  const rows = (await db.all(
    "SELECT key, value, updated_at FROM streamui_state"
  )) as Array<{
    key?: unknown;
    value?: unknown;
    updated_at?: unknown;
  }>;
  const entries: SessionStateEntry[] = [];
  for (const row of rows) {
    if (
      typeof row.key !== "string" ||
      typeof row.value !== "string" ||
      !Number.isFinite(Number(row.updated_at))
    ) {
      continue;
    }
    try {
      entries.push({
        stateKey: row.key,
        state: normalizeStoredSessionState(JSON.parse(row.value)),
        version: Number(row.updated_at)
      });
    } catch (error) {
      console.warn("Could not parse ChatHTML session row.", error);
    }
  }
  return entries;
}

export async function readAllSessionStates(): Promise<StoredSessionState[]> {
  return (await readAllSessionStateEntries()).map((entry) => entry.state);
}

export async function findStoredFileCapability(
  fileId: string,
  accessToken: string
): Promise<StoredFileCapability | null> {
  if (!fileId || !accessToken) {
    return null;
  }
  const tokenHash = capabilityHash(accessToken);
  if (getSessionRepositoryBackend() === "postgres") {
    const pool = await getPostgresPool();
    const result = await pool.query(
      `SELECT state_key, session_id, file_json
       FROM chathtml_file_capability
       WHERE file_id = $1 AND token_hash = $2`,
      [fileId, tokenHash]
    );
    if (!result.rowCount) {
      return null;
    }
    const row = result.rows[0];
    return {
      stateKey: row.state_key,
      sessionId: row.session_id,
      file: row.file_json as StoredSessionFile
    };
  }

  const db = await getSqliteDatabase();
  const row = (await db.get(
    `SELECT state_key, session_id, file_json
     FROM streamui_file_capability
     WHERE file_id = ? AND token_hash = ?`,
    fileId,
    tokenHash
  )) as
    | { file_json?: unknown; session_id?: unknown; state_key?: unknown }
    | undefined;
  if (
    !row ||
    typeof row.state_key !== "string" ||
    typeof row.session_id !== "string" ||
    typeof row.file_json !== "string"
  ) {
    return null;
  }
  return {
    stateKey: row.state_key,
    sessionId: row.session_id,
    file: JSON.parse(row.file_json) as StoredSessionFile
  };
}

function enqueueKeyedOperation<T>(
  stateKey: string,
  operation: () => Promise<T>
): Promise<T> {
  const backend = getSessionRepositoryBackend();
  // The local SQLite backend intentionally uses one connection and therefore
  // one write queue. PostgreSQL can safely run transactions for different
  // tenants in parallel while serializing updates to the same tenant row.
  const queueKey = backend === "postgres" ? stateKey : "sqlite:global";
  const previous = stateQueues.get(queueKey) ?? Promise.resolve();
  const queued = previous.then(() =>
    backend === "postgres" ? withPostgresTransaction(stateKey, operation) : operation()
  );
  const settled = queued.then(
    () => undefined,
    () => undefined
  );
  stateQueues.set(queueKey, settled);
  void settled.finally(() => {
    if (stateQueues.get(queueKey) === settled) {
      stateQueues.delete(queueKey);
    }
  });
  return queued;
}

export function enqueueSessionRepositoryOperation<T>(
  stateKey: string,
  operation: () => Promise<T>
): Promise<T>;
export function enqueueSessionRepositoryOperation<T>(
  operation: () => Promise<T>
): Promise<T>;
export function enqueueSessionRepositoryOperation<T>(
  stateKeyOrOperation: string | (() => Promise<T>),
  optionalOperation?: () => Promise<T>
): Promise<T> {
  const stateKey =
    typeof stateKeyOrOperation === "string"
      ? stateKeyOrOperation
      : DEFAULT_SESSION_STATE_KEY;
  const operation =
    typeof stateKeyOrOperation === "function"
      ? stateKeyOrOperation
      : optionalOperation;
  if (!operation) {
    return Promise.reject(new Error("A session repository operation is required."));
  }
  return enqueueKeyedOperation(stateKey, operation);
}

export async function closeSessionRepository(): Promise<void> {
  await Promise.all(Array.from(stateQueues.values()));
  if (sqliteDatabase) {
    const openDatabase = sqliteDatabase;
    await openDatabase.close();
    if (sqliteDatabase === openDatabase) {
      sqliteDatabase = null;
    }
  }
  if (postgresPool) {
    const openPool = postgresPool;
    postgresPool = null;
    postgresReady = null;
    await openPool.end();
  }
}

export async function checkSessionRepositoryHealth(): Promise<boolean> {
  try {
    if (getSessionRepositoryBackend() === "postgres") {
      const pool = await getPostgresPool();
      const result = await pool.query("SELECT 1 AS ok");
      return result.rows[0]?.ok === 1;
    }
    const db = await getSqliteDatabase();
    const row = (await db.get("SELECT 1 AS ok")) as { ok?: unknown } | undefined;
    return Number(row?.ok) === 1;
  } catch {
    return false;
  }
}

export async function deleteSessionState(
  stateKey: string
): Promise<void> {
  if (getSessionRepositoryBackend() === "postgres") {
    const context = transactionContext.getStore();
    const executor = context?.client ?? (await getPostgresPool());
    await executor.query(
      "DELETE FROM chathtml_file_capability WHERE state_key = $1",
      [stateKey]
    );
    await executor.query("DELETE FROM chathtml_state WHERE state_key = $1", [
      stateKey
    ]);
    return;
  }
  const db = await getSqliteDatabase();
  await db.run("DELETE FROM streamui_file_capability WHERE state_key = ?", stateKey);
  await db.run("DELETE FROM streamui_state WHERE key = ?", stateKey);
}

export async function enqueueSessionStateUpdate(
  stateKey: string,
  updater: (state: StoredSessionState) => void | StoredSessionState
): Promise<void> {
  await enqueueSessionRepositoryOperation(stateKey, async () => {
    const state = await readSessionState(stateKey);
    const updated = updater(state) ?? state;
    await writeSessionState(updated, stateKey);
  });
}

export async function enqueueSessionStateInspection(
  stateKey: string,
  inspector: (state: StoredSessionState) => void
): Promise<void> {
  await enqueueSessionRepositoryOperation(stateKey, async () => {
    inspector(await readSessionState(stateKey));
  });
}
