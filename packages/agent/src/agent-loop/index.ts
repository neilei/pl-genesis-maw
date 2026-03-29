/**
 * Main agent orchestrator. Compiles intent into a delegation, then runs a monitoring
 * loop: check drift, reason via Venice, quote and execute swaps on Uniswap, log
 * results. Exposes singleton state for the dashboard server.
 *
 * @module @maw/agent/agent-loop
 */
import type { SwapRecord } from "@maw/common";
import { AIMessage } from "@langchain/core/messages";
import { type Address, type Hex, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia, base } from "viem/chains";
import { env } from "../config.js";
import type { IntentParse } from "../venice/schemas.js";
import { RebalanceDecisionSchema } from "../venice/schemas.js";
import { reasoningLlm, fastLlm, FAST_MODEL, RESEARCH_MODEL, REASONING_MODEL, estimateDiemCost } from "../venice/llm.js";
import { detectAdversarialIntent } from "@maw/common";
import { compileIntent } from "../delegation/compiler.js";
import { generateDetailedAudit, type DetailedAuditReport } from "../delegation/audit.js";
import { logAction, logStart, logStop } from "../logging/agent-log.js";
import { getBudgetTier } from "../logging/budget.js";
import { registerAgent } from "../identity/erc8004.js";
import { generateAgentAvatar, avatarPath } from "../venice/image.js";
import { existsSync } from "node:fs";
import { logger } from "../logging/logger.js";
import { withRetry } from "../utils/retry.js";
import { pinFile } from "../filecoin/pin.js";

import { gatherMarketData, type MarketData } from "./market-data.js";
import { executeSwap } from "./swap.js";
import { getErc20Allowance, getNativeAllowance } from "../delegation/allowance.js";
import { evaluateSwapFailure } from "../identity/judge.js";
import type { SwapFailureEvidenceInput } from "../identity/evidence.js";

// Re-export extracted modules for convenience
export { gatherMarketData, type MarketData } from "./market-data.js";
export { executeSwap, resolveTokenAddress } from "./swap.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentConfig {
  intent: IntentParse;
  agentKey: `0x${string}`;
  chainId: number;
  intervalMs: number;
  /** ERC-7715 permissions granted by user in MetaMask Flask */
  permissions: { type: string; context: string; token: string }[];
  /** DelegationManager contract address from permission response */
  delegationManager: string;
  /** Factory deployment info for user's smart account */
  dependencies: { factory: string; factoryData: string }[];
  maxCycles?: number;
  /** Signal to abort the loop from outside (e.g. worker stop) */
  signal?: AbortSignal;
  /** Called after each cycle with the current state for external persistence */
  onCycleComplete?: (state: AgentState) => void;
  /** Per-intent logger for writing cycle data to intent-specific JSONL */
  intentLogger?: import("../logging/intent-log.js").IntentLogger;
  /** Intent ID for per-intent registration URI */
  intentId?: string;
  /** Pre-existing ERC-8004 agent ID from database (persisted from previous run) */
  existingAgentId?: bigint;
  /** Callback to persist newly registered agentId to database */
  onAgentIdRegistered?: (agentId: string) => void;
  /** Resume from a previous cycle count (persisted from DB on restart) */
  initialCycle?: number;
  /** Resume from a previous trade count */
  initialTradesExecuted?: number;
  /** Resume from a previous total spent */
  initialTotalSpentUsd?: number;
  /** Repository for reading/writing swap scores (feedback loop) */
  repo?: import("../db/repository.js").IntentRepository;
}

export interface AgentState {
  permissions: { type: string; context: string; token: string }[];
  delegationManager: string;
  dependencies: { factory: string; factoryData: string }[];
  tradesExecuted: number;
  totalSpentUsd: number;
  running: boolean;
  cycle: number;
  // Live data exposed for dashboard
  ethPrice: number;
  drift: number;
  allocation: Record<string, number>;
  totalValue: number;
  budgetTier: string;
  transactions: SwapRecord[];
  audit: DetailedAuditReport | null;
  agentId: bigint | null;
  deployError: string | null;
  /** Tracks which cycle was last judged (prevents double-judging) */
  lastCycleJudged?: number;
}

// ---------------------------------------------------------------------------
// Drift calculation (exported for testing)
// ---------------------------------------------------------------------------

