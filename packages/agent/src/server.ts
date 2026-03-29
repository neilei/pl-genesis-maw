/**
 * HTTP server (port 3147) exposing wallet-scoped intent API.
 * Serves the Next.js dashboard static build as a SPA fallback.
 *
 * @module @maw/agent/server
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { join } from "path";
import { existsSync, readFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";

import { env } from "./config.js";
import { DEFAULT_AGENT_PORT, API_PATHS } from "@maw/common";
import { logger } from "./logging/logger.js";
import { IntentRepository } from "./db/repository.js";
import { getDb } from "./db/connection.js";
import { WorkerPool } from "./worker-pool.js";
import { DefaultAgentWorker } from "./agent-worker.js";
import { resumeActiveIntents } from "./startup.js";

import { streamSSE } from "hono/streaming";
import { requireAuth } from "./middleware/auth.js";
import { createAuthRoutes } from "./routes/auth.js";
import { createParseRoutes } from "./routes/parse.js";
import { createIntentRoutes } from "./routes/intents.js";
import { createIdentityRoutes } from "./routes/identity.js";
import { redactLogRow, redactParsedEntry } from "./logging/redact.js";
import { onLogEntry } from "./logging/intent-log.js";

const PORT = process.env.PORT ? Number(process.env.PORT) : DEFAULT_AGENT_PORT;
const DASHBOARD_DIST = join("apps", "dashboard", "out");

// Singleton instances — initialized at startup
let repo: IntentRepository;
const workerPool = new WorkerPool({ maxConcurrency: 5 });

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------

export const app = new Hono();

// Global error handler — returns JSON errors and logs via pino
app.onError((err, c) => {
  const msg = err instanceof Error ? err.message : String(err);
  logger.error({ err, method: c.req.method, url: c.req.url }, "Request handler error");
  return c.json({ error: msg }, 500);
});

// CORS
app.use(
  "*",
  cors({
    origin: (origin) => origin || "*",
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  }),
);

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------

// Lazy deps — repo is initialized in startup(), but routes only access it at
// request time, so a getter is safe here.
const lazyDeps = {
  get repo() {
    return repo;
  },
};

// Auth routes (no auth middleware required) — mount at /api/auth (covers /nonce and /verify)
const authBase = API_PATHS.authNonce.replace(/\/nonce$/, "");
app.route(authBase, createAuthRoutes(lazyDeps));

// Parse intent (no auth required — used before wallet connected)
app.route(API_PATHS.parseIntent, createParseRoutes());

// Evidence documents (no auth — public, content-addressed, immutable)
app.get("/api/evidence/:intentId/:hash", (c) => {
  const { intentId, hash } = c.req.param();
  if (!/^[a-zA-Z0-9-]+$/.test(intentId) || !/^0x[a-f0-9]+$/.test(hash)) {
    return c.json({ error: "Invalid parameters" }, 400);
  }
  const filePath = join("data", "evidence", intentId, `${hash}.json`);
  if (!existsSync(filePath)) {
    return c.json({ error: "Evidence not found" }, 404);
  }
  const content = readFileSync(filePath, "utf-8");
  c.header("Content-Type", "application/json");
  c.header("Cache-Control", "public, max-age=31536000, immutable");
  return c.body(content);
});

// Agent avatar images (public — referenced by ERC-8004 identity image field)
app.get("/api/intents/:id/avatar.webp", (c) => {
  const intentId = c.req.param("id");
  if (!/^[a-zA-Z0-9_-]+$/.test(intentId)) {
    return c.json({ error: "Invalid intent ID" }, 400);
  }
  const filePath = join("data", "images", `${intentId}.webp`);
  if (!existsSync(filePath)) {
    return c.json({ error: "Avatar not found" }, 404);
  }
  const content = readFileSync(filePath);
  const intent = repo.getIntent(intentId);
  c.header("Content-Type", "image/webp");
  c.header("Cache-Control", "public, max-age=31536000, immutable");
  if (intent?.avatarCid) {
    c.header("X-Filecoin-CID", intent.avatarCid);
  }
  return c.body(content);
});

// Filecoin artifacts for an intent (public)
const FILECOIN_GATEWAY = "https://calibration.w3s.link/ipfs";

/** Extract unique Filecoin CIDs from the intent JSONL log (judge_completed entries). */
function getFilecoinCidsFromLog(intentId: string): string[] {
  const logPath = join("data/logs", `${intentId}.jsonl`);
  try {
    const lines = readFileSync(logPath, "utf-8").split("\n").filter(Boolean);
    const cids = new Set<string>();
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        const rc = entry.result?.filecoinCids;
        if (Array.isArray(rc)) {
          for (const cid of rc) {
            if (typeof cid === "string" && cid.length > 0) cids.add(cid);
          }
        }
      } catch { /* skip malformed lines */ }
    }
    return [...cids];
  } catch {
    return [];
  }
}

