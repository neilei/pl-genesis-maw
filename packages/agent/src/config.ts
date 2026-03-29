/**
 * Environment validation (via Zod), contract addresses, chain configs, and API endpoints.
 * Loaded at startup by every module that touches external services.
 *
 * @module @maw/agent/config
 */
import { config as dotenvConfig } from "dotenv";
import { resolve } from "path";
import { z } from "zod";
import { type Chain, type Address, type Transport, http, fallback } from "viem";
import { sepolia, baseSepolia, base } from "viem/chains";

// Load .env from project root. First call handles cwd=root, second handles cwd=packages/agent/.
// dotenv silently skips missing files and won't overwrite already-set vars.
dotenvConfig({ path: resolve(process.cwd(), ".env"), quiet: true });
dotenvConfig({ path: resolve(process.cwd(), "..", "..", ".env"), quiet: true });

// ── Environment ──────────────────────────────────────────────────────

const envSchema = z.object({
  VENICE_API_KEY: z.string().min(1),
  VENICE_BASE_URL: z.string().url().default("https://api.venice.ai/api/v1/"),
  VENICE_MODEL_OVERRIDE: z.string().optional(),
  UNISWAP_API_KEY: z.string().min(1),
  AGENT_PRIVATE_KEY: z
    .string()
    .startsWith("0x")
    .transform((v) => v as `0x${string}`),
  THEGRAPH_API_KEY: z.string().optional(),
  SEPOLIA_RPC_URL: z
    .string()
    .url()
    .default("https://ethereum-sepolia-rpc.publicnode.com"),
  BASE_SEPOLIA_RPC_URL: z
    .string()
    .url()
    .default("https://base-sepolia-rpc.publicnode.com"),
  BASE_RPC_URL: z
    .string()
    .url()
    .default("https://base-rpc.publicnode.com"),
  JUDGE_PRIVATE_KEY: z
    .string()
    .optional()
    .transform((v) =>
      v && v.startsWith("0x") ? (v as `0x${string}`) : undefined,
    ),
  CMC_PRO_API_KEY: z.string().optional(),
  FILECOIN_WALLET_PRIVATE_KEY: z
    .string()
    .startsWith("0x")
    .transform((v) => v as `0x${string}`),
  FILECOIN_RPC: z
    .string()
    .url()
    .default("https://rpc.ankr.com/filecoin_testnet"),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("Missing or invalid environment variables:");
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;

// ── Chains ───────────────────────────────────────────────────────────

export type ChainEnv = "sepolia" | "base-sepolia" | "base";

export const CHAINS: Record<ChainEnv, Chain> = {
  sepolia,
  "base-sepolia": baseSepolia,
  base,
};

// ── Contract addresses ───────────────────────────────────────────────

export const CONTRACTS = {
  // Infrastructure
  DELEGATION_MANAGER: "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3" as Address,
  PERMIT2: "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address,

  // Uniswap Universal Router
  UNISWAP_ROUTER_SEPOLIA:
    "0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b" as Address,
  UNISWAP_ROUTER_MAINNET:
    "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD" as Address,

  // Tokens — Sepolia
  NATIVE_ETH: "0x0000000000000000000000000000000000000000" as Address,
  WETH_SEPOLIA: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14" as Address,
  USDC_SEPOLIA: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" as Address,

  // Tokens — Base Mainnet
  WETH_BASE: "0x4200000000000000000000000000000000000006" as Address,
  USDC_BASE: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address,

  // ERC-8004 Identity
  IDENTITY_BASE_SEPOLIA:
    "0x8004A818BFB912233c491871b3d84c89A494BD9e" as Address,
  IDENTITY_BASE_MAINNET:
    "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" as Address,

  // ERC-8004 Reputation
  REPUTATION_BASE_SEPOLIA:
    "0x8004B663056A597Dffe9eCcC1965A193B7388713" as Address,
  REPUTATION_BASE_MAINNET:
    "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63" as Address,

  // ERC-8004 Validation
  VALIDATION_BASE_SEPOLIA:
    "0x8004Cb1BF31DAf7788923b405b754f57acEB4272" as Address,
  VALIDATION_BASE_MAINNET:
    "0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58" as Address,
} as const;

// ── API endpoints ────────────────────────────────────────────────────

export const UNISWAP_API_BASE = "https://trade-api.gateway.uniswap.org/v1";

const THEGRAPH_SUBGRAPH_ID =
  "5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV";

export const THEGRAPH_UNISWAP_V3_BASE = env.THEGRAPH_API_KEY
  ? `https://gateway.thegraph.com/api/${env.THEGRAPH_API_KEY}/subgraphs/id/${THEGRAPH_SUBGRAPH_ID}`
  : `https://gateway.thegraph.com/api/subgraphs/id/${THEGRAPH_SUBGRAPH_ID}`;

// ── RPC Transports ──────────────────────────────────────────────────

const RPC_URLS: Record<ChainEnv, string> = {
  sepolia: env.SEPOLIA_RPC_URL,
  "base-sepolia": env.BASE_SEPOLIA_RPC_URL,
  base: env.BASE_RPC_URL,
};

const FALLBACK_RPC_URLS: Record<ChainEnv, string> = {
  sepolia: "https://rpc.sepolia.org",
  "base-sepolia": "https://sepolia.base.org",
  base: "https://mainnet.base.org",
};


const CHAIN_ID_TO_ENV: Record<number, ChainEnv> = {
  11155111: "sepolia",
  84532: "base-sepolia",
  8453: "base",
};

const RPC_OPTIONS = { retryCount: 3, retryDelay: 1000, timeout: 30_000 } as const;

export function rpcTransport(chainOrEnv: ChainEnv | Chain): Transport {
  if (typeof chainOrEnv === "string") {
    return fallback([
      http(RPC_URLS[chainOrEnv], RPC_OPTIONS),
      http(FALLBACK_RPC_URLS[chainOrEnv], RPC_OPTIONS),
    ]);
  }
  const envKey = CHAIN_ID_TO_ENV[chainOrEnv.id];
  if (!envKey) {
    return http(undefined, RPC_OPTIONS);
  }
  return fallback([http(RPC_URLS[envKey], RPC_OPTIONS), http(FALLBACK_RPC_URLS[envKey], RPC_OPTIONS)]);
}
