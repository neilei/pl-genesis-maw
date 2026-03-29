/**
 * Unit tests for executeSwap safety checks: budget, per-trade limit, trade count.
 *
 * @module @maw/agent/swap-safety.test
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock all external dependencies so we can test safety checks in isolation
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
}));
vi.mock("../delegation/redeemer.js", () => ({ pullNativeToken: vi.fn(), pullErc20Token: vi.fn(), deploySmartAccountIfNeeded: vi.fn() }));
vi.mock("../delegation/allowance.js", () => ({ getErc20Allowance: vi.fn().mockResolvedValue(null), getNativeAllowance: vi.fn().mockResolvedValue(null) }));
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

const mockGetQuote = vi.fn();
const mockCreateSwap = vi.fn();
const mockCheckApproval = vi.fn();
vi.mock("../uniswap/trading.js", () => ({
  getQuote: (...args: unknown[]) => mockGetQuote(...args),
  createSwap: (...args: unknown[]) => mockCreateSwap(...args),
  checkApproval: (...args: unknown[]) => mockCheckApproval(...args),
}));

const mockLogAction = vi.fn();
vi.mock("../logging/agent-log.js", () => ({
  logAction: (...args: unknown[]) => mockLogAction(...args),
  logStart: vi.fn(),
  logStop: vi.fn(),
}));

import { executeSwap } from "../agent-loop/swap.js";
import type { AgentConfig, AgentState } from "../agent-loop/index.js";
import { sepolia } from "viem/chains";

function makeConfig(overrides: Partial<AgentConfig["intent"]> = {}): AgentConfig {
  return {
    intent: {
      targetAllocation: { ETH: 0.6, USDC: 0.4 },
      dailyBudgetUsd: 200,
      timeWindowDays: 7,
      maxTradesPerDay: 10,
      maxPerTradeUsd: 5,
      maxSlippage: 0.005,
      driftThreshold: 0.05,
      ...overrides,
    },
    agentKey:
      "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef" as `0x${string}`,
    chainId: 11155111,
    intentLogger: { log: vi.fn() } as unknown as AgentConfig["intentLogger"],
  } as unknown as AgentConfig;
}

function makeState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    cycle: 1,
    tradesExecuted: 0,
    totalSpentUsd: 0,
    transactions: [],
    allocation: { ETH: 0.5, USDC: 0.5 },
    drift: 0.1,
    totalValue: 1000,
    budgetTier: "normal" as const,
    ...overrides,
  } as unknown as AgentState;
}

const AGENT_ADDRESS = "0xf13021F02E23a8113C1bD826575a1682F6Fac927" as const;

describe("executeSwap safety checks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("blocks swap exceeding per-trade limit (stablecoin)", async () => {
    const config = makeConfig({ maxPerTradeUsd: 5, dailyBudgetUsd: 200 });
    const state = makeState();

    await executeSwap(
      config,
      state,
      { sellToken: "USDC", buyToken: "ETH", sellAmount: "50", maxSlippage: "0.005" },
      AGENT_ADDRESS,
      sepolia,
      2000,
    );

    // Should NOT have called getQuote — blocked by safety check
    expect(mockGetQuote).not.toHaveBeenCalled();
    // Should have logged the safety block
    expect(mockLogAction).toHaveBeenCalledWith(
      "safety_block",
      expect.objectContaining({
        result: expect.objectContaining({ reason: "per_trade_limit_exceeded" }),
      }),
    );
  });

  it("blocks swap exceeding per-trade limit (ETH, using price)", async () => {
    const config = makeConfig({ maxPerTradeUsd: 1 });
    const state = makeState();

    // Selling 0.01 ETH at $2000 = $20, which exceeds $1 limit
    await executeSwap(
      config,
      state,
      { sellToken: "ETH", buyToken: "USDC", sellAmount: "0.01", maxSlippage: "0.005" },
      AGENT_ADDRESS,
      sepolia,
      2000,
    );

    expect(mockGetQuote).not.toHaveBeenCalled();
    expect(mockLogAction).toHaveBeenCalledWith(
      "safety_block",
      expect.objectContaining({
        result: expect.objectContaining({ reason: "per_trade_limit_exceeded" }),
      }),
    );
  });

  it("does not block swap within per-trade limit", async () => {
    const config = makeConfig({ maxPerTradeUsd: 10, dailyBudgetUsd: 200 });
    const state = makeState();

    // Selling $5 USDC, under $10 limit — should NOT trigger per_trade_limit_exceeded
    // (will fail later on quote/tx, but that's fine — we verify the safety check didn't block it)
    await executeSwap(
      config,
      state,
      { sellToken: "USDC", buyToken: "ETH", sellAmount: "5", maxSlippage: "0.005" },
      AGENT_ADDRESS,
      sepolia,
      2000,
    ).catch(() => {
      // Expected: fails downstream on quote/tx — we only care about safety checks
    });

    // Verify per_trade_limit_exceeded was NOT logged
    const safetyBlocks = mockLogAction.mock.calls.filter(
      (call) => call[0] === "safety_block" && call[1]?.result?.reason === "per_trade_limit_exceeded"
    );
    expect(safetyBlocks).toHaveLength(0);
  });

  it("blocks swap exceeding total budget", async () => {
    const config = makeConfig({ dailyBudgetUsd: 100, timeWindowDays: 1, maxPerTradeUsd: 200 });
    const state = makeState({ totalSpentUsd: 90 });

    // $50 USDC would put total at $140, exceeding $100 budget
    await executeSwap(
      config,
      state,
      { sellToken: "USDC", buyToken: "ETH", sellAmount: "50", maxSlippage: "0.005" },
      AGENT_ADDRESS,
      sepolia,
      2000,
    );

    expect(mockGetQuote).not.toHaveBeenCalled();
    expect(mockLogAction).toHaveBeenCalledWith(
      "safety_block",
      expect.objectContaining({
        result: expect.objectContaining({ reason: "budget_exceeded" }),
      }),
    );
  });

  it("blocks swap when daily trade limit reached", async () => {
    const config = makeConfig({ maxTradesPerDay: 3, maxPerTradeUsd: 1000 });
    const state = makeState({ tradesExecuted: 3 });

    await executeSwap(
      config,
      state,
      { sellToken: "USDC", buyToken: "ETH", sellAmount: "1", maxSlippage: "0.005" },
      AGENT_ADDRESS,
      sepolia,
      2000,
    );

    expect(mockGetQuote).not.toHaveBeenCalled();
    expect(mockLogAction).toHaveBeenCalledWith(
      "safety_block",
      expect.objectContaining({
        result: expect.objectContaining({ reason: "trade_limit_reached" }),
      }),
    );
  });

  it("throws on insufficient ERC-20 delegation allowance before attempting pull", async () => {
    // Import and mock allowance to return insufficient amount
    const { getErc20Allowance } = await import("../delegation/allowance.js");
    const mockAllowance = vi.mocked(getErc20Allowance);
    mockAllowance.mockResolvedValueOnce({
      availableAmount: 1000000n, // 1 USDC (need 3)
      isNewPeriod: false,
      currentPeriod: 1n,
    });

    const config = makeConfig({ maxPerTradeUsd: 1000, dailyBudgetUsd: 1000 });
    const state = makeState({
      permissions: [
        { type: "erc20-token-periodic", context: "0xdeadbeef", token: "USDC" },
      ],
      delegationManager: "0xDM",
    });

    await expect(
      executeSwap(
        config,
        state,
        { sellToken: "USDC", buyToken: "ETH", sellAmount: "3", maxSlippage: "0.005" },
        AGENT_ADDRESS,
        sepolia,
        2000,
      ),
    ).rejects.toThrow("Delegation allowance insufficient");
  });
});
