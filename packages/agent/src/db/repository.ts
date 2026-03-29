import { eq, and, gt, lte, max, desc } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";
import { intents, swaps, nonces, agentLogs, swapScores } from "./schema.js";

type IntentInsert = typeof intents.$inferInsert;
type IntentSelect = typeof intents.$inferSelect;
type SwapInsert = Omit<typeof swaps.$inferInsert, "id">;
type SwapSelect = typeof swaps.$inferSelect;
type NonceSelect = typeof nonces.$inferSelect;
type AgentLogInsert = Omit<typeof agentLogs.$inferInsert, "id">;
type AgentLogSelect = typeof agentLogs.$inferSelect;
type SwapScoreInsert = Omit<typeof swapScores.$inferInsert, "id">;
type SwapScoreSelect = typeof swapScores.$inferSelect;

export type { IntentInsert, IntentSelect, SwapInsert, SwapSelect, NonceSelect, AgentLogInsert, AgentLogSelect, SwapScoreInsert, SwapScoreSelect };

export class IntentRepository {
  constructor(private db: BetterSQLite3Database<typeof schema>) {}

  createIntent(data: IntentInsert): IntentSelect {
    this.db.insert(intents).values(data).run();
    return this.getIntent(data.id)!;
  }

  getIntent(id: string): IntentSelect | null {
    const rows = this.db
      .select()
      .from(intents)
      .where(eq(intents.id, id))
      .all();
    return rows[0] ?? null;
  }

  getIntentsByWallet(walletAddress: string): IntentSelect[] {
    return this.db
      .select()
      .from(intents)
      .where(eq(intents.walletAddress, walletAddress))
      .all();
  }

  getActiveIntents(): IntentSelect[] {
    const now = Math.floor(Date.now() / 1000);
    return this.db
      .select()
      .from(intents)
      .where(and(eq(intents.status, "active"), gt(intents.expiresAt, now)))
      .all();
  }

  getAllIntents(): IntentSelect[] {
    return this.db.select().from(intents).all();
  }

  updateIntentStatus(id: string, status: IntentSelect["status"]): void {
    this.db.update(intents).set({ status }).where(eq(intents.id, id)).run();
  }

  updateIntentCycleState(
    id: string,
    state: {
      cycle: number;
      tradesExecuted: number;
      totalSpentUsd: number;
      lastCycleAt: number;
    },
  ): void {
    this.db.update(intents).set(state).where(eq(intents.id, id)).run();
  }

  updateIntentAgentId(id: string, agentId: string): void {
    this.db.update(intents).set({ agentId }).where(eq(intents.id, id)).run();
  }

  updateIntentAvatarCid(id: string, avatarCid: string): void {
    this.db.update(intents).set({ avatarCid }).where(eq(intents.id, id)).run();
  }

  updateSwapEvidenceCid(intentId: string, txHash: string, evidenceCid: string): void {
    this.db
      .update(swaps)
      .set({ evidenceCid })
      .where(and(eq(swaps.intentId, intentId), eq(swaps.txHash, txHash)))
      .run();
  }

  markExpiredIntents(): number {
    const now = Math.floor(Date.now() / 1000);
    const result = this.db
      .update(intents)
      .set({ status: "expired" })
      .where(and(eq(intents.status, "active"), lte(intents.expiresAt, now)))
      .run();
    return result.changes;
  }

  // Swaps
  insertSwap(data: SwapInsert): void {
    this.db.insert(swaps).values(data).run();
  }

  getSwapsByIntent(intentId: string): SwapSelect[] {
    return this.db
      .select()
      .from(swaps)
      .where(eq(swaps.intentId, intentId))
      .all();
  }

  // Nonces
  upsertNonce(walletAddress: string, nonce: string): void {
    const now = Math.floor(Date.now() / 1000);
    this.db
      .insert(nonces)
      .values({ walletAddress, nonce, createdAt: now })
      .onConflictDoUpdate({
        target: nonces.walletAddress,
        set: { nonce, createdAt: now },
      })
      .run();
  }

  getNonce(walletAddress: string): NonceSelect | null {
    const rows = this.db
      .select()
      .from(nonces)
      .where(eq(nonces.walletAddress, walletAddress))
      .all();
    return rows[0] ?? null;
  }

  deleteNonce(walletAddress: string): void {
    this.db
      .delete(nonces)
      .where(eq(nonces.walletAddress, walletAddress))
      .run();
  }

  // Agent logs

  /** Return the highest sequence number for an intent's logs, or -1 if none exist. */
  getMaxLogSequence(intentId: string): number {
    const row = this.db
      .select({ maxSeq: max(agentLogs.sequence) })
      .from(agentLogs)
      .where(eq(agentLogs.intentId, intentId))
      .get();
    return row?.maxSeq ?? -1;
  }

  insertLog(data: AgentLogInsert): AgentLogSelect {
    const result = this.db
      .insert(agentLogs)
      .values(data)
      .returning()
      .get();
    return result;
  }

  getIntentLogs(
    intentId: string,
    opts?: { afterSequence?: number; limit?: number },
  ): AgentLogSelect[] {
    const afterSeq = opts?.afterSequence ?? -1;
    const limit = opts?.limit ?? 10_000;
    return this.db
      .select()
      .from(agentLogs)
      .where(
        and(
          eq(agentLogs.intentId, intentId),
          gt(agentLogs.sequence, afterSeq),
        ),
      )
      .orderBy(agentLogs.sequence)
      .limit(limit)
      .all();
  }

  // Swap scores (judge feedback)

  insertSwapScore(data: SwapScoreInsert): void {
    this.db.insert(swapScores).values(data).run();
  }

  getRecentScores(intentId: string, limit: number = 5): SwapScoreSelect[] {
    return this.db
      .select()
      .from(swapScores)
      .where(eq(swapScores.intentId, intentId))
      .orderBy(desc(swapScores.cycle))
      .limit(limit)
      .all();
  }
}
