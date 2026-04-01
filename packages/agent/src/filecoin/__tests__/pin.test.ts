import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../config.js", () => ({
  env: {
    FILECOIN_WALLET_PRIVATE_KEY: "0xdeadbeef",
    FILECOIN_RPC: "https://rpc.ankr.com/filecoin_testnet",
  },
}));
vi.mock("../../logging/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("viem/accounts", () => ({
  privateKeyToAccount: vi.fn().mockReturnValue({ address: "0x4F12c98c004Ff28aA1e3C230946A89430F5889F0" }),
}));

// Mock filecoin-pin to avoid network calls
const mockInitializeSynapse = vi.fn().mockResolvedValue({ mock: true });
const mockCreateCarFromPath = vi.fn().mockResolvedValue({
  carPath: "/tmp/test.car",
  rootCid: { toString: () => "bafytest123" },
});
const mockExecuteUpload = vi.fn().mockImplementation(
  (_synapse: unknown, _carData: unknown, _rootCid: unknown, opts?: { onProgress?: (event: { type: string; data?: Record<string, unknown> }) => void }) => {
    if (opts?.onProgress) {
      opts.onProgress({ type: "onPiecesAdded", data: { txHash: "0xabc123", providerId: 1n } });
      opts.onProgress({ type: "onPiecesConfirmed", data: { dataSetId: 42n, providerId: 1n, pieceIds: [1n] } });
    }
    return Promise.resolve({
      pieceCid: "baga-piece-test",
      size: 1024,
      copies: [{ dataSetId: 42n, providerId: 1n }],
      failedAttempts: [],
    });
  },
);

vi.mock("filecoin-pin", () => ({
  initializeSynapse: mockInitializeSynapse,
  createCarFromPath: mockCreateCarFromPath,
  executeUpload: mockExecuteUpload,
}));
vi.mock("filecoin-pin/core/synapse", () => ({
  calibration: { id: 314159, name: "calibration" },
}));

// Mock filecoin-pin/core/payments — getPaymentStatus + planFilecoinPayFunding + executeFilecoinPayFunding
const mockGetPaymentStatus = vi.fn().mockResolvedValue({
  walletUsdfcBalance: 10_000_000_000_000_000_000n, // 10 USDFC — above MIN threshold
  filecoinPayBalance: 0n,
  filBalance: 100_000_000_000_000_000n,
  currentAllowances: { rateUsed: 0n, lockupUsed: 0n },
});
const mockPlanFilecoinPayFunding = vi.fn().mockResolvedValue({
  plan: { delta: 0n, projected: { depositedBalance: 100n, runway: { days: 30, hours: 0 } } },
  status: { walletUsdfcBalance: 100n },
  allowances: { updated: false },
});
const mockExecuteFilecoinPayFunding = vi.fn().mockResolvedValue({
  adjusted: true,
  delta: 100n,
  newDepositedAmount: 100n,
  newRunwayDays: 30,
  newRunwayHours: 0,
});
vi.mock("filecoin-pin/core/payments", () => ({
  getPaymentStatus: mockGetPaymentStatus,
  planFilecoinPayFunding: mockPlanFilecoinPayFunding,
  executeFilecoinPayFunding: mockExecuteFilecoinPayFunding,
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    statSync: vi.fn().mockReturnValue({ size: 1024 }),
    readFileSync: vi.fn().mockReturnValue(Buffer.from("car-data")),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
});

beforeEach(() => {
  vi.resetModules();
  mockInitializeSynapse.mockClear();
  mockCreateCarFromPath.mockClear();
  mockExecuteUpload.mockClear();
  mockGetPaymentStatus.mockClear();
  mockPlanFilecoinPayFunding.mockClear();
  mockExecuteFilecoinPayFunding.mockClear();
  // Restore defaults
  mockGetPaymentStatus.mockResolvedValue({
    walletUsdfcBalance: 10_000_000_000_000_000_000n,
    filecoinPayBalance: 0n,
    filBalance: 100_000_000_000_000_000n,
    currentAllowances: { rateUsed: 0n, lockupUsed: 0n },
  });
  mockPlanFilecoinPayFunding.mockResolvedValue({
    plan: { delta: 0n, projected: { depositedBalance: 100n, runway: { days: 30, hours: 0 } } },
    status: { walletUsdfcBalance: 100n },
    allowances: { updated: false },
  });
});

describe("Filecoin Pin", () => {
  it("pinFile calls the upload pipeline and returns PinResult", async () => {
    const { pinFile } = await import("../pin.js");

    const result = await pinFile("/tmp/test-avatar.webp", {
      intentId: "test-intent",
      artifactType: "avatar",
    });

    expect(result.rootCid).toBe("bafytest123");
    expect(result.pieceCid).toBe("baga-piece-test");
    expect(result.txHash).toBe("0xabc123");
    expect(result.dataSetId).toBe(42);
  });

  it("pinBuffer writes temp file then uploads", async () => {
    const { pinBuffer } = await import("../pin.js");

    const result = await pinBuffer(
      Buffer.from('{"test":"data"}'),
      "evidence.json",
      { intentId: "test-intent", artifactType: "evidence" },
    );

    expect(result.rootCid).toBe("bafytest123");
    expect(result.pieceCid).toBe("baga-piece-test");
  });

  it("auto-deposits USDFC when plan.delta > 0", async () => {
    mockPlanFilecoinPayFunding.mockResolvedValue({
      plan: { delta: 500n, projected: { depositedBalance: 500n, runway: { days: 30, hours: 0 } } },
      status: { walletUsdfcBalance: 500n },
      allowances: { updated: true },
    });

    const { pinFile } = await import("../pin.js");

    const result = await pinFile("/tmp/test.webp", {
      intentId: "test",
      artifactType: "avatar",
    });

    expect(mockExecuteFilecoinPayFunding).toHaveBeenCalledOnce();
    expect(result.rootCid).toBe("bafytest123");
  });

  it("throws when planFilecoinPayFunding fails", { timeout: 15_000 }, async () => {
    mockPlanFilecoinPayFunding.mockRejectedValue(
      new Error("Insufficient USDFC in wallet"),
    );

    const { pinFile } = await import("../pin.js");

    await expect(
      pinFile("/tmp/test.webp", { intentId: "test", artifactType: "avatar" }),
    ).rejects.toThrow("Insufficient USDFC in wallet");
  });

  it("calls faucet when USDFC balance is below threshold", async () => {
    // Set wallet balance below 1 USDFC threshold
    mockGetPaymentStatus.mockResolvedValue({
      walletUsdfcBalance: 100_000_000_000_000_000n, // 0.1 USDFC
      filecoinPayBalance: 0n,
      filBalance: 100_000_000_000_000_000n,
      currentAllowances: { rateUsed: 0n, lockupUsed: 0n },
    });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('"0xfaucet-tx-hash"'),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { pinFile } = await import("../pin.js");
    await pinFile("/tmp/test.webp", { intentId: "test", artifactType: "avatar" });

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockFetch.mock.calls[0][0]).toContain("CalibnetUSDFC");
    expect(mockFetch.mock.calls[0][0]).toContain("0x4F12c98c004Ff28aA1e3C230946A89430F5889F0");

    vi.unstubAllGlobals();
  });
});