export function calculateDrift(
  currentAllocation: Record<string, number>,
  targetAllocation: Record<string, number>,
): { drift: Record<string, number>; maxDrift: number } {
  const drift: Record<string, number> = {};
  let maxDrift = 0;

  for (const token of Object.keys(targetAllocation)) {
    const current = currentAllocation[token] ?? 0;
    const target = targetAllocation[token]!;
    const d = Math.abs(current - target);
    drift[token] = d;
    if (d > maxDrift) maxDrift = d;
  }

  return { drift, maxDrift };
}

// ---------------------------------------------------------------------------
// Agent Loop
// ---------------------------------------------------------------------------

export async function runAgentLoop(config: AgentConfig): Promise<AgentState> {
  const agentAccount = privateKeyToAccount(config.agentKey);
  const agentAddress = agentAccount.address;
  const chain = config.chainId === 8453 ? base : sepolia;

  const state: AgentState = {
    permissions: config.permissions,
    delegationManager: config.delegationManager,
    dependencies: config.dependencies,
    tradesExecuted: config.initialTradesExecuted ?? 0,
    totalSpentUsd: config.initialTotalSpentUsd ?? 0,
    running: true,
    cycle: config.initialCycle ?? 0,
    ethPrice: 0,
    drift: 0,
    allocation: {},
    totalValue: 0,
    budgetTier: "normal",
    transactions: [],
    audit: null,
    agentId: null,
    deployError: null,
  };

  logStart();

  // Log privacy guarantee — Venice no-data-retention policy
  logAction("privacy_guarantee", {
    tool: "venice-inference",
    result: {
      provider: "venice.ai",
      dataRetention: "none",
      includeVeniceSystemPrompt: false,
      modelsUsed: [FAST_MODEL, RESEARCH_MODEL, REASONING_MODEL],
      rationale: "DeFi reasoning traces contain alpha-sensitive portfolio data; no-retention inference prevents strategy leakage",
    },
  });
  config.intentLogger?.log("privacy_guarantee", {
    tool: "venice-inference",
    result: { provider: "venice.ai", dataRetention: "none", modelsUsed: [FAST_MODEL, RESEARCH_MODEL, REASONING_MODEL] },
  });

  // Generate unique avatar image for this agent.
  // Awaited so the avatar is ready before ERC-8004 registration — identity.json
  // serves the avatar URL, and 8004scan fetches it immediately after registration.
  if (config.intentId) {
    const existingAvatar = avatarPath(config.intentId);
    if (existsSync(existingAvatar)) {
      logger.info({ intentId: config.intentId }, "Agent avatar already exists, skipping generation");
    } else {
      config.intentLogger?.log("avatar_generating", {
        tool: "venice-image",
        result: { intentId: config.intentId, model: "nano-banana-2" },
      });
      const iid = config.intentId;
      await withRetry(
        () => generateAgentAvatar(iid, config.intent),
        { maxRetries: 3, baseDelayMs: 2_000, label: `avatar-${iid}` },
      );
      logger.info({ intentId: iid }, "Agent avatar generated");
      config.intentLogger?.log("avatar_generated", {
        tool: "venice-image",
        result: { intentId: iid, model: "nano-banana-2" },
      });

      // Pin avatar to Filecoin (non-fatal)
      try {
        config.intentLogger?.log("filecoin_pin_started", {
          tool: "filecoin-pin",
          result: { artifactType: "avatar", intentId: iid },
        });
        const pinResult = await pinFile(avatarPath(iid), {
          intentId: iid,
          artifactType: "avatar",
        });
        logger.info({ intentId: iid, rootCid: pinResult.rootCid }, "Avatar pinned to Filecoin");
        config.intentLogger?.log("filecoin_pin_success", {
          tool: "filecoin-pin",
          result: { artifactType: "avatar", rootCid: pinResult.rootCid, pieceCid: pinResult.pieceCid, txHash: pinResult.txHash },
        });
        // Persist CID to DB
        config.repo?.updateIntentAvatarCid(iid, pinResult.rootCid);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.warn({ intentId: iid, error: errMsg }, "Failed to pin avatar to Filecoin (continuing)");
        config.intentLogger?.log("filecoin_pin_failed", {
          tool: "filecoin-pin",
          error: errMsg,
          result: { artifactType: "avatar", intentId: iid },
        });
      }
    }
  }

  // Check for existing agentId (persisted from previous run)
  if (config.existingAgentId != null) {
    state.agentId = config.existingAgentId;
    logger.info({ agentId: config.existingAgentId.toString() }, "Resuming with existing ERC-8004 agent ID");
    logAction("erc8004_register", {
      tool: "erc8004-identity",
      result: { agentId: config.existingAgentId.toString(), source: "database" },
    });
    config.intentLogger?.log("erc8004_register", {
      tool: "erc8004-identity",
      result: { agentId: config.existingAgentId.toString(), source: "database" },
    });
  } else {
    // Register new identity for this intent
    try {
      const intentId = config.intentId ?? "unknown";
      const agentURI = `https://api.maw.finance/api/intents/${intentId}/identity.json`;
      const { txHash, agentId } = await withRetry(
        () => registerAgent(agentURI, "base-sepolia"),
        { label: "erc8004:register", maxRetries: 3 },
      );
      logger.info({ txHash, agentId: agentId?.toString() }, "ERC-8004 agent registered");
      if (agentId != null) {
        state.agentId = agentId;
        // Persist to DB so it survives restarts
        config.onAgentIdRegistered?.(agentId.toString());
      }
      logAction("erc8004_register", {
        tool: "erc8004-identity",
        result: { txHash, agentId: agentId?.toString() },
      });
      config.intentLogger?.log("erc8004_register", {
        tool: "erc8004-identity",
        result: { txHash, agentId: agentId?.toString() },
      });
    } catch (err) {
      logger.error({ err }, "ERC-8004 registration failed after retries");
      logAction("erc8004_register_failed", {
        tool: "erc8004-identity",
        error: err instanceof Error ? err.message : String(err),
      });
      config.intentLogger?.log("erc8004_register_failed", {
        tool: "erc8004-identity",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // HARD GATE: Do not enter the main loop without an on-chain identity.
  // Without an agentId, no judge evaluation can happen, and the agent
  // would trade without on-chain accountability.
  if (state.agentId == null) {
    const msg = "Cannot start agent: ERC-8004 identity registration failed. No agentId available.";
    logger.error(msg);
    state.deployError = msg;
    state.running = false;
    logAction("agent_halted", { error: msg });
    config.intentLogger?.log("agent_halted", { error: msg });
    return state;
  }

  logger.info("=== MAW AGENT STARTING ===");
  logger.info(`Agent address: ${agentAddress}`);
  logger.info(`Chain: ${chain.name} (${config.chainId})`);
  logger.info(
    `Target: ${Object.entries(config.intent.targetAllocation)
      .map(([t, v]) => `${t}: ${(v * 100).toFixed(0)}%`)
      .join(", ")}`,
  );
  logger.info(
    `Budget: $${config.intent.dailyBudgetUsd}/day × ${config.intent.timeWindowDays} days`,
  );
  logger.info(`Drift threshold: ${(config.intent.driftThreshold * 100).toFixed(1)}%`);

  // --- Step 1: Adversarial check ---
  const warnings = detectAdversarialIntent(config.intent);
  if (warnings.length > 0) {
    logger.warn("ADVERSARIAL WARNINGS:");
    for (const w of warnings) {
      logger.warn(`  - ${w.message}`);
    }
    logAction("adversarial_check", {
      result: { warnings: warnings.map((w) => w.message) },
    });
    config.intentLogger?.log("adversarial_check", {
      result: { warnings: warnings.map((w) => w.message) },
    });
  }

  // --- Step 2: Verify ERC-7715 permissions ---
  logger.info("Loading ERC-7715 permissions from user grant...");
  if (state.permissions.length === 0) {
    const msg = "No ERC-7715 permissions granted — cannot pull tokens from user.";
    logger.error(msg);
    state.deployError = msg;
    state.running = false;
    logAction("permissions_missing", { error: msg });
    config.intentLogger?.log("permissions_missing", { error: msg });
    return state;
  }

  logAction("permissions_loaded", {
    tool: "metamask-erc7715",
    result: {
      permissionCount: state.permissions.length,
      types: state.permissions.map((p) => p.type),
      delegationManager: state.delegationManager,
      dependencyCount: state.dependencies.length,
    },
  });
  config.intentLogger?.log("permissions_loaded", {
    tool: "metamask-erc7715",
    result: {
      permissionCount: state.permissions.length,
      types: state.permissions.map((p) => p.type),
      delegationManager: state.delegationManager,
    },
  });
  logger.info(
    `Loaded ${state.permissions.length} permission(s): ${state.permissions.map((p) => p.type).join(", ")}`,
  );

  // --- Step 3: Audit report ---
  const report = generateDetailedAudit(config.intent);
  state.audit = report;
  logger.info("\n" + report.formatted);
  logAction("audit_report", {
    result: {
      allows: report.allows,
      prevents: report.prevents,
      worstCase: report.worstCase,
      warnings: report.warnings,
    },
  });
  config.intentLogger?.log("audit_report", {
    result: {
      allows: report.allows,
      prevents: report.prevents,
      worstCase: report.worstCase,
      warnings: report.warnings,
    },
  });

  // --- Step 4: Main loop ---
  logger.info("Entering monitoring loop...");

  while (state.running) {
    // Check abort signal before each cycle
    if (config.signal?.aborted) {
      logger.info("Abort signal received. Stopping agent.");
      state.running = false;
      break;
    }

    state.cycle++;
    const cycleStart = Date.now();

    try {
      await runCycle(config, state, agentAddress, chain);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, cycle: state.cycle }, "Cycle error");
      logAction("cycle_error", {
        cycle: state.cycle,
        parameters: { cycle: state.cycle },
        error: msg,
      });
      config.intentLogger?.log("cycle_error", {
        cycle: state.cycle,
        error: msg,
      });

      // Judge the failed cycle (skip if already judged inside executeSwap)
      if (state.agentId != null && env.JUDGE_PRIVATE_KEY && state.lastCycleJudged !== state.cycle) {
        try {
          const failureInput: SwapFailureEvidenceInput = {
            agentId: state.agentId,
            intentId: config.intentId ?? "unknown",
            cycle: state.cycle,
            intent: {
              targetAllocation: config.intent.targetAllocation,
              dailyBudgetUsd: config.intent.dailyBudgetUsd,
              driftThreshold: config.intent.driftThreshold,
              maxSlippage: config.intent.maxSlippage,
              timeWindowDays: config.intent.timeWindowDays,
              maxTradesPerDay: config.intent.maxTradesPerDay,
              maxPerTradeUsd: config.intent.maxPerTradeUsd,
            },
            beforeSwap: {
              allocation: { ...state.allocation },
              drift: state.drift,
              portfolioValueUsd: state.totalValue,
            },
            attemptedSwap: { sellToken: "unknown", buyToken: "unknown", sellAmount: "0" },
            errorMessage: msg,
            agentReasoning: "Cycle failed before or during swap execution",
            marketContext: { ethPriceUsd: state.ethPrice },
          };

          logAction("judge_started", { cycle: state.cycle, tool: "venice-judge", result: { outcome: "cycle_error" } });
          config.intentLogger?.log("judge_started", { cycle: state.cycle, tool: "venice-judge", result: { outcome: "cycle_error" } });

          const judgeResult = await evaluateSwapFailure(failureInput, "rebalance", state.budgetTier === "critical");
          state.lastCycleJudged = state.cycle;
          const judgeModel = state.budgetTier === "critical" ? FAST_MODEL : REASONING_MODEL;
          logAction("judge_completed", {
            cycle: state.cycle,
            tool: "venice-judge",
            result: { outcome: "cycle_error", composite: judgeResult.composite, scores: judgeResult.scores, model: judgeModel },
          });
          config.intentLogger?.log("judge_completed", {
            cycle: state.cycle,
            tool: "venice-judge",
            result: { outcome: "cycle_error", composite: judgeResult.composite, scores: judgeResult.scores, model: judgeModel },
          });
        } catch (judgeErr) {
          logger.warn({ err: judgeErr }, "Judge evaluation for cycle error failed");
          config.intentLogger?.log("judge_failed", {
            cycle: state.cycle,
            tool: "venice-judge",
            error: judgeErr instanceof Error ? judgeErr.message : String(judgeErr),
          });
        }
      }
    }

    const cycleResult = {
      tradesExecuted: state.tradesExecuted,
      totalSpentUsd: state.totalSpentUsd,
      budgetTier: getBudgetTier(),
      allocation: state.allocation,
      drift: state.drift,
      totalValue: state.totalValue,
      ethPrice: state.ethPrice,
    };

    logAction("cycle_complete", {
      cycle: state.cycle,
      parameters: { cycle: state.cycle },
      duration_ms: Date.now() - cycleStart,
      result: cycleResult,
    });

    // Write cycle data to per-intent log
    if (config.intentLogger) {
      config.intentLogger.log("cycle_complete", {
        cycle: state.cycle,
        duration_ms: Date.now() - cycleStart,
        result: cycleResult,
      });
    }

    // Notify external observer (worker persistence)
    config.onCycleComplete?.(state);

    // Budget guard
    const maxBudget =
      config.intent.dailyBudgetUsd * config.intent.timeWindowDays;
    if (state.totalSpentUsd >= maxBudget) {
      logger.info("Budget exhausted. Stopping agent.");
      state.running = false;
      break;
    }

    // Trade limit guard
    const maxTrades =
      config.intent.maxTradesPerDay * config.intent.timeWindowDays;
    if (state.tradesExecuted >= maxTrades) {
      logger.info("Trade limit reached. Stopping agent.");
      state.running = false;
      break;
    }

    // Max cycles guard (demo mode)
    if (config.maxCycles && state.cycle >= config.maxCycles) {
      logger.info(`Demo mode: completed ${config.maxCycles} cycle(s). Stopping.`);
      state.running = false;
      break;
    }

    // Check abort signal before sleeping
    if (config.signal?.aborted) {
      logger.info("Abort signal received. Stopping agent.");
      state.running = false;
      break;
    }

    // Wait for next cycle (interruptible via abort signal)
    if (state.running) {
      logger.info(
        `Sleeping ${config.intervalMs / 1000}s until next cycle...`,
      );
      await abortableSleep(config.intervalMs, config.signal);
    }
  }

  logStop("loop_ended");
  logger.info("=== MAW AGENT STOPPED ===");
  return state;
}

// ---------------------------------------------------------------------------
// Rebalance decision via Venice
// ---------------------------------------------------------------------------

/**
 * Format recent judge scores into a prompt section for the Venice rebalance LLM.
 * Returns empty string if no scores exist (first cycle).
 * Exported for testing.
 */
export function formatFeedbackPrompt(
  scores: import("../db/repository.js").SwapScoreSelect[],
): string {
  if (scores.length === 0) return "";

  const entries = scores.map((s) => {
    const lines = [
      `Cycle ${s.cycle} (${s.outcome}) -- Composite: ${Math.round(s.composite)}/100`,
      `  Decision Quality (40% weight): ${s.decisionScore} -- "${s.decisionReasoning}"`,
      `  Execution Quality (30% weight): ${s.executionScore} -- "${s.executionReasoning}"`,
      `  Goal Progress (30% weight): ${s.goalScore} -- "${s.goalReasoning}"`,
    ];
    return lines.join("\n");
  });

  return `\nPAST PERFORMANCE FEEDBACK (from independent Venice judge):\n\n${entries.join("\n\n")}\n\nUse this feedback to improve your decisions. If execution quality is consistently low, prefer smaller trade sizes for better fills. If goal progress is low, reconsider trade direction.`;
}

async function getRebalanceDecision(
  config: AgentConfig,
  state: AgentState,
  market: MarketData & { drift: Record<string, number>; maxDrift: number },
  allowances?: Record<string, { available: bigint; decimals: number }>,
): Promise<{ shouldRebalance: boolean; reasoning: string; marketContext?: string | null; targetSwap?: { sellToken: string; buyToken: string; sellAmount: string; maxSlippage: string } | null }> {
  logger.info("Drift detected. Consulting Venice for rebalance decision...");

  // Query recent judge feedback for self-correction
  let feedbackSection = "";
  if (config.repo && config.intentId) {
    try {
      const recentScores = config.repo.getRecentScores(config.intentId, 5);
      feedbackSection = formatFeedbackPrompt(recentScores);
    } catch (err) {
      logger.warn({ err }, "Failed to query recent scores for feedback prompt");
    }
  }

  const llmForReasoning = market.budgetTier === "normal" ? reasoningLlm : fastLlm;
  const startReasoning = Date.now();
  const structuredReasoning =
    llmForReasoning.withStructuredOutput(RebalanceDecisionSchema, {
      method: "functionCalling",
      includeRaw: true,
    });

  const rawResponse = await structuredReasoning.invoke([
    {
      role: "system",
      content: `You are a DeFi portfolio rebalancing agent. Analyze the current portfolio state and decide if a rebalance is needed.

Current portfolio:
${JSON.stringify(market.portfolio.allocation, null, 2)}

Target allocation:
${JSON.stringify(config.intent.targetAllocation, null, 2)}

Current drift: ${JSON.stringify(market.drift, null, 2)} (max: ${(market.maxDrift * 100).toFixed(1)}%)
Drift threshold: ${(config.intent.driftThreshold * 100).toFixed(1)}%
ETH price: $${market.ethPrice.price.toFixed(2)}
${market.poolContext ? `\nLiquidity data:\n${market.poolContext}\n\nUse the TVL and volume data above to assess whether sufficient liquidity exists for the proposed swap size. If the swap amount is >1% of pool TVL, consider reducing the trade size or splitting across cycles.` : ""}
Trades executed: ${state.tradesExecuted}
Total spent: $${state.totalSpentUsd.toFixed(2)} / $${(config.intent.dailyBudgetUsd * config.intent.timeWindowDays).toFixed(2)}

HARD RULES — violations will be rejected by the safety system:
1. The sellAmount MUST NOT exceed $${config.intent.maxPerTradeUsd > 0 ? config.intent.maxPerTradeUsd : config.intent.dailyBudgetUsd} in USD value (per-trade limit).
2. The sellAmount MUST NOT exceed $${(config.intent.dailyBudgetUsd * config.intent.timeWindowDays - state.totalSpentUsd).toFixed(2)} remaining total budget.
3. maxSlippage MUST NOT exceed ${(config.intent.maxSlippage * 100).toFixed(2)}%.
4. Only trade tokens in the target allocation: ${Object.keys(config.intent.targetAllocation).join(", ")}.
5. If shouldRebalance is true, targetSwap MUST be provided with valid sellAmount.
6. The sellAmount MUST NOT exceed the delegation allowance for the sell token. If allowance is 0, do NOT propose a swap for that token.
${allowances && Object.keys(allowances).length > 0
  ? `\nDelegation allowances (remaining in current period):\n${
      Object.entries(allowances)
        .map(([token, { available, decimals }]) => `- ${token}: ${formatUnits(available, decimals)}`)
        .join("\n")
    }\nThe on-chain enforcer will revert any transaction exceeding these limits.`
  : ""}
${feedbackSection}
Size the trade to make meaningful progress on drift while staying well within these limits.`,
    },
    {
      role: "user",
      content:
        "Should the portfolio be rebalanced now? Consider current market conditions and liquidity.",
    },
  ]);

  // LLM structured output can return undefined/null when the response doesn't parse
  const parseResult = RebalanceDecisionSchema.safeParse(rawResponse.parsed);
  if (!parseResult.success) {
    logger.warn({ raw: rawResponse.parsed, zodError: parseResult.error.issues }, "Venice returned unparseable rebalance decision — treating as HOLD");
    return { shouldRebalance: false, reasoning: "LLM response could not be parsed" };
  }
  const decision = parseResult.data;

  const decisionModel = market.budgetTier === "normal" ? REASONING_MODEL : FAST_MODEL;
  const meta = rawResponse.raw instanceof AIMessage ? rawResponse.raw.usage_metadata : undefined;
  const usage = meta
    ? {
        inputTokens: meta.input_tokens,
        outputTokens: meta.output_tokens,
        totalTokens: meta.total_tokens,
        diemCost: estimateDiemCost(decisionModel, {
          inputTokens: meta.input_tokens,
          outputTokens: meta.output_tokens,
          totalTokens: meta.total_tokens,
        }),
      }
    : undefined;

  const decisionResult: Record<string, unknown> = {
    shouldRebalance: decision.shouldRebalance,
    reasoning: decision.reasoning,
    marketContext: decision.marketContext,
    model: decisionModel,
  };
  if (usage) decisionResult.usage = usage;

  logAction("rebalance_decision", {
    cycle: state.cycle,
    tool: "venice-reasoning",
    duration_ms: Date.now() - startReasoning,
    result: decisionResult,
  });

  // Write to per-intent log
  config.intentLogger?.log("rebalance_decision", {
    cycle: state.cycle,
    tool: "venice-reasoning",
    duration_ms: Date.now() - startReasoning,
    result: decisionResult,
  });

  logger.info(`Decision: ${decision.shouldRebalance ? "REBALANCE" : "HOLD"}`);
  logger.info(`Reasoning: ${decision.reasoning}`);

  return decision;
}

// ---------------------------------------------------------------------------
// Single monitoring cycle (orchestrator)
// ---------------------------------------------------------------------------

async function runCycle(
  config: AgentConfig,
  state: AgentState,
  agentAddress: Address,
  chain: typeof sepolia | typeof base,
): Promise<void> {
  logger.info(`--- Cycle ${state.cycle} ---`);

  const market = await gatherMarketData(config.chainId, agentAddress, state.cycle, config.intentLogger);

  state.ethPrice = market.ethPrice.price;
  state.allocation = market.portfolio.allocation;
  state.totalValue = market.portfolio.totalUsdValue;
  state.budgetTier = market.budgetTier;

  const { drift, maxDrift } = calculateDrift(
    market.portfolio.allocation,
    config.intent.targetAllocation,
  );

  logger.info(
    `Drift: ${(maxDrift * 100).toFixed(1)}% (threshold: ${(config.intent.driftThreshold * 100).toFixed(1)}%)`,
  );

  state.drift = maxDrift;

  if (maxDrift < config.intent.driftThreshold) {
    logger.info("No significant drift. Skipping rebalance.");
    return;
  }

  // Query delegation allowances before consulting Venice
  const allowances: Record<string, { available: bigint; decimals: number }> = {};
  for (const perm of state.permissions) {
    if (perm.type === "erc20-token-periodic") {
      const result = await getErc20Allowance(perm.context as Hex, config.chainId);
      if (result) {
        allowances[perm.token.toUpperCase()] = { available: result.availableAmount, decimals: 6 };
      }
    } else if (perm.type === "native-token-periodic") {
      const result = await getNativeAllowance(perm.context as Hex, config.chainId);
      if (result) {
        allowances["ETH"] = { available: result.availableAmount, decimals: 18 };
      }
    }
  }

  if (Object.keys(allowances).length > 0) {
    const formatted = Object.fromEntries(
      Object.entries(allowances).map(([token, { available, decimals }]) => [
        token,
        { availableRaw: available.toString(), availableFormatted: formatUnits(available, decimals) },
      ]),
    );
    logger.info({ allowances: formatted }, "Delegation allowances queried");
    config.intentLogger?.log("delegation_allowance", {
      cycle: state.cycle,
      tool: "metamask-caveat-enforcer",
      result: formatted,
    });
  }

  const decision = await getRebalanceDecision(config, state, { ...market, drift, maxDrift }, allowances);

  if (!decision.shouldRebalance || !decision.targetSwap) {
    return;
  }

  await executeSwap(
    config,
    state,
    decision.targetSwap,
    agentAddress,
    chain,
    market.ethPrice.price,
    decision.reasoning,
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Sleep that resolves early if the abort signal fires */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return sleep(ms);
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

export async function startFromCli(
  intentText: string,
  maxCycles?: number,
): Promise<void> {
  logger.info("Parsing intent via Venice...");
  const intent = await compileIntent(intentText);
  logger.info({ intent }, "Parsed intent");

  // CLI mode uses empty permissions — the real flow is browser-based via MetaMask Flask.
  // This is for local testing only.
  logger.warn("CLI mode: no ERC-7715 permissions — agent will run without token pulls.");

  await runAgentLoop({
    intent,
    agentKey: env.AGENT_PRIVATE_KEY,
    chainId: 11155111,
    intervalMs: 60_000,
    permissions: [],
    delegationManager: "",
    dependencies: [],
    maxCycles,
  });
}
