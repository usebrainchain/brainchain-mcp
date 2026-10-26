import type { Terms } from "./tools.js";

const MAINNET_DESK = { desk: "https://brain.usebrainchain.com", payTo: "0xafB0C4Ef895D4895040cdC6435B96D3EE8350c6E", finalAfter: "about six hours" } as const;
const TESTNET_DESK = { desk: "https://brain.testnet.usebrainchain.com", payTo: "0xf848984c8A0D9E49Cc9C97380C62b34C6f3b97D1", finalAfter: "about an hour" } as const;

/**
 * Payment settings for each BrainChain network and each chain its desk takes
 * payment on. Mainnet on Robinhood Chain is the default. USDG pays through
 * Permit2, after a one-time approval; USDC on Base pays by EIP-3009 signature.
 */
const PRESETS = {
  mainnet: {
    robinhood: {
      ...MAINNET_DESK,
      network: "eip155:4663",
      asset: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
      rpc: "https://rpc.mainnet.chain.robinhood.com",
      chain: "Robinhood Chain",
      token: "USDG",
      permit2: true,
    },
    base: {
      ...MAINNET_DESK,
      network: "eip155:8453",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      rpc: "https://mainnet.base.org",
      chain: "Base",
      token: "USDC",
      permit2: false,
    },
  },
  testnet: {
    robinhood: {
      ...TESTNET_DESK,
      network: "eip155:46630",
      asset: "0x1eC185467cA2D5d1c24f0EdCB91301Bca4d0a787",
      rpc: "https://rpc.testnet.chain.robinhood.com",
      chain: "Robinhood Chain testnet",
      token: "test USDG",
      permit2: true,
    },
    base: {
      ...TESTNET_DESK,
      network: "eip155:84532",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      rpc: "https://sepolia.base.org",
      chain: "Base Sepolia",
      token: "test USDC",
      permit2: false,
    },
  },
} as const;

/** USDG, USDC and their test versions all use 6 decimals. */
export const DECIMALS = 6;
/** A payment authorization may stay valid for at most this long. */
export const MAX_TIMEOUT_SECONDS = 600;
const DEFAULT_MAX_PRICE = 1_000_000n;
const DEFAULT_BUDGET = 10_000_000n;

export interface Config {
  name: "mainnet" | "testnet";
  /** The chain payments are taken on, and refunds sent back on. */
  payOn: "robinhood" | "base";
  /** Whether the token pays through Permit2, which needs a one-time approval. */
  permit2: boolean;
  desk: string;
  network: `eip155:${number}`;
  chainId: number;
  asset: `0x${string}`;
  /** The desk's address; the server refuses to pay anyone else. */
  payTo: `0x${string}`;
  rpc: string;
  chain: string;
  token: string;
  /** The most this server pays for one task, in the asset's smallest unit. */
  maxPrice: bigint;
  /** The most this server process pays in total, in the asset's smallest unit. */
  budget: bigint;
  terms: Terms;
}

export function formatUnits(units: bigint): string {
  const whole = units / 10n ** BigInt(DECIMALS);
  const fraction = (units % 10n ** BigInt(DECIMALS)).toString().padStart(DECIMALS, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

function envUnits(env: Record<string, string | undefined>, name: string, fallback: bigint): bigint {
  const raw = env[name] ?? fallback.toString();
  if (!/^\d+$/.test(raw) || BigInt(raw) === 0n) throw new Error(`${name} must be a positive whole number of base units.`);
  return BigInt(raw);
}

function envAddress(env: Record<string, string | undefined>, name: string, fallback: string): `0x${string}` {
  const value = env[name] ?? fallback;
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`${name} must be an address.`);
  return value as `0x${string}`;
}

export function resolveConfig(env: Record<string, string | undefined>): Config {
  const name = (env.BRAINCHAIN_NETWORK ?? "mainnet").toLowerCase();
  if (name !== "mainnet" && name !== "testnet") throw new Error("BRAINCHAIN_NETWORK must be mainnet or testnet.");
  const payOn = (env.BRAINCHAIN_PAY_ON ?? "robinhood").toLowerCase();
  if (payOn !== "robinhood" && payOn !== "base") throw new Error("BRAINCHAIN_PAY_ON must be robinhood or base.");
  const preset = PRESETS[name][payOn];

  const network = env.BRAINCHAIN_PAYMENT_NETWORK ?? preset.network;
  const match = /^eip155:(\d+)$/.exec(network);
  if (!match) throw new Error("BRAINCHAIN_PAYMENT_NETWORK must look like eip155:<chain id>.");
  const maxPrice = envUnits(env, "BRAINCHAIN_MAX_PRICE_UNITS", DEFAULT_MAX_PRICE);
  const budget = envUnits(env, "BRAINCHAIN_BUDGET_UNITS", DEFAULT_BUDGET);
  if (budget < maxPrice) throw new Error("BRAINCHAIN_BUDGET_UNITS must be at least BRAINCHAIN_MAX_PRICE_UNITS.");

  return {
    name,
    payOn,
    permit2: preset.permit2,
    desk: (env.BRAINCHAIN_DESK_URL ?? preset.desk).replace(/\/$/, ""),
    network: network as `eip155:${number}`,
    chainId: Number(match[1]),
    asset: envAddress(env, "BRAINCHAIN_PAYMENT_ASSET", preset.asset),
    payTo: envAddress(env, "BRAINCHAIN_PAY_TO", preset.payTo),
    rpc: env.BRAINCHAIN_PAYMENT_RPC ?? preset.rpc,
    chain: preset.chain,
    token: preset.token,
    maxPrice,
    budget,
    terms: {
      cost: maxPrice === DEFAULT_MAX_PRICE ? `1 ${preset.token}` : `at most ${formatUnits(maxPrice)} ${preset.token}`,
      chain: preset.chain,
      finalAfter: preset.finalAfter,
    },
  };
}
