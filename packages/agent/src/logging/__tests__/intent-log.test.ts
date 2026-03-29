import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as dbSchema from "../../db/schema.js";
import { IntentRepository } from "../../db/repository.js";
import { IntentLogger, onLogEntry } from "../intent-log.js";

const TEST_DIR = "data/logs";
const TEST_INTENT_ID = "test-intent-123";

describe("IntentLogger", () => {
  let logger: IntentLogger;

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    logger = new IntentLogger(TEST_INTENT_ID, TEST_DIR);
  });

  afterEach(() => {
    const path = `${TEST_DIR}/${TEST_INTENT_ID}.jsonl`;
    if (existsSync(path)) rmSync(path);
  });

  it("writes a log entry to the intent-specific JSONL file", () => {
    logger.log("test_action", { tool: "test-tool" });

    const path = `${TEST_DIR}/${TEST_INTENT_ID}.jsonl`;
    const content = readFileSync(path, "utf-8").trim();
    const entry = JSON.parse(content);

    expect(entry.action).toBe("test_action");
    expect(entry.tool).toBe("test-tool");
    expect(entry.timestamp).toBeDefined();
    expect(entry.sequence).toBe(0);
  });

  it("increments sequence number", () => {
    logger.log("first");
    logger.log("second");

    const path = `${TEST_DIR}/${TEST_INTENT_ID}.jsonl`;
    const lines = readFileSync(path, "utf-8").trim().split("\n");
    expect(JSON.parse(lines[0]).sequence).toBe(0);
    expect(JSON.parse(lines[1]).sequence).toBe(1);
  });

  it("includes cycle when provided", () => {
    logger.log("cycle_action", { cycle: 5 });

    const path = `${TEST_DIR}/${TEST_INTENT_ID}.jsonl`;
    const entry = JSON.parse(readFileSync(path, "utf-8").trim());
    expect(entry.cycle).toBe(5);
  });

  it("reads all entries back", () => {
    logger.log("a");
    logger.log("b");
    logger.log("c");

    const entries = logger.readAll();
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.action)).toEqual(["a", "b", "c"]);
  });

  it("readAll returns empty array if file does not exist", () => {
    const freshLogger = new IntentLogger("nonexistent", TEST_DIR);
    expect(freshLogger.readAll()).toEqual([]);
  });

  it("getFilePath returns correct path", () => {
    expect(logger.getFilePath()).toBe(`${TEST_DIR}/${TEST_INTENT_ID}.jsonl`);
  });

  it("emits log events via onLogEntry", () => {
    const received: { intentId: string; entry: ReturnType<typeof logger.log> }[] = [];
    const unsub = onLogEntry((intentId, entry) => {
      received.push({ intentId, entry });
    });

    logger.log("test_event", { cycle: 1 });
    logger.log("another_event");

    unsub();

    expect(received).toHaveLength(2);
    expect(received[0].intentId).toBe(TEST_INTENT_ID);
    expect(received[0].entry.action).toBe("test_event");
    expect(received[0].entry.cycle).toBe(1);
    expect(received[1].entry.action).toBe("another_event");
  });

  it("unsubscribe stops receiving events", () => {
    const received: unknown[] = [];
    const unsub = onLogEntry((_id, entry) => {
      received.push(entry);
    });

    logger.log("before_unsub");
    unsub();
    logger.log("after_unsub");

    expect(received).toHaveLength(1);
  });
});

const DB_CREATE_TABLES_SQL = `
  CREATE TABLE nonces (
    wallet_address TEXT PRIMARY KEY,
    nonce TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE intents (
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
  CREATE TABLE swaps (
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
  CREATE TABLE agent_logs (
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
`;