app.get("/api/intents/:id/filecoin", (c) => {
  const intentId = c.req.param("id");
  if (!/^[a-zA-Z0-9_-]+$/.test(intentId)) {
    return c.json({ error: "Invalid intent ID" }, 400);
  }
  const intent = repo.getIntent(intentId);
  if (!intent) {
    return c.json({ error: "Intent not found" }, 404);
  }

  // Collect CIDs from DB (swap records) and from intent JSONL log
  const swapRecords = repo.getSwapsByIntent(intentId);
  const dbEvidence = swapRecords
    .filter((s) => s.evidenceCid)
    .map((s) => ({
      swapTxHash: s.txHash,
      rootCid: s.evidenceCid,
      gatewayUrl: `${FILECOIN_GATEWAY}/${s.evidenceCid}`,
    }));

  const logCids = getFilecoinCidsFromLog(intentId);
  const logEvidence = logCids.map((cid) => ({
    rootCid: cid,
    gatewayUrl: `${FILECOIN_GATEWAY}/${cid}`,
  }));

  // Merge: DB evidence first, then log-only CIDs (deduplicated)
  const seenCids = new Set(dbEvidence.map((e) => e.rootCid));
  const uniqueLogEvidence = logEvidence.filter((e) => !seenCids.has(e.rootCid));

  return c.json({
    intentId,
    avatar: intent.avatarCid
      ? {
          rootCid: intent.avatarCid,
          gatewayUrl: `${FILECOIN_GATEWAY}/${intent.avatarCid}`,
        }
      : null,
    evidence: [...dbEvidence, ...uniqueLogEvidence],
  });
});

// Public intent listing (no auth — lets anyone browse active agents)
app.get(`${API_PATHS.intents}/public`, (c) => {
  const showAll = c.req.query("includeInactive") === "true";
  const all = repo.getAllIntents();
  const filtered = showAll ? all : all.filter((i) => i.status === "active");
  // Strip sensitive fields for public consumption
  const safe = filtered.map((i) => ({
    id: i.id,
    intentText: i.intentText,
    parsedIntent: i.parsedIntent,
    status: i.status,
    createdAt: i.createdAt,
    expiresAt: i.expiresAt,
    cycle: i.cycle,
    tradesExecuted: i.tradesExecuted,
    totalSpentUsd: i.totalSpentUsd,
    lastCycleAt: i.lastCycleAt,
    agentId: i.agentId,
    workerStatus: workerPool.getStatus(i.id),
    queuePosition: workerPool.getQueuePosition(i.id),
  }));
  return c.json(safe);
});

// Public intent detail (no auth — read-only view without logs)
app.get(`${API_PATHS.intents}/public/:id`, (c) => {
  const intentId = c.req.param("id");
  const intent = repo.getIntent(intentId);
  if (!intent) {
    return c.json({ error: "Intent not found" }, 404);
  }
  const rawLiveState = workerPool.getState(intentId);
  const liveState = rawLiveState
    ? JSON.parse(JSON.stringify(rawLiveState, (_k, v) => typeof v === "bigint" ? v.toString() : v))
    : null;
  // Fetch logs from DB and redact private Venice reasoning
  const rawLogs = repo.getIntentLogs(intentId, { afterSequence: -1, limit: 10_000 });
  const logs = rawLogs.map(redactLogRow).filter((l): l is NonNullable<typeof l> => l !== null);

  return c.json({
    id: intent.id,
    intentText: intent.intentText,
    parsedIntent: intent.parsedIntent,
    status: intent.status,
    createdAt: intent.createdAt,
    expiresAt: intent.expiresAt,
    cycle: intent.cycle,
    tradesExecuted: intent.tradesExecuted,
    totalSpentUsd: intent.totalSpentUsd,
    lastCycleAt: intent.lastCycleAt,
    agentId: intent.agentId,
    workerStatus: workerPool.getStatus(intent.id),
    queuePosition: workerPool.getQueuePosition(intent.id),
    liveState,
    logs,
  });
});

// Public SSE stream (no auth — redacted entries only)
app.get(`${API_PATHS.intents}/public/:id/events`, (c) => {
  const intentId = c.req.param("id");
  const intent = repo.getIntent(intentId);
  if (!intent) {
    return c.json({ error: "Intent not found" }, 404);
  }

  return streamSSE(c, async (stream) => {
    const unsub = onLogEntry((id, entry) => {
      if (id !== intentId) return;
      const redacted = redactParsedEntry(entry);
      if (!redacted) return;
      stream.writeSSE({
        data: JSON.stringify(redacted),
        event: "log",
        id: String(entry.sequence),
      });
    });

    stream.onAbort(() => {
      unsub();
    });

    while (true) {
      await stream.sleep(30_000);
      await stream.writeSSE({ data: "", event: "heartbeat", id: "" });
    }
  });
});

