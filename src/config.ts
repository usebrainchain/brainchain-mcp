import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import type { Terms } from "./tools.js";

const MAINNET_DESK = { desk: "https://brain.usebrainchain.com", payTo: "0xafB0C4Ef895D4895040cdC6435B96D3EE8350c6E", finalAfter: "about six hours" } as const;
const TESTNET_DESK = { desk: "https://brain.testnet.usebrainchain.com", payTo: "0xf848984c8A0D9E49Cc9C97380C62b34C6f3b97D1", finalAfter: "about an hour" } as const;

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
/**
 * How long an identical post returns the first order instead of paying again.
 * Longer than MAX_TIMEOUT_SECONDS, so by the time it lapses the desk has
 * recorded any order it charged.
 */
export const REPOST_AFTER_MINUTES = 15;
const DEFAULT_MAX_PRICE = 1_000_000n;
const DEFAULT_BUDGET = 10_000_000n;

export interface Config {
  name: "mainnet" | "testnet";
  /** The chain payments are taken on, and refunds sent back on. */
  payOn: "robinhood" | "base";
  /** USDG pays through Permit2 after a one-time approval; USDC pays by EIP-3009 signature. */
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
  /** The most the wallet pays per UTC day across restarts, servers and payment chains, when set. */
  daily?: bigint;
  /** Where the daily limit's spending record is kept. */
  stateDir: string;
  terms: Terms;
}

export function formatUnits(units: bigint): string {
  const whole = units / 10n ** BigInt(DECIMALS);
  const fraction = (units % 10n ** BigInt(DECIMALS)).toString().padStart(DECIMALS, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

/** MCP clients often pass optional variables as empty strings; those count as unset. */
function envString(env: Record<string, string | undefined>, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function envUnits(env: Record<string, string | undefined>, name: string, fallback: bigint): bigint {
  const raw = envString(env, name) ?? fallback.toString();
  if (!/^\d+$/.test(raw) || BigInt(raw) === 0n) throw new Error(`${name} must be a positive whole number of base units.`);
  return BigInt(raw);
}

function envAddress(env: Record<string, string | undefined>, name: string, fallback: string): `0x${string}` {
  const value = envString(env, name) ?? fallback;
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`${name} must be a 0x-prefixed, 40-character hex address.`);
  return value as `0x${string}`;
}

/** MCP clients start servers without a shell, so nothing else expands the ~ in a config file. */
export function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

/** A relative path would follow whatever directory the client starts in, and a daily limit kept there would reset without a word. */
function envDirectory(env: Record<string, string | undefined>, name: string, fallback: string): string {
  const raw = envString(env, name);
  if (raw === undefined) return fallback;
  const path = expandHome(raw);
  if (!isAbsolute(path)) throw new Error(`${name} must be an absolute path or start with ~/.`);
  return path;
}

/** The value is never echoed: an RPC URL can carry a key. */
function envUrl(env: Record<string, string | undefined>, name: string, fallback: string): string {
  const value = envString(env, name) ?? fallback;
  if (!URL.canParse(value) || !["http:", "https:"].includes(new URL(value).protocol)) throw new Error(`${name} must be an http or https URL.`);
  return value;
}

/** Signed payments travel to the desk, so plain http is allowed only where they never leave the machine. */
function envDesk(env: Record<string, string | undefined>, fallback: string): string {
  const desk = envUrl(env, "BRAINCHAIN_DESK_URL", fallback).replace(/\/+$/, "");
  const { protocol, hostname } = new URL(desk);
  if (protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(hostname)) {
    throw new Error("BRAINCHAIN_DESK_URL must be an https URL, or http on localhost or 127.0.0.1.");
  }
  return desk;
}

export function resolveConfig(env: Record<string, string | undefined>): Config {
  const name = (envString(env, "BRAINCHAIN_NETWORK") ?? "mainnet").toLowerCase();
  if (name !== "mainnet" && name !== "testnet") throw new Error("BRAINCHAIN_NETWORK must be mainnet or testnet.");
  const payOn = (envString(env, "BRAINCHAIN_PAY_ON") ?? "robinhood").toLowerCase();
  if (payOn !== "robinhood" && payOn !== "base") throw new Error("BRAINCHAIN_PAY_ON must be robinhood or base.");
  const preset = PRESETS[name][payOn];

  const network = envString(env, "BRAINCHAIN_PAYMENT_NETWORK") ?? preset.network;
  const match = /^eip155:(\d+)$/.exec(network);
  if (!match) throw new Error("BRAINCHAIN_PAYMENT_NETWORK must look like eip155:<chain id>.");
  const maxPrice = envUnits(env, "BRAINCHAIN_MAX_PRICE_UNITS", DEFAULT_MAX_PRICE);
  const budget = envUnits(env, "BRAINCHAIN_BUDGET_UNITS", DEFAULT_BUDGET);
  if (budget < maxPrice) throw new Error("BRAINCHAIN_BUDGET_UNITS must be at least BRAINCHAIN_MAX_PRICE_UNITS.");
  const daily = envString(env, "BRAINCHAIN_DAILY_UNITS") === undefined ? undefined : envUnits(env, "BRAINCHAIN_DAILY_UNITS", 0n);
  if (daily !== undefined && daily < maxPrice) throw new Error("BRAINCHAIN_DAILY_UNITS must be at least BRAINCHAIN_MAX_PRICE_UNITS.");

  return {
    name,
    payOn,
    permit2: preset.permit2,
    desk: envDesk(env, preset.desk),
    network: network as `eip155:${number}`,
    chainId: Number(match[1]),
    asset: envAddress(env, "BRAINCHAIN_PAYMENT_ASSET", preset.asset),
    payTo: envAddress(env, "BRAINCHAIN_PAY_TO", preset.payTo),
    rpc: envUrl(env, "BRAINCHAIN_PAYMENT_RPC", preset.rpc),
    chain: preset.chain,
    token: preset.token,
    maxPrice,
    budget,
    ...(daily !== undefined ? { daily } : {}),
    stateDir: envDirectory(env, "BRAINCHAIN_STATE_DIR", join(homedir(), ".brainchain")),
    terms: {
      cost: maxPrice === DEFAULT_MAX_PRICE ? `1 ${preset.token}` : `at most ${formatUnits(maxPrice)} ${preset.token}`,
      chain: preset.chain,
      finalAfter: preset.finalAfter,
    },
  };
}
