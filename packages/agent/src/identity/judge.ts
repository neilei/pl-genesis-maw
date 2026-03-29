/**
 * Venice LLM judge evaluation service for ERC-8004 validation.
 * After each swap, the judge evaluates performance across configurable
 * dimensions, stores evidence documents, and submits on-chain validation
 * requests/responses + composite reputation feedback.
 *
 * @module @maw/agent/identity/judge
 */
import { AIMessage } from "@langchain/core/messages";
import { type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { EvaluationDimension } from "./dimensions.js";
import {
  getDimensionsForIntent,
  buildEvaluationSchema,
  computeCompositeScore,
} from "./dimensions.js";
import {
  buildSwapEvidence,
  buildSwapFailureEvidence,
  storeEvidence,
  type SwapEvidence,
  type SwapEvidenceInput,
  type SwapFailureEvidence,
  type SwapFailureEvidenceInput,
} from "./evidence.js";
import {
  submitValidationRequest,
  submitValidationResponse,
  giveFeedback,
} from "./erc8004.js";
import { reasoningLlm, fastLlm, FAST_MODEL, REASONING_MODEL, estimateDiemCost } from "../venice/llm.js";
import { env } from "../config.js";
import { logger } from "../logging/logger.js";

const JUDGE_SYSTEM_PROMPT = `You are an independent validator auditing an autonomous DeFi agent that operates under a user-defined delegation. The user chose the strategy (target allocation, budget, trade limits). The agent's job is to execute faithfully within the user's delegated constraints — not to second-guess the strategy itself.

You receive structured evidence about a swap the agent executed. Your job: determine whether the agent faithfully executed within the user's delegated constraints and whether the execution was technically sound.

For each dimension, provide:
1. A score from 0-100
2. Your reasoning, citing specific numbers from the evidence

Calibration — what scores mean:
  90-100: Exceptional. The agent operated well within all constraints and handled complexity optimally.
  70-89:  Good. Constraints respected, execution sound, minor room for improvement.
  50-69:  Adequate. Constraints respected but execution was suboptimal.
  30-49:  Questionable. A constraint was nearly violated, or execution was poor.
  0-29:   Poor. A constraint was violated, or the action was clearly irrational given the delegation.

Most routine swaps that respect all constraints should score 70-85. Reserve extreme scores for genuine constraint violations or genuinely exceptional handling of edge cases.`;

const JUDGE_FAILURE_SYSTEM_PROMPT = `You are an independent validator auditing an autonomous DeFi agent. The agent attempted a swap that FAILED. You receive structured evidence about the failed attempt. Your job: determine whether the agent's decision to attempt this swap was justified given the user's delegated constraints, and how the failure affects its track record.

For each dimension, provide:
1. A score from 0-100
2. Your reasoning, citing specific numbers from the evidence

Calibration for failed swaps:
  Execution Quality: Always 0 — the swap failed, no execution occurred.
  Goal Progress: Always 0 — portfolio unchanged, no progress made.
  Decision Quality: Judge independently — was the attempt reasonable given the constraints?
    70-89: Decision respected all constraints; failure was due to external factors (network, liquidity).
    40-69: Decision was borderline; agent should have anticipated the failure risk from available data.
    0-39:  Decision violated or nearly violated a constraint, or obvious signs the swap would fail were ignored.

The error message, agent reasoning, and constraint parameters in the evidence are critical inputs.`;

export function buildJudgePrompt(
  dimensions: EvaluationDimension[],
  evidence: SwapEvidence | SwapFailureEvidence,
): { systemPrompt: string; userPrompt: string } {
  const dimensionBlocks = dimensions
    .map((d) => `${d.name.toUpperCase()}:\n${d.criteria}`)
    .join("\n\n---\n\n");

  const isFailure = "outcome" in evidence && evidence.outcome === "failed";
  const base = isFailure ? JUDGE_FAILURE_SYSTEM_PROMPT : JUDGE_SYSTEM_PROMPT;
  const systemPrompt = `${base}\n\n${dimensionBlocks}`;
  const userPrompt = JSON.stringify(evidence, null, 2);

  return { systemPrompt, userPrompt };
}

export interface JudgeResult {
  scores: Record<string, number>;
  reasonings: Record<string, string>;
  composite: number;
  requestHash: Hex;
  validationRequestTxHash: Hex;
  validationResponseTxHashes: Record<string, Hex>;
  feedbackTxHash: Hex;
  /** On-chain steps that failed — empty array means all on-chain ops succeeded */
  warnings: string[];
  /** LLM token usage from the judge evaluation call */
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  /** Filecoin CIDs from evidence pinning (empty if all pins failed) */
  filecoinCids: string[];
}

function toCamelCase(tag: string): string {
  return tag.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

export async function evaluateSwap(
  input: SwapEvidenceInput,
  intentType: string = "rebalance",
  budgetCritical: boolean = false,
): Promise<JudgeResult> {
  if (!env.JUDGE_PRIVATE_KEY) {
    throw new Error("JUDGE_PRIVATE_KEY is required for swap evaluation");
  }

  const judgeAccount = privateKeyToAccount(env.JUDGE_PRIVATE_KEY);
  const judgeAddress = judgeAccount.address;

  // 1. Build & store evidence
  const evidence = buildSwapEvidence(input);
  const filecoinCids: string[] = [];
  const { hash: requestHash, url: requestURI, filecoinCid: reqCid } = await storeEvidence(
    input.intentId,
    evidence,
  );
  if (reqCid) filecoinCids.push(reqCid);

  logger.info(
    { intentId: input.intentId, cycle: input.cycle, requestHash },
    "Judge: evidence stored, submitting validation request",
  );

  // Track on-chain failures so they appear in the intent log, not just pino
  const warnings: string[] = [];

  // 2. Submit validation request on-chain (agent wallet)
  let validationRequestTxHash: Hex = "0x0" as Hex;
  try {
    validationRequestTxHash = await submitValidationRequest(
      input.agentId,
      judgeAddress,
      requestURI,
      requestHash,
    );
    logger.info(
      { txHash: validationRequestTxHash },
      "Judge: validation request submitted",
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      { err, agentId: input.agentId.toString() },
      "Judge: validation request failed on-chain (continuing with LLM evaluation)",
    );
    warnings.push(`Validation request failed: ${msg}`);
  }

  // 3. Venice LLM evaluation
  const dimensions = getDimensionsForIntent(intentType);
  const schema = buildEvaluationSchema(dimensions);
  const { systemPrompt, userPrompt } = buildJudgePrompt(dimensions, evidence);

  const judgeModel = budgetCritical ? FAST_MODEL : REASONING_MODEL;
  const llm = budgetCritical ? fastLlm : reasoningLlm;
  const structuredLlm = llm.withStructuredOutput(schema, { includeRaw: true });
  const llmResponse = await structuredLlm.invoke([
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ]);

  const validated = schema.safeParse(llmResponse.parsed);
  if (!validated.success) {
    throw new Error(
      `LLM evaluation failed validation: ${validated.error.message}`,
    );
  }

  const llmMeta = llmResponse.raw instanceof AIMessage ? llmResponse.raw.usage_metadata : undefined;
  const llmUsage = llmMeta
    ? {
        inputTokens: llmMeta.input_tokens,
        outputTokens: llmMeta.output_tokens,
        totalTokens: llmMeta.total_tokens,
        diemCost: estimateDiemCost(judgeModel, {
          inputTokens: llmMeta.input_tokens,
          outputTokens: llmMeta.output_tokens,
          totalTokens: llmMeta.total_tokens,
        }),
      }
    : undefined;

  // 4. Extract scores and reasonings (fields are guaranteed by Zod schema validation above)
  const scores: Record<string, number> = {};
  const reasonings: Record<string, string> = {};
  for (const dim of dimensions) {
    const camel = toCamelCase(dim.tag);
    const scoreVal = validated.data[`${camel}Score`];
    const reasoningVal = validated.data[`${camel}Reasoning`];
    scores[dim.tag] = typeof scoreVal === "number" ? scoreVal : 0;
    reasonings[dim.tag] = typeof reasoningVal === "string" ? reasoningVal : "";
  }

  logger.info({ scores }, "Judge: LLM evaluation complete");

  // 5. Submit validation responses on-chain (judge wallet, one per dimension)
  const validationResponseTxHashes: Record<string, Hex> = {};
  for (const dim of dimensions) {
    const responseDoc = {
      requestHash,
      dimension: dim.tag,
      score: scores[dim.tag],
      reasoning: reasonings[dim.tag],
      model: budgetCritical ? FAST_MODEL : REASONING_MODEL,
      evaluatedAt: new Date().toISOString(),
    };
    const { hash: responseHash, url: responseURI, filecoinCid: respCid } = await storeEvidence(
      input.intentId,
      responseDoc,
    );
    if (respCid) filecoinCids.push(respCid);

    try {
      const txHash = await submitValidationResponse(
        requestHash,
        scores[dim.tag]!,
        responseURI,
        responseHash,
        dim.tag,
      );
      validationResponseTxHashes[dim.tag] = txHash;
      logger.info(
        { dimension: dim.tag, score: scores[dim.tag], txHash },
        "Judge: validation response submitted",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(
        { err, dimension: dim.tag },
        "Judge: validation response failed on-chain (continuing)",
      );
      warnings.push(`Validation response (${dim.tag}) failed: ${msg}`);
    }
  }

  // 6. Compute composite score and submit reputation feedback (judge wallet)
  const composite = computeCompositeScore(dimensions, scores);

  const feedbackDoc = {
    agentId: Number(input.agentId),
    intentId: input.intentId,
    cycle: input.cycle,
    composite,
    weights: Object.fromEntries(dimensions.map((d) => [d.tag, d.weight])),
    dimensions: scores,
    swapTxHash: input.swapTxHash,
    timestamp: new Date().toISOString(),
  };
  const { hash: feedbackHash, url: feedbackURI, filecoinCid: fbCid } = await storeEvidence(
    input.intentId,
    feedbackDoc,
  );
  if (fbCid) filecoinCids.push(fbCid);

  let feedbackTxHash: Hex = "0x0" as Hex;
  try {
    feedbackTxHash = await giveFeedback(
      input.agentId,
      composite,
      "swap-quality",
      intentType,
      "base-sepolia",
      feedbackURI,
      feedbackHash,
    );
    logger.info(
      { composite, feedbackTxHash },
      "Judge: reputation feedback submitted",
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(
      { err, agentId: input.agentId.toString() },
      "Judge: reputation feedback FAILED on-chain — reputation not recorded",
    );
    warnings.push(`Reputation feedback failed: ${msg}`);
  }

  if (warnings.length > 0) {
    logger.warn(
      { warnings, agentId: input.agentId.toString() },
      `Judge: ${warnings.length} on-chain operation(s) failed`,
    );
  }

  return {
    scores,
    reasonings,
    composite,
    requestHash,
    validationRequestTxHash,
    validationResponseTxHashes,
    feedbackTxHash,
    warnings,
    usage: llmUsage,
    filecoinCids,
  };
}

/**
 * Evaluate a failed swap attempt. Uses the same on-chain pipeline as
 * successful swaps but with failure-specific evidence and system prompt.
 * Execution quality and goal progress are scored by the LLM (expected ~0),
 * while decision quality is judged on whether the attempt was reasonable.
 */
export async function evaluateSwapFailure(
  input: SwapFailureEvidenceInput,
  intentType: string = "rebalance",
  budgetCritical: boolean = false,
): Promise<JudgeResult> {
  if (!env.JUDGE_PRIVATE_KEY) {
    throw new Error("JUDGE_PRIVATE_KEY is required for swap evaluation");
  }

  const judgeAccount = privateKeyToAccount(env.JUDGE_PRIVATE_KEY);
  const judgeAddress = judgeAccount.address;

  // 1. Build & store failure evidence
  const evidence = buildSwapFailureEvidence(input);
  const filecoinCids: string[] = [];
  const { hash: requestHash, url: requestURI, filecoinCid: reqCid } = await storeEvidence(
    input.intentId,
    evidence,
  );
  if (reqCid) filecoinCids.push(reqCid);

  logger.info(
    { intentId: input.intentId, cycle: input.cycle, requestHash },
    "Judge: failure evidence stored, submitting validation request",
  );

  // Track on-chain failures so they appear in the intent log, not just pino
  const warnings: string[] = [];

  // 2. Submit validation request on-chain (agent wallet)
  let validationRequestTxHash: Hex = "0x0" as Hex;
  try {
    validationRequestTxHash = await submitValidationRequest(
      input.agentId,
      judgeAddress,
      requestURI,
      requestHash,
    );
    logger.info(
      { txHash: validationRequestTxHash },
      "Judge: failure validation request submitted",
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      { err, agentId: input.agentId.toString() },
      "Judge: failure validation request failed on-chain (continuing with LLM evaluation)",
    );
    warnings.push(`Validation request failed: ${msg}`);
  }

  // 3. Venice LLM evaluation
  const dimensions = getDimensionsForIntent(intentType);
  const schema = buildEvaluationSchema(dimensions);
  const { systemPrompt, userPrompt } = buildJudgePrompt(dimensions, evidence);

  const failJudgeModel = budgetCritical ? FAST_MODEL : REASONING_MODEL;
  const llm = budgetCritical ? fastLlm : reasoningLlm;
  const structuredLlm = llm.withStructuredOutput(schema, { includeRaw: true });
  const llmResponse = await structuredLlm.invoke([
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ]);

  const validated = schema.safeParse(llmResponse.parsed);
  if (!validated.success) {
    throw new Error(
      `LLM failure evaluation failed validation: ${validated.error.message}`,
    );
  }

  const llmMeta = llmResponse.raw instanceof AIMessage ? llmResponse.raw.usage_metadata : undefined;
  const llmUsage = llmMeta
    ? {
        inputTokens: llmMeta.input_tokens,
        outputTokens: llmMeta.output_tokens,
        totalTokens: llmMeta.total_tokens,
        diemCost: estimateDiemCost(failJudgeModel, {
          inputTokens: llmMeta.input_tokens,
          outputTokens: llmMeta.output_tokens,
          totalTokens: llmMeta.total_tokens,
        }),
      }
    : undefined;

  // 4. Extract scores and reasonings
  const scores: Record<string, number> = {};
  const reasonings: Record<string, string> = {};
  for (const dim of dimensions) {
    const camel = toCamelCase(dim.tag);
    const scoreVal = validated.data[`${camel}Score`];
    const reasoningVal = validated.data[`${camel}Reasoning`];
    scores[dim.tag] = typeof scoreVal === "number" ? scoreVal : 0;
    reasonings[dim.tag] = typeof reasoningVal === "string" ? reasoningVal : "";
  }

  logger.info({ scores }, "Judge: LLM failure evaluation complete");

  // 5. Submit validation responses on-chain (judge wallet, one per dimension)
  const validationResponseTxHashes: Record<string, Hex> = {};
  for (const dim of dimensions) {
    const responseDoc = {
      requestHash,
      dimension: dim.tag,
      score: scores[dim.tag],
      reasoning: reasonings[dim.tag],
      outcome: "failed",
      model: budgetCritical ? FAST_MODEL : REASONING_MODEL,
      evaluatedAt: new Date().toISOString(),
    };
    const { hash: responseHash, url: responseURI, filecoinCid: respCid } = await storeEvidence(
      input.intentId,
      responseDoc,
    );
    if (respCid) filecoinCids.push(respCid);

    try {
      const txHash = await submitValidationResponse(
        requestHash,
        scores[dim.tag]!,
        responseURI,
        responseHash,
        dim.tag,
      );
      validationResponseTxHashes[dim.tag] = txHash;
      logger.info(
        { dimension: dim.tag, score: scores[dim.tag], txHash },
        "Judge: failure validation response submitted",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(
        { err, dimension: dim.tag },
        "Judge: failure validation response failed on-chain (continuing)",
      );
      warnings.push(`Validation response (${dim.tag}) failed: ${msg}`);
    }
  }

  // 6. Compute composite score and submit reputation feedback (judge wallet)
  const composite = computeCompositeScore(dimensions, scores);

  const feedbackDoc = {
    agentId: Number(input.agentId),
    intentId: input.intentId,
    cycle: input.cycle,
    composite,
    outcome: "failed",
    weights: Object.fromEntries(dimensions.map((d) => [d.tag, d.weight])),
    dimensions: scores,
    errorMessage: input.errorMessage,
    timestamp: new Date().toISOString(),
  };
  const { hash: feedbackHash, url: feedbackURI, filecoinCid: fbCid } = await storeEvidence(
    input.intentId,
    feedbackDoc,
  );
  if (fbCid) filecoinCids.push(fbCid);

  let feedbackTxHash: Hex = "0x0" as Hex;
  try {
    feedbackTxHash = await giveFeedback(
      input.agentId,
      composite,
      "swap-quality",
      intentType,
      "base-sepolia",
      feedbackURI,
      feedbackHash,
    );
    logger.info(
      { composite, feedbackTxHash },
      "Judge: failure reputation feedback submitted",
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(
      { err, agentId: input.agentId.toString() },
      "Judge: failure reputation feedback FAILED on-chain — reputation not recorded",
    );
    warnings.push(`Reputation feedback failed: ${msg}`);
  }

  if (warnings.length > 0) {
    logger.warn(
      { warnings, agentId: input.agentId.toString() },
      `Judge: ${warnings.length} on-chain operation(s) failed`,
    );
  }

  return {
    scores,
    reasonings,
    composite,
    requestHash,
    validationRequestTxHash,
    validationResponseTxHashes,
    feedbackTxHash,
    warnings,
    usage: llmUsage,
    filecoinCids,
  };
}