const NOW = Math.floor(Date.now() / 1000);
const DB_SAMPLE_INTENT = {
  id: TEST_INTENT_ID,
  walletAddress: "0x1234",
  intentText: "test",
  parsedIntent: "{}",
  status: "active" as const,
  createdAt: NOW,
  expiresAt: NOW + 86400,
  permissions: JSON.stringify([{ type: "native-token-periodic", context: "0xdeadbeef", token: "ETH" }]),
  delegationManager: "0x0000000000000000000000000000000000000001",
  dependencies: JSON.stringify([]),
};

describe("IntentLogger with DB", () => {
  let dbLogger: IntentLogger;
  let repo: IntentRepository;
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    sqlite.exec(DB_CREATE_TABLES_SQL);
    const db = drizzle(sqlite, { schema: dbSchema });
    repo = new IntentRepository(db);
    repo.createIntent(DB_SAMPLE_INTENT);

    dbLogger = new IntentLogger(TEST_INTENT_ID, TEST_DIR, repo);
  });

  afterEach(() => {
    sqlite.close();
    const path = `${TEST_DIR}/${TEST_INTENT_ID}.jsonl`;
    if (existsSync(path)) rmSync(path);
  });

  it("writes to both JSONL file and SQLite", () => {
    dbLogger.log("dual_write_test", { cycle: 3, tool: "test-tool" });

    // Check JSONL file
    const path = `${TEST_DIR}/${TEST_INTENT_ID}.jsonl`;
    const fileContent = readFileSync(path, "utf-8").trim();
    const fileEntry = JSON.parse(fileContent);
    expect(fileEntry.action).toBe("dual_write_test");

    // Check SQLite
    const dbLogs = repo.getIntentLogs(TEST_INTENT_ID);
    expect(dbLogs).toHaveLength(1);
    expect(dbLogs[0].action).toBe("dual_write_test");
    expect(dbLogs[0].cycle).toBe(3);
    expect(dbLogs[0].tool).toBe("test-tool");
  });

  it("stores JSON blobs for parameters and result", () => {
    dbLogger.log("with_json", {
      parameters: { key: "value" },
      result: { data: [1, 2, 3] },
    });

    const dbLogs = repo.getIntentLogs(TEST_INTENT_ID);
    expect(dbLogs).toHaveLength(1);
    expect(JSON.parse(dbLogs[0].parameters!)).toEqual({ key: "value" });
    expect(JSON.parse(dbLogs[0].result!)).toEqual({ data: [1, 2, 3] });
  });

  it("works without repo (JSONL-only fallback)", () => {
    const fileOnlyLogger = new IntentLogger(TEST_INTENT_ID, TEST_DIR);
    fileOnlyLogger.log("file_only");

    const path = `${TEST_DIR}/${TEST_INTENT_ID}.jsonl`;
    const content = readFileSync(path, "utf-8").trim();
    expect(JSON.parse(content).action).toBe("file_only");
  });

  it("resumes sequence from max existing DB sequence on construction", () => {
    // Simulate a previous run that logged 5 entries (sequences 0-4)
    for (let i = 0; i < 5; i++) {
      repo.insertLog({
        intentId: TEST_INTENT_ID,
        timestamp: `2026-03-18T12:0${i}:00Z`,
        sequence: i,
        action: `old_action_${i}`,
      });
    }

    // Create a new logger (simulating worker restart)
    const resumedLogger = new IntentLogger(TEST_INTENT_ID, TEST_DIR, repo);
    resumedLogger.log("resumed_action");

    const dbLogs = repo.getIntentLogs(TEST_INTENT_ID);
    const lastLog = dbLogs[dbLogs.length - 1];
    expect(lastLog.action).toBe("resumed_action");
    expect(lastLog.sequence).toBe(5); // Should be max(0-4) + 1 = 5
  });

  it("starts at 0 when no existing logs in DB", () => {
    // dbLogger was created with an empty DB — should start at 0
    dbLogger.log("first");
    const dbLogs = repo.getIntentLogs(TEST_INTENT_ID);
    expect(dbLogs[0].sequence).toBe(0);
  });
});
