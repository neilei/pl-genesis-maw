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

// Mock filecoin-pin to avoid network calls
const mockInitializeSynapse = vi.fn().mockResolvedValue({ mock: true });
const mockCheckUploadReadiness = vi.fn().mockResolvedValue({
  status: "ready",
  validation: { isValid: true },
});
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
  checkUploadReadiness: mockCheckUploadReadiness,
  createCarFromPath: mockCreateCarFromPath,
  executeUpload: mockExecuteUpload,
}));
vi.mock("filecoin-pin/core/synapse", () => ({
  calibration: { id: 314159, name: "calibration" },
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
  mockCheckUploadReadiness.mockClear();
  mockCreateCarFromPath.mockClear();
  mockExecuteUpload.mockClear();
  // Restore default mock behavior
  mockCheckUploadReadiness.mockResolvedValue({
    status: "ready",
    validation: { isValid: true },
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

  it("throws when upload readiness is blocked", { timeout: 15_000 }, async () => {
    mockCheckUploadReadiness.mockResolvedValue({
      status: "blocked",
      validation: { isValid: false, errorMessage: "insufficient USDFC" },
    });

    const { pinFile } = await import("../pin.js");

    await expect(
      pinFile("/tmp/test.webp", { intentId: "test", artifactType: "avatar" }),
    ).rejects.toThrow("Upload blocked: insufficient USDFC");
  });
});
