import Database from "better-sqlite3";
import {
  drizzle,
  type BetterSQLite3Database,
} from "drizzle-orm/better-sqlite3";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import * as schema from "./schema.js";

const CREATE_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS nonces (
    wallet_address TEXT PRIMARY KEY,
    nonce TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS intents (
    id TEXT PRIMARY KEY,
    wallet_address TEXT NOT NULL,
    intent_text TEXT NOT NULL,
    parsed_intent TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    permissions TEXT,
    delegation_manager TEXT,
    dependencies TEXT,
    cycle INTEGER NOT NULL DEFAULT 0,
    trades_executed INTEGER NOT NULL DEFAULT 0,
    total_spent_usd REAL NOT NULL DEFAULT 0,
    last_cycle_at INTEGER,
    agent_id TEXT,
    avatar_cid TEXT
  );
  CREATE TABLE IF NOT EXISTS swaps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    intent_id TEXT NOT NULL REFERENCES intents(id),
    tx_hash TEXT NOT NULL,
    sell_token TEXT NOT NULL,
    buy_token TEXT NOT NULL,
    sell_amount TEXT NOT NULL,
    status TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    evidence_cid TEXT
  );
  CREATE TABLE IF NOT EXISTS agent_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    intent_id TEXT NOT NULL REFERENCES intents(id),
    timestamp TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    action TEXT NOT NULL,
    cycle INTEGER,
    tool TEXT,
    parameters TEXT,
    result TEXT,
    duration_ms INTEGER,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_agent_logs_intent_seq
    ON agent_logs(intent_id, sequence);
  CREATE TABLE IF NOT EXISTS swap_scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    intent_id TEXT NOT NULL REFERENCES intents(id),
    swap_id INTEGER REFERENCES swaps(id),
    cycle INTEGER NOT NULL,
    composite REAL NOT NULL,
    decision_score INTEGER NOT NULL,
    decision_reasoning TEXT NOT NULL,
    execution_score INTEGER NOT NULL,
    execution_reasoning TEXT NOT NULL,
    goal_score INTEGER NOT NULL,
    goal_reasoning TEXT NOT NULL,
    outcome TEXT NOT NULL DEFAULT 'success',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_swap_scores_intent
    ON swap_scores(intent_id, cycle DESC);
`;

// Migrations for schema changes after initial creation.
// Each statement runs individually; known-safe errors are ignored.
const MIGRATIONS: { sql: string; ignoreErrors: string[] }[] = [
  // Drop old delegation columns (replaced by ERC-7715 permissions)
  { sql: `ALTER TABLE intents DROP COLUMN signed_delegation`, ignoreErrors: ["no such column"] },
  { sql: `ALTER TABLE intents DROP COLUMN delegator_smart_account`, ignoreErrors: ["no such column"] },
  { sql: `ALTER TABLE intents DROP COLUMN permissions_context`, ignoreErrors: ["no such column"] },
  // Add new ERC-7715 permission columns
  { sql: `ALTER TABLE intents ADD COLUMN permissions TEXT`, ignoreErrors: ["duplicate column"] },
  { sql: `ALTER TABLE intents ADD COLUMN delegation_manager TEXT`, ignoreErrors: ["duplicate column"] },
  { sql: `ALTER TABLE intents ADD COLUMN dependencies TEXT`, ignoreErrors: ["duplicate column"] },
  // Filecoin storage CID columns
  { sql: `ALTER TABLE intents ADD COLUMN avatar_cid TEXT`, ignoreErrors: ["duplicate column"] },
  { sql: `ALTER TABLE swaps ADD COLUMN evidence_cid TEXT`, ignoreErrors: ["duplicate column"] },
];

let _db: BetterSQLite3Database<typeof schema> | null = null;
let _sqlite: Database.Database | null = null;

export function getDb(
  dbPath = "data/maw.db",
): BetterSQLite3Database<typeof schema> {
  if (_db) return _db;

  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  _sqlite = new Database(dbPath);
  _sqlite.pragma("journal_mode = WAL");
  _sqlite.pragma("foreign_keys = ON");
  _sqlite.exec(CREATE_TABLES_SQL);

  // Run schema migrations (safe to re-run — ignores expected errors)
  for (const migration of MIGRATIONS) {
    try {
      _sqlite.exec(migration.sql);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "";
      const safe = migration.ignoreErrors.some((e) => msg.includes(e));
      if (!safe) throw err;
    }
  }

  _db = drizzle(_sqlite, { schema });
  return _db;
}

export function closeDb(): void {
  if (_sqlite) {
    _sqlite.close();
    _sqlite = null;
    _db = null;
  }
}
