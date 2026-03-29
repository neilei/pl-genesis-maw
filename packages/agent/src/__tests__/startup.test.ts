import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema.js";
import { IntentRepository } from "../db/repository.js";
import { resumeActiveIntents } from "../startup.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite, { schema });
  sqlite.exec(`
    CREATE TABLE nonces (wallet_address TEXT PRIMARY KEY, nonce TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE intents (
      id TEXT PRIMARY KEY, wallet_address TEXT NOT NULL, intent_text TEXT NOT NULL,
      parsed_intent TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, permissions TEXT, delegation_manager TEXT,
      dependencies TEXT,
      cycle INTEGER NOT NULL DEFAULT 0, trades_executed INTEGER NOT NULL DEFAULT 0,
      total_spent_usd REAL NOT NULL DEFAULT 0, last_cycle_at INTEGER, agent_id TEXT,
      avatar_cid TEXT
    );
    CREATE TABLE swaps (
      id INTEGER PRIMARY KEY AUTOINCREMENT, intent_id TEXT NOT NULL,
      tx_hash TEXT NOT NULL, sell_token TEXT NOT NULL, buy_token TEXT NOT NULL,
      sell_amount TEXT NOT NULL, status TEXT NOT NULL, timestamp TEXT NOT NULL,
      evidence_cid TEXT
    );
  `);
  return { db, sqlite };
}

const FUTURE = Math.floor(Date.now() / 1000) + 86400;
const PAST = Math.floor(Date.now() / 1000) - 100;

const makeIntent = (id: string, expiresAt: number, status: "active" | "paused" | "completed" | "expired" | "cancelled" | "failed" = "active") => ({
  id,
  walletAddress: "0x1234",
  intentText: "test",
  parsedIntent: "{}",
  status,
  createdAt: Math.floor(Date.now() / 1000),
  expiresAt,
  permissions: JSON.stringify([{ type: "native-token-periodic", context: "0xdeadbeef", token: "ETH" }]),
  delegationManager: "0x0000000000000000000000000000000000000001",
  dependencies: JSON.stringify([]),
});

describe("resumeActiveIntents", () => {
  let repo: IntentRepository;
  let sqlite: Database.Database;

  beforeEach(() => {
    const testDb = createTestDb();
    repo = new IntentRepository(testDb.db);
    sqlite = testDb.sqlite;
  });

  afterEach(() => sqlite.close());

  it("marks expired intents and returns active ones", async () => {
    repo.createIntent(makeIntent("active-1", FUTURE));
    repo.createIntent(makeIntent("expired-1", PAST));
    repo.createIntent(makeIntent("cancelled-1", FUTURE, "cancelled"));

    const startFn = vi.fn().mockResolvedValue(undefined);
    const result = await resumeActiveIntents(repo, startFn, 0);

    expect(result.expired).toBe(1);
    expect(result.resumed).toBe(1);
    expect(startFn).toHaveBeenCalledWith("active-1");
    expect(repo.getIntent("expired-1")!.status).toBe("expired");
  });

  it("staggers starts with delay", async () => {
    repo.createIntent(makeIntent("a", FUTURE));
    repo.createIntent(makeIntent("b", FUTURE));

    const calls: number[] = [];
    const startFn = vi.fn().mockImplementation(async () => {
      calls.push(Date.now());
    });

    await resumeActiveIntents(repo, startFn, 100);

    expect(startFn).toHaveBeenCalledTimes(2);
    if (calls.length === 2) {
      expect(calls[1] - calls[0]).toBeGreaterThanOrEqual(80);
    }
  });

  it("handles empty database", async () => {
    const startFn = vi.fn();
    const result = await resumeActiveIntents(repo, startFn, 0);
    expect(result.expired).toBe(0);
    expect(result.resumed).toBe(0);
    expect(startFn).not.toHaveBeenCalled();
  });

  it("continues if one intent fails to start", async () => {
    repo.createIntent(makeIntent("a", FUTURE));
    repo.createIntent(makeIntent("b", FUTURE));

    let callCount = 0;
    const startFn = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw new Error("boom");
    });

    const result = await resumeActiveIntents(repo, startFn, 0);
    expect(startFn).toHaveBeenCalledTimes(2);
    expect(result.resumed).toBe(1); // only the successful one
  });
});
