/**
 * Filecoin Pin integration — pins files and buffers to Filecoin
 * Calibration testnet via filecoin-pin (Synapse SDK).
 *
 * @module @maw/agent/filecoin/pin
 */
import { readFileSync, statSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { env } from "../config.js";
import { logger } from "../logging/logger.js";

export interface PinResult {
  rootCid: string;
  pieceCid: string;
  dataSetId: number;
  txHash: string;
}

const MAX_RETRIES = 2;
const BASE_DELAY_MS = 3_000;

// Lazy-initialized Synapse instance — kept as `unknown` to avoid importing
// @filoz/synapse-sdk types directly (they're transitive through filecoin-pin).
let synapseInstance: unknown = null;
let synapseInitPromise: Promise<unknown> | null = null;

async function getSynapse(): Promise<unknown> {
  if (synapseInstance) return synapseInstance;
  if (synapseInitPromise) return synapseInitPromise;

  synapseInitPromise = (async () => {
    const { initializeSynapse } = await import("filecoin-pin");
    const { calibration } = await import("filecoin-pin/core/synapse");
    logger.info("Initializing Filecoin Pin client (Calibration testnet)");
    const synapse = await initializeSynapse({
      privateKey: env.FILECOIN_WALLET_PRIVATE_KEY,
      rpcUrl: env.FILECOIN_RPC,
      chain: calibration,
    });
    synapseInstance = synapse;
    logger.info("Filecoin Pin client initialized");
    return synapse;
  })();

  return synapseInitPromise;
}

async function pinWithRetry(
  fn: () => Promise<PinResult>,
  label: string,
): Promise<PinResult> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_RETRIES) {
        const delay = BASE_DELAY_MS * 2 ** attempt;
        logger.warn(
          { attempt, delay, error: lastError.message, label },
          "Filecoin pin attempt failed, retrying",
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

async function uploadPath(filePath: string): Promise<PinResult> {
  const synapse = await getSynapse();
  const fp = await import("filecoin-pin");
  const payments = await import("filecoin-pin/core/payments");

  const fileSize = statSync(filePath).size;

  // Auto-fund: plan and execute USDFC deposit into FilecoinPay contract.
  // checkUploadReadiness alone fails when USDFC is in the wallet but not
  // yet deposited — planFilecoinPayFunding + executeFilecoinPayFunding
  // handle both allowance setup and deposit in one shot.
  type SynapseParam = Parameters<typeof fp.executeUpload>[0];
  type PlanOpts = Parameters<typeof payments.planFilecoinPayFunding>[0];
  const planResult = await payments.planFilecoinPayFunding({
    synapse,
    targetRunwayDays: 30,
    pieceSizeBytes: fileSize,
    ensureAllowances: true,
    allowWithdraw: false,
  } as PlanOpts);

  if (planResult.plan.delta > 0n) {
    logger.info(
      { delta: planResult.plan.delta.toString(), fileSize },
      "Auto-depositing USDFC into FilecoinPay for upload",
    );
    await payments.executeFilecoinPayFunding(
      synapse as SynapseParam,
      planResult.plan,
    );
    logger.info("USDFC deposit complete");
  }

  // Create CAR from file
  const { carPath, rootCid } = await fp.createCarFromPath(filePath, { logger });

  try {
    const carData = new Uint8Array(readFileSync(carPath));

    // Capture txHash from progress events
    let capturedTxHash = "0x0";
    let capturedDataSetId = 0;

    type UploadOpts = Parameters<typeof fp.executeUpload>[3];
    const result = await fp.executeUpload(
      synapse as SynapseParam,
      carData,
      rootCid,
      {
        logger,
        contextId: `maw-pin-${Date.now()}`,
        ipniValidation: { enabled: false },
        onProgress: (event: { type: string; data?: Record<string, unknown> }) => {
          if (event.type === "onPiecesAdded" && event.data) {
            capturedTxHash = String(event.data.txHash ?? "0x0");
          }
          if (event.type === "onPiecesConfirmed" && event.data) {
            capturedDataSetId = Number(event.data.dataSetId ?? 0);
          }
        },
      } as UploadOpts,
    );

    const firstCopy = result.copies[0];
    return {
      rootCid: rootCid.toString(),
      pieceCid: result.pieceCid,
      dataSetId: capturedDataSetId || (firstCopy ? Number(firstCopy.dataSetId) : 0),
      txHash: capturedTxHash,
    };
  } finally {
    try {
      unlinkSync(carPath);
    } catch {
      // Best-effort cleanup
    }
  }
}

export async function pinFile(
  filePath: string,
  opts: { intentId: string; artifactType: "avatar" | "evidence" },
): Promise<PinResult> {
  return pinWithRetry(
    () => uploadPath(filePath),
    `pin-file-${opts.artifactType}-${opts.intentId}`,
  );
}

export async function pinBuffer(
  buffer: Buffer,
  filename: string,
  opts: { intentId: string; artifactType: "avatar" | "evidence" },
): Promise<PinResult> {
  const tempDir = join(tmpdir(), "maw-filecoin-pin");
  mkdirSync(tempDir, { recursive: true });
  const tempPath = join(tempDir, `${randomBytes(8).toString("hex")}-${filename}`);
  writeFileSync(tempPath, buffer);

  try {
    return await pinWithRetry(
      () => uploadPath(tempPath),
      `pin-buffer-${opts.artifactType}-${opts.intentId}`,
    );
  } finally {
    try {
      unlinkSync(tempPath);
    } catch {
      // Best-effort cleanup
    }
  }
}
