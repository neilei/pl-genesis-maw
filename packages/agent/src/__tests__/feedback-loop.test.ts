/**
 * Integration tests for the feedback self-correction loop.
 *
 * Tests the full data flow:
 * 1. Judge evaluation produces scores → written to swap_scores table
 * 2. formatFeedbackPrompt() formats scores for the Venice prompt
 * 3. getRebalanceDecision() queries scores and injects them into the prompt
 *
 * Uses a real in-memory SQLite DB but mocks Venice LLM and on-chain calls.
 *
 * @module @maw/agent/__tests__/feedback-loop.test
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema.js";
import { IntentRepository } from "../db/repository.js";

// Mock all heavy dependencies
vi.mock("../config.js", () => ({
  env: {
    VENICE_API_KEY: "x",
    VENICE_BASE_URL: "https://x",
    UNISWAP_API_KEY: "x",
    AGENT_PRIVATE_KEY:
      "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    JUDGE_PRIVATE_KEY:
      "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
  },
  CONTRACTS: {
    NATIVE_ETH: "0x0000000000000000000000000000000000000000",
    WETH_SEPOLIA: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14",
    WETH_BASE: "0x4200000000000000000000000000000000000006",
    USDC_SEPOLIA: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    USDC_BASE: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  },
  CHAINS: {},
  UNISWAP_API_BASE: "",
  THEGRAPH_UNISWAP_V3_BASE: "",
  rpcTransport: vi.fn(),
}));
vi.mock("../venice/llm.js", () => ({
  researchLlm: {},
  reasoningLlm: {},
  fastLlm: {},
  FAST_MODEL: "fast-model",
  REASONING_MODEL: "reasoning-model",
  RESEARCH_MODEL: "research-model",
  estimateDiemCost: vi.fn().mockReturnValue(0),
}));
vi.mock("../data/portfolio.js", () => ({
  getPortfolioBalance: vi.fn(),
}));
vi.mock("../data/prices.js", () => ({ getTokenPrice: vi.fn() }));
vi.mock("../data/thegraph.js", () => ({ getPoolData: vi.fn() }));
vi.mock("../delegation/compiler.js", () => ({ compileIntent: vi.fn() }));
vi.mock("../delegation/audit.js", () => ({
  generateDetailedAudit: vi.fn(),
}));
vi.mock("../delegation/redeemer.js", () => ({
  pullNativeToken: vi.fn(),
  pullErc20Token: vi.fn(),
  deploySmartAccountIfNeeded: vi.fn(),
}));
vi.mock("../delegation/allowance.js", () => ({
  getErc20Allowance: vi.fn().mockResolvedValue(null),
  getNativeAllowance: vi.fn().mockResolvedValue(null),
}));
vi.mock("../uniswap/trading.js", () => ({
  getQuote: vi.fn(),
  createSwap: vi.fn(),
  checkApproval: vi.fn(),
}));
vi.mock("../logging/agent-log.js", () => ({
  logAction: vi.fn(),
  logStart: vi.fn(),
  logStop: vi.fn(),
}));
vi.mock("../logging/budget.js", () => ({
  getBudgetTier: vi.fn().mockReturnValue("normal"),
}));
vi.mock("../identity/erc8004.js", () => ({
  registerAgent: vi.fn(),
  giveFeedback: vi.fn(),
}));
vi.mock("../identity/judge.js", () => ({
  evaluateSwap: vi.fn(),
  evaluateSwapFailure: vi.fn(),
}));
vi.mock("../identity/evidence.js", () => ({
  buildSwapEvidence: vi.fn(),
  storeEvidence: vi.fn().mockResolvedValue({ hash: "0xmock", filePath: "mock", url: "mock" }),
}));
vi.mock("../logging/logger.js", () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));
vi.mock("../uniswap/permit2.js", () => ({ signPermit2Data: vi.fn() }));
vi.mock("../utils/retry.js", () => ({
  withRetry: vi.fn((fn: () => Promise<unknown>) => fn()),
}));

import { formatFeedbackPrompt } from "../agent-loop/index.js";
import type { AgentConfig } from "../agent-loop/index.js";

const CREATE_TABLES_SQL = `
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
  CREATE TABLE swap_scores (
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
`;

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  sqlite.exec(CREATE_TABLES_SQL);
  return { db, sqlite };
}

const NOW = Math.floor(Date.now() / 1000);
const FUTURE = NOW + 7 * 86400;

const SAMPLE_INTENT = {
  id: "feedback-test-intent",
  walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
  intentText: "60/40 ETH/USDC, $200/day, 7 days",
  parsedIntent: JSON.stringify({
    targetAllocation: { ETH: 0.6, USDC: 0.4 },
    dailyBudgetUsd: 200,
    timeWindowDays: 7,
    maxTradesPerDay: 10,
    maxPerTradeUsd: 200,
    maxSlippage: 0.005,
    driftThreshold: 0.05,
  }),
  status: "active" as const,
  createdAt: NOW,
  expiresAt: FUTURE,
  permissions: JSON.stringify([
    { type: "native-token-periodic", context: "0xdeadbeef", token: "ETH" },
  ]),
  delegationManager: "0x0000000000000000000000000000000000000001",
  dependencies: JSON.stringify([]),
};

describe("Feedback Self-Correction Loop", () => {
  let repo: IntentRepository;
  let sqlite: Database.Database;

  beforeEach(() => {
    const testDb = createTestDb();
    repo = new IntentRepository(testDb.db);
    sqlite = testDb.sqlite;
    repo.createIntent(SAMPLE_INTENT);
  });

  afterEach(() => {
    sqlite.close();
  });

  describe("score persistence round-trip", () => {
    it("scores written to DB are queryable and correctly ordered", () => {
      // Simulate 3 cycles of judge scores
      const cycles = [
        {
          cycle: 1,
          composite: 72,
          decisionScore: 75,
          decisionReasoning:
            "Trade direction correct but sell amount was large.",
          executionScore: 65,
          executionReasoning: "Slippage of 1.8% exceeded target.",
          goalScore: 78,
          goalReasoning: "Drift reduced from 8.2% to 3.1%.",
          outcome: "success",
        },
        {
          cycle: 2,
          composite: 84,
          decisionScore: 88,
          decisionReasoning: "Appropriate trade size.",
          executionScore: 79,
          executionReasoning: "Slippage within tolerance.",
          goalScore: 85,
          goalReasoning: "Meaningful drift reduction.",
          outcome: "success",
        },
        {
          cycle: 3,
          composite: 35,
          decisionScore: 50,
          decisionReasoning: "Questionable timing.",
          executionScore: 0,
          executionReasoning: "Swap reverted.",
          goalScore: 0,
          goalReasoning: "No progress — swap failed.",
          outcome: "failed",
        },
      ];

      for (const c of cycles) {
        repo.insertSwapScore({
          intentId: SAMPLE_INTENT.id,
          ...c,
          createdAt: new Date().toISOString(),
        });
      }

      const scores = repo.getRecentScores(SAMPLE_INTENT.id, 5);
      expect(scores).toHaveLength(3);
      // Should be ordered by cycle descending
      expect(scores[0].cycle).toBe(3);
      expect(scores[1].cycle).toBe(2);
      expect(scores[2].cycle).toBe(1);

      // Verify failed swap score preserved
      expect(scores[0].outcome).toBe("failed");
      expect(scores[0].executionScore).toBe(0);
    });
  });

  describe("formatFeedbackPrompt integration", () => {
    it("formats DB scores into a valid prompt section", () => {
      repo.insertSwapScore({
        intentId: SAMPLE_INTENT.id,
        cycle: 1,
        composite: 72.3,
        decisionScore: 75,
        decisionReasoning: "Trade direction correct.",
        executionScore: 65,
        executionReasoning: "Slippage was 1.8%.",
        goalScore: 78,
        goalReasoning: "Drift reduced from 8.2% to 3.1%.",
        outcome: "success",
        createdAt: new Date().toISOString(),
      });

      repo.insertSwapScore({
        intentId: SAMPLE_INTENT.id,
        cycle: 2,
        composite: 40,
        decisionScore: 50,
        decisionReasoning: "Questionable sizing.",
        executionScore: 0,
        executionReasoning: "Swap reverted.",
        goalScore: 0,
        goalReasoning: "No progress.",
        outcome: "failed",
        createdAt: new Date().toISOString(),
      });

      const scores = repo.getRecentScores(SAMPLE_INTENT.id, 5);
      const prompt = formatFeedbackPrompt(scores);

      // Verify structure
      expect(prompt).toContain("PAST PERFORMANCE FEEDBACK");
      expect(prompt).toContain("Cycle 2 (failed) -- Composite: 40/100");
      expect(prompt).toContain("Cycle 1 (success) -- Composite: 72/100");
      expect(prompt).toContain(
        'Decision Quality (40% weight): 75 -- "Trade direction correct."',
      );
      expect(prompt).toContain(
        'Execution Quality (30% weight): 0 -- "Swap reverted."',
      );
      expect(prompt).toContain("Use this feedback to improve");

      // Cycle 2 should appear before cycle 1 (descending order from DB)
      const cycle2Pos = prompt.indexOf("Cycle 2");
      const cycle1Pos = prompt.indexOf("Cycle 1");
      expect(cycle2Pos).toBeLessThan(cycle1Pos);
    });

    it("returns empty string for first cycle (no scores)", () => {
      const scores = repo.getRecentScores(SAMPLE_INTENT.id, 5);
      expect(scores).toHaveLength(0);
      expect(formatFeedbackPrompt(scores)).toBe("");
    });
  });

  describe("repo available via AgentConfig", () => {
    it("config.repo provides working insertSwapScore and getRecentScores", () => {
      // Simulate what happens in the agent loop: config.repo is the IntentRepository
      const config = {
        intentId: SAMPLE_INTENT.id,
        repo,
      } as unknown as AgentConfig;

      // Write a score (as swap.ts does after judge evaluation)
      config.repo!.insertSwapScore({
        intentId: config.intentId!,
        cycle: 1,
        composite: 80,
        decisionScore: 85,
        decisionReasoning: "Well-sized trade.",
        executionScore: 75,
        executionReasoning: "Acceptable slippage.",
        goalScore: 80,
        goalReasoning: "Good drift reduction.",
        outcome: "success",
        createdAt: new Date().toISOString(),
      });

      // Read scores (as getRebalanceDecision does)
      const scores = config.repo!.getRecentScores(config.intentId!, 5);
      expect(scores).toHaveLength(1);
      expect(scores[0].composite).toBe(80);

      // Format for prompt
      const prompt = formatFeedbackPrompt(scores);
      expect(prompt).toContain("Composite: 80/100");
    });
  });

  describe("feedback accumulation over multiple cycles", () => {
    it("limits to 5 most recent scores when more exist", () => {
      for (let i = 1; i <= 8; i++) {
        repo.insertSwapScore({
          intentId: SAMPLE_INTENT.id,
          cycle: i,
          composite: 60 + i * 3,
          decisionScore: 70 + i,
          decisionReasoning: `Cycle ${i} decision reasoning.`,
          executionScore: 60 + i * 2,
          executionReasoning: `Cycle ${i} execution reasoning.`,
          goalScore: 65 + i,
          goalReasoning: `Cycle ${i} goal reasoning.`,
          outcome: "success",
          createdAt: new Date().toISOString(),
        });
      }

      const scores = repo.getRecentScores(SAMPLE_INTENT.id, 5);
      expect(scores).toHaveLength(5);
      // Should have cycles 8,7,6,5,4 (most recent 5)
      expect(scores[0].cycle).toBe(8);
      expect(scores[4].cycle).toBe(4);

      const prompt = formatFeedbackPrompt(scores);
      // Should NOT contain cycles 1-3
      expect(prompt).not.toContain("Cycle 1 ");
      expect(prompt).not.toContain("Cycle 2 ");
      expect(prompt).not.toContain("Cycle 3 ");
      // Should contain cycles 4-8
      expect(prompt).toContain("Cycle 8");
      expect(prompt).toContain("Cycle 4");
    });

    it("includes both success and failure outcomes in feedback", () => {
      repo.insertSwapScore({
        intentId: SAMPLE_INTENT.id,
        cycle: 1,
        composite: 80,
        decisionScore: 85,
        decisionReasoning: "Good trade.",
        executionScore: 75,
        executionReasoning: "Clean execution.",
        goalScore: 80,
        goalReasoning: "On track.",
        outcome: "success",
        createdAt: new Date().toISOString(),
      });
      repo.insertSwapScore({
        intentId: SAMPLE_INTENT.id,
        cycle: 2,
        composite: 15,
        decisionScore: 30,
        decisionReasoning: "Should not have attempted.",
        executionScore: 0,
        executionReasoning: "Transaction reverted.",
        goalScore: 0,
        goalReasoning: "Portfolio unchanged.",
        outcome: "failed",
        createdAt: new Date().toISOString(),
      });

      const scores = repo.getRecentScores(SAMPLE_INTENT.id, 5);
      const prompt = formatFeedbackPrompt(scores);

      expect(prompt).toContain("(success)");
      expect(prompt).toContain("(failed)");
      expect(prompt).toContain("Composite: 15/100");
      expect(prompt).toContain("Composite: 80/100");
    });
  });

  describe("intent isolation", () => {
    it("feedback scores from one intent do not leak into another", () => {
      const otherIntent = {
        ...SAMPLE_INTENT,
        id: "other-intent",
      };
      repo.createIntent(otherIntent);

      // Write scores to both intents
      repo.insertSwapScore({
        intentId: SAMPLE_INTENT.id,
        cycle: 1,
        composite: 90,
        decisionScore: 95,
        decisionReasoning: "Excellent for intent A.",
        executionScore: 85,
        executionReasoning: "Clean.",
        goalScore: 90,
        goalReasoning: "Perfect.",
        outcome: "success",
        createdAt: new Date().toISOString(),
      });

      repo.insertSwapScore({
        intentId: otherIntent.id,
        cycle: 1,
        composite: 30,
        decisionScore: 25,
        decisionReasoning: "Poor for intent B.",
        executionScore: 10,
        executionReasoning: "Failed.",
        goalScore: 15,
        goalReasoning: "No progress.",
        outcome: "failed",
        createdAt: new Date().toISOString(),
      });

      // Each intent should only see its own scores
      const scoresA = repo.getRecentScores(SAMPLE_INTENT.id, 5);
      const scoresB = repo.getRecentScores(otherIntent.id, 5);

      expect(scoresA).toHaveLength(1);
      expect(scoresA[0].composite).toBe(90);

      expect(scoresB).toHaveLength(1);
      expect(scoresB[0].composite).toBe(30);

      // Prompt for intent A should not mention intent B's scores
      const promptA = formatFeedbackPrompt(scoresA);
      expect(promptA).toContain("Excellent for intent A.");
      expect(promptA).not.toContain("Poor for intent B.");
    });
  });
});
