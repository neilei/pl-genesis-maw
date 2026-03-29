/**
 * Evidence document creation and content-addressed storage for ERC-8004
 * validation. After each swap, the agent builds an evidence document capturing
 * intent constraints, portfolio state before/after, execution details, and
 * agent reasoning. The document is stored as JSON, hashed with keccak256,
 * and referenced on-chain via the Validation Registry.
 *
 * @module @maw/agent/identity/evidence
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { keccak256, toHex, type Hex } from "viem";
import { pinBuffer } from "../filecoin/pin.js";
import { logger } from "../logging/logger.js";

const EVIDENCE_BASE_DIR = "data/evidence";
const EVIDENCE_BASE_URL = "https://api.maw.finance/api/evidence";

export interface SwapEvidenceInput {
  agentId: bigint;
  intentId: string;
  cycle: number;
  swapTxHash: string;
  intent: {
    targetAllocation: Record<string, number>;
    dailyBudgetUsd: number;
    driftThreshold: number;
    maxSlippage: number;
    timeWindowDays: number;
    maxTradesPerDay: number;
    maxPerTradeUsd: number;
  };
  beforeSwap: { allocation: Record<string, number>; drift: number; portfolioValueUsd: number };
  afterSwap: { allocation: Record<string, number>; drift: number; portfolioValueUsd: number };
  execution: {
    sellToken: string;
    buyToken: string;
    sellAmount: string;
    gasUsed: number;
    slippage: number;
    viaDelegation: boolean;
  };
  agentReasoning: string;
  marketContext: { ethPriceUsd: number; poolTvlUsd: number; pool24hVolume: number };
}

export interface SwapEvidence {
  agentId: number;
  intentId: string;
  cycle: number;
  swapTxHash: string;
  intent: SwapEvidenceInput["intent"];
  beforeSwap: SwapEvidenceInput["beforeSwap"];
  afterSwap: SwapEvidenceInput["afterSwap"];
  execution: SwapEvidenceInput["execution"];
  agentReasoning: string;
  marketContext: SwapEvidenceInput["marketContext"];
  timestamp: string;
}

/**
 * Build a structured swap evidence document from raw inputs.
 * Converts bigint agentId to number for JSON serialization and
 * stamps the current ISO timestamp.
 */
export function buildSwapEvidence(input: SwapEvidenceInput): SwapEvidence {
  return {
    agentId: Number(input.agentId),
    intentId: input.intentId,
    cycle: input.cycle,
    swapTxHash: input.swapTxHash,
    intent: input.intent,
    beforeSwap: input.beforeSwap,
    afterSwap: input.afterSwap,
    execution: input.execution,
    agentReasoning: input.agentReasoning,
    marketContext: input.marketContext,
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Swap failure evidence
// ---------------------------------------------------------------------------

export interface SwapFailureEvidenceInput {
  agentId: bigint;
  intentId: string;
  cycle: number;
  intent: SwapEvidenceInput["intent"];
  beforeSwap: SwapEvidenceInput["beforeSwap"];
  attemptedSwap: {
    sellToken: string;
    buyToken: string;
    sellAmount: string;
  };
  errorMessage: string;
  agentReasoning: string;
  marketContext: { ethPriceUsd: number };
}

export interface SwapFailureEvidence {
  agentId: number;
  intentId: string;
  cycle: number;
  outcome: "failed";
  intent: SwapEvidenceInput["intent"];
  beforeSwap: SwapEvidenceInput["beforeSwap"];
  attemptedSwap: SwapFailureEvidenceInput["attemptedSwap"];
  errorMessage: string;
  agentReasoning: string;
  marketContext: SwapFailureEvidenceInput["marketContext"];
  timestamp: string;
}

export function buildSwapFailureEvidence(input: SwapFailureEvidenceInput): SwapFailureEvidence {
  return {
    agentId: Number(input.agentId),
    intentId: input.intentId,
    cycle: input.cycle,
    outcome: "failed",
    intent: input.intent,
    beforeSwap: input.beforeSwap,
    attemptedSwap: input.attemptedSwap,
    errorMessage: input.errorMessage,
    agentReasoning: input.agentReasoning,
    marketContext: input.marketContext,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Store an evidence document as content-addressed JSON.
 * The file is named by its keccak256 hash, ensuring idempotent writes
 * and providing a verifiable on-chain reference.
 * Also pins the document to Filecoin (non-fatal if pinning fails).
 *
 * @returns The keccak256 hash, local file path, public URL, and optional Filecoin CID
 */
export async function storeEvidence<T extends object>(
  intentId: string,
  document: T,
): Promise<{ hash: Hex; filePath: string; url: string; filecoinCid?: string }> {
  const json = JSON.stringify(document, null, 2);
  const hash = keccak256(toHex(json));

  const dir = join(EVIDENCE_BASE_DIR, intentId);
  mkdirSync(dir, { recursive: true });

  const filePath = join(dir, `${hash}.json`);
  writeFileSync(filePath, json, "utf-8");

  const url = `${EVIDENCE_BASE_URL}/${intentId}/${hash}`;

  // Pin to Filecoin (non-fatal — local storage is the primary copy)
  let filecoinCid: string | undefined;
  try {
    const pinResult = await pinBuffer(
      Buffer.from(json, "utf-8"),
      `${hash}.json`,
      { intentId, artifactType: "evidence" },
    );
    filecoinCid = pinResult.rootCid;
    logger.info(
      { intentId, hash, filecoinCid },
      "Evidence pinned to Filecoin",
    );
  } catch (err) {
    logger.warn(
      { intentId, hash, error: err instanceof Error ? err.message : String(err) },
      "Failed to pin evidence to Filecoin (continuing with local storage)",
    );
  }

  return { hash, filePath, url, filecoinCid };
}
