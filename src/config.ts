import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import { MIN_BOND } from "./shipped.js";
import type { Terms } from "./tools.js";

const MAINNET_DESK = { desk: "https://brain.usebrainchain.com", payTo: "0x97D558417c3D61f1074422AD843e1Db1E565b952", finalAfter: "about six hours" } as const;
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

/**
 * Delivery bonds on Shipped, which lives on Robinhood Chain only. The ProofIndex
 * is named once BrainChain deploys it; until then bonds are closed.
 */
export interface BondsConfig {
  registry: `0x${string}`;
  check: `0x${string}`;
  proofIndex?: `0x${string}`;
  usdg: `0x${string}`;
  rpc: string;
  chain: string;
  /** BrainChain itself, where the task is read. `retired` boards took bonds that can still be open, and task ids restart with each board. */
  brainchain: { rpc: string; chainId: number; board: `0x${string}`; retired?: `0x${string}`[] };
}

const BONDS: Record<"mainnet" | "testnet", BondsConfig | undefined> = {
  mainnet: {
    registry: "0xD5Da523ee49CB7Fe855B0C6fa38707190A9D531F",
    check: "0x2e7C4F0F2e6079C3B5F7Cd2440308234CBDc537D",
    usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    proofIndex: "0x0fb02559e704549794EdF3FBBBe91DB88bB849ee",
    rpc: "https://rpc.mainnet.chain.robinhood.com",
    chain: "Robinhood Chain",
    brainchain: { rpc: "https://rpc.usebrainchain.com", chainId: 274663, board: "0x44b8464342Bbfb9B565FAE494DfDefa37D33A211", retired: ["0x8385bb4b8990411CcdD8e851B2676da1A4C1f3C4"] },
  },
  testnet: undefined,
};

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
/** What the desk asks for a task and for a grade. A higher BRAINCHAIN_MAX_PRICE_UNITS is a ceiling, not what either costs. */
export const PRICE = { task: 1_000_000n, grade: 250_000n } as const;
const DEFAULT_BUDGET = 10_000_000n;
const DEFAULT_MAX_BOND = 10_000_000n;

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
  /** The most this server pays for one task or grade, in the asset's smallest unit. */
  maxPrice: bigint;
  /** The most this server process pays in total, in the asset's smallest unit. */
  budget: bigint;
  /** The most the wallet pays per UTC day across restarts, servers and payment chains, when set. */
  daily?: bigint;
  /** Where the daily limit's spending record is kept. */
  stateDir: string;
  terms: Terms;
  /** The most this server locks in one delivery bond, in USDG units; bonds also draw on the budget and the daily limit. */
  maxBond: bigint;
  /** Shipped's registry and BrainChain's index for bonds; absent on a network without them. */
  bonds?: BondsConfig;
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

/** Settings only a payment reads: one the server cannot use stops the tools that pay, and the rest go on without it. */
export const PAYMENT_SETTINGS = [
  "BRAINCHAIN_MAX_PRICE_UNITS",
  "BRAINCHAIN_BUDGET_UNITS",
  "BRAINCHAIN_DAILY_UNITS",
  "BRAINCHAIN_MAX_BOND_UNITS",
  "BRAINCHAIN_STATE_DIR",
  "BRAINCHAIN_PAY_TO",
  "BRAINCHAIN_PAYMENT_NETWORK",
  "BRAINCHAIN_PAYMENT_ASSET",
  "BRAINCHAIN_PAYMENT_RPC",
];

/** With `payments: false` the PAYMENT_SETTINGS are left at the preset, for a server that only reads until they are fixed. */
export function resolveConfig(given: Record<string, string | undefined>, { payments = true } = {}): Config {
  const env = payments ? given : Object.fromEntries(Object.entries(given).filter(([name]) => !PAYMENT_SETTINGS.includes(name)));
  const name = (envString(env, "BRAINCHAIN_NETWORK") ?? "mainnet").toLowerCase();
  if (name !== "mainnet" && name !== "testnet") throw new Error("BRAINCHAIN_NETWORK must be mainnet or testnet.");
  const payOn = (envString(env, "BRAINCHAIN_PAY_ON") ?? "base").toLowerCase();
  if (payOn !== "robinhood" && payOn !== "base") throw new Error("BRAINCHAIN_PAY_ON must be robinhood or base.");
  const preset = PRESETS[name][payOn];

  const network = envString(env, "BRAINCHAIN_PAYMENT_NETWORK") ?? preset.network;
  const match = /^eip155:(\d+)$/.exec(network);
  if (!match) throw new Error("BRAINCHAIN_PAYMENT_NETWORK must look like eip155:<chain id>.");
  const maxPrice = envUnits(env, "BRAINCHAIN_MAX_PRICE_UNITS", PRICE.task);
  const budget = envUnits(env, "BRAINCHAIN_BUDGET_UNITS", DEFAULT_BUDGET);
  const both = (name: string, units: bigint) =>
    `${name} must be at least BRAINCHAIN_MAX_PRICE_UNITS: it is ${units} (${formatUnits(units)} ${preset.token}), and BRAINCHAIN_MAX_PRICE_UNITS is ${maxPrice} (${formatUnits(maxPrice)} ${preset.token}).`;
  if (budget < maxPrice) throw new Error(both("BRAINCHAIN_BUDGET_UNITS", budget));
  const daily = envString(env, "BRAINCHAIN_DAILY_UNITS") === undefined ? undefined : envUnits(env, "BRAINCHAIN_DAILY_UNITS", 0n);
  if (daily !== undefined && daily < maxPrice) throw new Error(both("BRAINCHAIN_DAILY_UNITS", daily));
  const maxBond = envUnits(env, "BRAINCHAIN_MAX_BOND_UNITS", DEFAULT_MAX_BOND);
  if (maxBond < MIN_BOND) throw new Error(`BRAINCHAIN_MAX_BOND_UNITS must be at least ${MIN_BOND} (${formatUnits(MIN_BOND)} USDG), the smallest bond this server places.`);
  const bonds = BONDS[name];
  const desk = envDesk(env, preset.desk);
  // The preset's payee belongs to the preset's desk, so a desk of one's own must say where it is paid.
  if (payments && new URL(desk).href !== new URL(preset.desk).href && envString(env, "BRAINCHAIN_PAY_TO") === undefined) {
    throw new Error("BRAINCHAIN_DESK_URL names a desk other than the network's own, so set BRAINCHAIN_PAY_TO to the address that desk takes payment at: this server pays no other address.");
  }
  // Under a raised ceiling the desk may have raised its prices too, so a cost is named only up to the ceiling.
  const cost = (price: bigint) => (maxPrice > PRICE.task ? `at most ${formatUnits(maxPrice)} ${preset.token}` : `${formatUnits(price)} ${preset.token}`);
  const refused = (price: bigint, what: string) =>
    maxPrice < price
      ? `This server pays at most ${formatUnits(maxPrice)} ${preset.token} at a time (BRAINCHAIN_MAX_PRICE_UNITS), under that price, so ${what} are refused and nothing is charged until the operator raises it.`
      : undefined;
  const refuses = { task: refused(PRICE.task, "posts"), grade: refused(PRICE.grade, "grades") };

  return {
    name,
    payOn,
    permit2: preset.permit2,
    desk,
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
    maxBond,
    ...(bonds ? { bonds } : {}),
    terms: {
      cost: cost(PRICE.task),
      gradeCost: cost(PRICE.grade),
      ...(refuses.task ? { refuses } : {}),
      chain: preset.chain,
      finalAfter: preset.finalAfter,
    },
  };
}