// Identity JSON (public — referenced by on-chain agentURI, must be before auth middleware)
app.route(
  API_PATHS.intents,
  createIdentityRoutes({
    get repo() {
      return repo;
    },
  }),
);

// Intent CRUD routes (auth required)
// Both patterns needed: /* matches sub-paths, bare path matches exact /api/intents
app.use(`${API_PATHS.intents}/*`, requireAuth);
app.use(API_PATHS.intents, requireAuth);
app.route(
  API_PATHS.intents,
  createIntentRoutes({
    get repo() {
      return repo;
    },
    workerPool,
  }),
);

// ---------------------------------------------------------------------------
// Dashboard static files + SPA fallback
// ---------------------------------------------------------------------------

app.use(
  "/_next/*",
  serveStatic({ root: DASHBOARD_DIST }),
);
app.use(
  "/favicon.ico",
  serveStatic({ root: DASHBOARD_DIST }),
);
app.use(
  "/maw-agent.svg",
  serveStatic({ root: DASHBOARD_DIST }),
);
app.use(
  "/sponsors/*",
  serveStatic({ root: DASHBOARD_DIST }),
);

// SPA fallback — serve index.html for all non-API routes.
// Read once at mount time to avoid blocking readFileSync on every request.
const indexPath = join(DASHBOARD_DIST, "index.html");
const cachedIndexHtml = existsSync(indexPath)
  ? readFileSync(indexPath, "utf-8")
  : null;

app.get("*", (c) => {
  if (cachedIndexHtml) {
    return c.html(cachedIndexHtml);
  }

  return c.html(`<!doctype html>
<html><head><title>Maw API</title></head>
<body style="font-family:monospace;background:#0a0c0f;color:#c9d1d9;padding:2rem">
<h1 style="color:#00ff9d">MAW</h1>
<p>Agent API is running. Dashboard not built yet.</p>
<p>API endpoints:</p>
<ul>
<li>GET /api/auth/nonce?wallet= — request auth nonce</li>
<li>POST /api/auth/verify — verify wallet signature</li>
<li>POST /api/parse-intent — parse intent text</li>
<li>POST /api/intents — create new intent</li>
<li>GET /api/intents?wallet= — list intents</li>
<li>GET /api/intents/:id — get intent detail</li>
<li>DELETE /api/intents/:id — cancel intent</li>
<li>GET /api/intents/:id/events — SSE stream of live log entries</li>
<li>GET /api/intents/:id/logs — download intent logs</li>
<li>GET /api/intents/:id/identity.json — agent identity (public, no auth)</li>
<li>GET /api/evidence/:intentId/:hash — retrieve evidence document</li>
</ul>
<p style="color:#6e7681">Build the dashboard: <code>pnpm --filter @maw/dashboard build</code></p>
</body></html>`);
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function startup() {
  // Initialize database (DB_PATH env var allows e2e tests to use isolated DBs)
  const dbPath = process.env.DB_PATH || "data/maw.db";
  repo = new IntentRepository(getDb(dbPath));

  // Wire up worker factory so WorkerPool can create AgentWorker instances
  workerPool.setWorkerFactory(
    (intentId) => new DefaultAgentWorker(intentId, { repo }),
  );

  const agentAccount = privateKeyToAccount(env.AGENT_PRIVATE_KEY);

  logger.info("=".repeat(60));
  logger.info("  MAW — Dashboard Server");
  logger.info("=".repeat(60));
  logger.info(`  Agent address:  ${agentAccount.address}`);
  logger.info(`  Dashboard:      http://localhost:${PORT}`);
  logger.info(`  API:            http://localhost:${PORT}/api/intents`);
  logger.info("=".repeat(60));

  serve({ fetch: app.fetch, port: PORT }, () => {
    logger.info(`[server] Listening on http://localhost:${PORT}`);
  });

  // Resume active intents from database
  try {
    const result = await resumeActiveIntents(
      repo,
      (intentId) => workerPool.start(intentId),
    );
    if (result.expired > 0 || result.resumed > 0) {
      logger.info(
        { expired: result.expired, resumed: result.resumed },
        "Startup resumption complete",
      );
    }
  } catch (err) {
    logger.error({ err }, "Startup resumption failed");
  }
}

startup();
