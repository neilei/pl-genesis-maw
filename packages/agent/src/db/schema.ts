import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

export const nonces = sqliteTable("nonces", {
  walletAddress: text("wallet_address").primaryKey(),
  nonce: text("nonce").notNull(),
  createdAt: integer("created_at", { mode: "number" }).notNull(),
});

export const intents = sqliteTable("intents", {
  id: text("id").primaryKey(),
  walletAddress: text("wallet_address").notNull(),
  intentText: text("intent_text").notNull(),
  parsedIntent: text("parsed_intent").notNull(), // JSON blob of ParsedIntent
  status: text("status", {
    enum: ["active", "paused", "completed", "expired", "cancelled", "failed"],
  }).notNull(),
  createdAt: integer("created_at", { mode: "number" }).notNull(),
  expiresAt: integer("expires_at", { mode: "number" }).notNull(),

  // ERC-7715 permissions (from MetaMask Flask)
  permissions: text("permissions"), // JSON: [{ type, context, token }]
  delegationManager: text("delegation_manager"),
  dependencies: text("dependencies"), // JSON: [{ factory, factoryData }]

  // Execution state (updated each cycle)
  cycle: integer("cycle").notNull().default(0),
  tradesExecuted: integer("trades_executed").notNull().default(0),
  totalSpentUsd: real("total_spent_usd").notNull().default(0),
  lastCycleAt: integer("last_cycle_at", { mode: "number" }),

  // ERC-8004 identity
  agentId: text("agent_id"),

  // Filecoin storage
  avatarCid: text("avatar_cid"),
});

export const swaps = sqliteTable("swaps", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  intentId: text("intent_id")
    .notNull()
    .references(() => intents.id),
  txHash: text("tx_hash").notNull(),
  sellToken: text("sell_token").notNull(),
  buyToken: text("buy_token").notNull(),
  sellAmount: text("sell_amount").notNull(),
  status: text("status").notNull(),
  timestamp: text("timestamp").notNull(),

  // Filecoin storage
  evidenceCid: text("evidence_cid"),
});

export const agentLogs = sqliteTable("agent_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  intentId: text("intent_id")
    .notNull()
    .references(() => intents.id),
  timestamp: text("timestamp").notNull(),
  sequence: integer("sequence").notNull(),
  action: text("action").notNull(),
  cycle: integer("cycle"),
  tool: text("tool"),
  parameters: text("parameters"), // JSON blob
  result: text("result"), // JSON blob
  durationMs: integer("duration_ms"),
  error: text("error"),
});

export const swapScores = sqliteTable("swap_scores", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  intentId: text("intent_id")
    .notNull()
    .references(() => intents.id),
  swapId: integer("swap_id").references(() => swaps.id),
  cycle: integer("cycle").notNull(),
  composite: real("composite").notNull(),
  decisionScore: integer("decision_score").notNull(),
  decisionReasoning: text("decision_reasoning").notNull(),
  executionScore: integer("execution_score").notNull(),
  executionReasoning: text("execution_reasoning").notNull(),
  goalScore: integer("goal_score").notNull(),
  goalReasoning: text("goal_reasoning").notNull(),
  outcome: text("outcome").notNull().default("success"),
  createdAt: text("created_at").notNull(),
});
