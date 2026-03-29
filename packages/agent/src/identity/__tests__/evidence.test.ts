import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { buildSwapEvidence, storeEvidence } from "../evidence.js";

// Mock the filecoin pin module so unit tests don't hit the network
vi.mock("../../filecoin/pin.js", () => ({
  pinBuffer: vi.fn().mockResolvedValue({
    rootCid: "bafymock123",
    pieceCid: "bagamock456",
    dataSetId: 1,
    txHash: "0xmocktx",
  }),
}));

const TEST_DIR = "data/evidence/test-intent";

describe("evidence", () => {
  beforeEach(() => { mkdirSync(TEST_DIR, { recursive: true }); });
  afterEach(() => { rmSync("data/evidence/test-intent", { recursive: true, force: true }); });

  it("buildSwapEvidence creates complete evidence object", () => {
    const evidence = buildSwapEvidence({
      agentId: 42n,
      intentId: "test-intent",
      cycle: 7,
      swapTxHash: "0xabc",
      intent: {
        targetAllocation: { ETH: 0.6, USDC: 0.4 },
        dailyBudgetUsd: 200,
        driftThreshold: 0.05,
        maxSlippage: 0.005,
        timeWindowDays: 7,
        maxTradesPerDay: 10,
        maxPerTradeUsd: 200,
      },
      beforeSwap: { allocation: { ETH: 0.73, USDC: 0.27 }, drift: 0.13, portfolioValueUsd: 1850 },
      afterSwap: { allocation: { ETH: 0.61, USDC: 0.39 }, drift: 0.01, portfolioValueUsd: 1847 },
      execution: {
        sellToken: "ETH",
        buyToken: "USDC",
        sellAmount: "0.05",
        gasUsed: 185000,
        slippage: 0.003,
        viaDelegation: true,
      },
      agentReasoning: "Drift exceeded threshold",
      marketContext: { ethPriceUsd: 2450, poolTvlUsd: 2100000, pool24hVolume: 890000 },
    });

    expect(evidence.agentId).toBe(42);
    expect(evidence.cycle).toBe(7);
    expect(evidence.beforeSwap.drift).toBe(0.13);
    expect(evidence.timestamp).toBeDefined();
  });

  it("storeEvidence writes JSON and returns hash", async () => {
    const doc = { test: "data", agentId: 1 };
    const { hash, filePath } = await storeEvidence("test-intent", doc);

    expect(hash).toMatch(/^0x[a-f0-9]{64}$/);
    expect(existsSync(filePath)).toBe(true);

    const stored = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(stored).toEqual(doc);
  });

  it("storeEvidence returns consistent hash for same content", async () => {
    const doc = { test: "deterministic" };
    const { hash: h1 } = await storeEvidence("test-intent", doc);
    const { hash: h2 } = await storeEvidence("test-intent", doc);
    expect(h1).toBe(h2);
  });

  it("storeEvidence returns filecoinCid when pinning succeeds", async () => {
    const doc = { test: "filecoin" };
    const { filecoinCid } = await storeEvidence("test-intent", doc);
    expect(filecoinCid).toBe("bafymock123");
  });
});
