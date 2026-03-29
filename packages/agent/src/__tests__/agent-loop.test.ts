/**
 * Unit tests for the agent loop: drift calculation and token resolution.
 *
 * @module @maw/agent/agent-loop.test
 */
import { describe, it, expect, vi } from "vitest";

// Mock all heavy dependencies so we can import pure functions
vi.mock("../config.js", () => ({
  env: { VENICE_API_KEY: "x", VENICE_BASE_URL: "https://x", UNISWAP_API_KEY: "x", AGENT_PRIVATE_KEY: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef" },
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
}));
vi.mock("../venice/llm.js", () => ({ researchLlm: {}, reasoningLlm: {}, fastLlm: {} }));
vi.mock("../data/portfolio.js", () => ({ getPortfolioBalance: vi.fn() }));
vi.mock("../data/prices.js", () => ({ getTokenPrice: vi.fn() }));
vi.mock("../data/thegraph.js", () => ({ getPoolData: vi.fn() }));
vi.mock("../delegation/compiler.js", () => ({ compileIntent: vi.fn() }));
vi.mock("../delegation/audit.js", () => ({ generateDetailedAudit: vi.fn() }));
vi.mock("../delegation/redeemer.js", () => ({ pullNativeToken: vi.fn(), pullErc20Token: vi.fn(), deploySmartAccountIfNeeded: vi.fn() }));
vi.mock("../delegation/allowance.js", () => ({ getErc20Allowance: vi.fn().mockResolvedValue(null), getNativeAllowance: vi.fn().mockResolvedValue(null) }));
vi.mock("../uniswap/trading.js", () => ({ getQuote: vi.fn(), createSwap: vi.fn() }));
vi.mock("../logging/agent-log.js", () => ({ logAction: vi.fn(), logStart: vi.fn(), logStop: vi.fn() }));
vi.mock("../logging/budget.js", () => ({ getBudgetTier: vi.fn().mockReturnValue("normal") }));
vi.mock("../identity/erc8004.js", () => ({ registerAgent: vi.fn(), giveFeedback: vi.fn() }));
vi.mock("../identity/judge.js", () => ({ evaluateSwap: vi.fn(), evaluateSwapFailure: vi.fn() }));
vi.mock("../identity/evidence.js", () => ({ buildSwapEvidence: vi.fn(), storeEvidence: vi.fn().mockResolvedValue({ hash: "0xmock", filePath: "mock", url: "mock" }) }));
vi.mock("../filecoin/pin.js", () => ({
  pinFile: vi.fn().mockResolvedValue({ rootCid: "bafy-mock", pieceCid: "piece-mock", dataSetId: 1, txHash: "0xmock" }),
  pinBuffer: vi.fn().mockResolvedValue({ rootCid: "bafy-mock", pieceCid: "piece-mock", dataSetId: 1, txHash: "0xmock" }),
}));
vi.mock("../logging/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock("../uniswap/permit2.js", () => ({ signPermit2Data: vi.fn() }));
vi.mock("../utils/retry.js", () => ({
  withRetry: vi.fn((fn: () => Promise<unknown>) => fn()),
}));

import { calculateDrift, resolveTokenAddress, formatFeedbackPrompt } from "../agent-loop/index.js";

describe("Agent Loop - resolveTokenAddress", () => {
  it("returns NATIVE_ETH for ETH on Sepolia", () => {
    const result = resolveTokenAddress("ETH", 11155111);
    expect(result).toBe("0x0000000000000000000000000000000000000000");
  });

  it("returns WETH_BASE for ETH on Base mainnet (chain 8453)", () => {
    const result = resolveTokenAddress("ETH", 8453);
    expect(result).toBe("0x4200000000000000000000000000000000000006");
  });

  it("returns WETH_SEPOLIA for WETH on Sepolia", () => {
    const result = resolveTokenAddress("WETH", 11155111);
    expect(result).toBe("0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14");
  });

  it("returns WETH_BASE for WETH on Base", () => {
    const result = resolveTokenAddress("WETH", 8453);
    expect(result).toBe("0x4200000000000000000000000000000000000006");
  });

  it("returns USDC_SEPOLIA for USDC on Sepolia", () => {
    const result = resolveTokenAddress("USDC", 11155111);
    expect(result).toBe("0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238");
  });

  it("returns USDC_BASE for USDC on Base", () => {
    const result = resolveTokenAddress("USDC", 8453);
    expect(result).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  });

  it("is case-insensitive", () => {
    const lower = resolveTokenAddress("eth", 11155111);
    const upper = resolveTokenAddress("ETH", 11155111);
    expect(lower).toBe(upper);
  });

  it("returns fallback (USDC_SEPOLIA) for unknown token", () => {
    const result = resolveTokenAddress("UNKNOWN_TOKEN", 11155111);
    expect(result).toBe("0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238");
  });
});

describe("Agent Loop - drift calculation", () => {
  it("detects zero drift when allocations match", () => {
    const result = calculateDrift(
      { ETH: 0.6, USDC: 0.4 },
      { ETH: 0.6, USDC: 0.4 },
    );
    expect(result.maxDrift).toBe(0);
    expect(result.drift.ETH).toBe(0);
    expect(result.drift.USDC).toBe(0);
  });

  it("detects drift when allocations differ", () => {
    const result = calculateDrift(
      { ETH: 0.7, USDC: 0.3 },
      { ETH: 0.6, USDC: 0.4 },
    );
    expect(result.drift.ETH).toBeCloseTo(0.1, 10);
    expect(result.drift.USDC).toBeCloseTo(0.1, 10);
    expect(result.maxDrift).toBeCloseTo(0.1, 10);
  });

  it("handles missing tokens in current allocation", () => {
    const result = calculateDrift(
      { ETH: 1.0 },
      { ETH: 0.6, USDC: 0.4 },
    );
    expect(result.drift.USDC).toBe(0.4);
    expect(result.maxDrift).toBe(0.4);
  });

  it("calculates maxDrift correctly with asymmetric drift", () => {
    const result = calculateDrift(
      { ETH: 0.55, USDC: 0.45 },
      { ETH: 0.6, USDC: 0.4 },
    );
    expect(result.drift.ETH).toBeCloseTo(0.05, 10);
    expect(result.drift.USDC).toBeCloseTo(0.05, 10);
    expect(result.maxDrift).toBeCloseTo(0.05, 10);
  });

  it("drift below threshold means no rebalance needed", () => {
    const threshold = 0.05;
    const result = calculateDrift(
      { ETH: 0.58, USDC: 0.42 },
      { ETH: 0.6, USDC: 0.4 },
    );
    expect(result.maxDrift).toBeLessThan(threshold);
  });

  it("drift above threshold means rebalance needed", () => {
    const threshold = 0.05;
    const result = calculateDrift(
      { ETH: 0.75, USDC: 0.25 },
      { ETH: 0.6, USDC: 0.4 },
    );
    expect(result.maxDrift).toBeGreaterThan(threshold);
  });
});

describe("Agent Loop - formatFeedbackPrompt", () => {
  it("returns empty string when no scores exist", () => {
    expect(formatFeedbackPrompt([])).toBe("");
  });

  it("formats a single score entry", () => {
    const scores = [{
      id: 1,
      intentId: "test",
      swapId: null,
      cycle: 3,
      composite: 75.5,
      decisionScore: 80,
      decisionReasoning: "Good direction.",
      executionScore: 65,
      executionReasoning: "High slippage.",
      goalScore: 78,
      goalReasoning: "Drift reduced.",
      outcome: "success",
      createdAt: "2026-03-22T12:00:00Z",
    }];
    const result = formatFeedbackPrompt(scores);
    expect(result).toContain("PAST PERFORMANCE FEEDBACK");
    expect(result).toContain("Cycle 3 (success) -- Composite: 76/100");
    expect(result).toContain('Decision Quality (40% weight): 80 -- "Good direction."');
    expect(result).toContain('Execution Quality (30% weight): 65 -- "High slippage."');
    expect(result).toContain('Goal Progress (30% weight): 78 -- "Drift reduced."');
    expect(result).toContain("Use this feedback to improve");
  });

  it("formats multiple scores in order", () => {
    const scores = [
      {
        id: 2, intentId: "test", swapId: null, cycle: 5, composite: 85,
        decisionScore: 90, decisionReasoning: "Excellent.",
        executionScore: 80, executionReasoning: "Clean.",
        goalScore: 85, goalReasoning: "On target.",
        outcome: "success", createdAt: "2026-03-22T13:00:00Z",
      },
      {
        id: 1, intentId: "test", swapId: null, cycle: 4, composite: 40,
        decisionScore: 50, decisionReasoning: "Questionable.",
        executionScore: 0, executionReasoning: "Failed.",
        goalScore: 0, goalReasoning: "No progress.",
        outcome: "failed", createdAt: "2026-03-22T12:00:00Z",
      },
    ];
    const result = formatFeedbackPrompt(scores);
    const cycle5Pos = result.indexOf("Cycle 5");
    const cycle4Pos = result.indexOf("Cycle 4");
    expect(cycle5Pos).toBeLessThan(cycle4Pos);
    expect(result).toContain("Cycle 4 (failed)");
  });
});
