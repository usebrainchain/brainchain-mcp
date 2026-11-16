import { fileURLToPath } from "node:url";

import type { Address, Hex } from "viem";

import type { JudgeConfig } from "./judge.ts";

const NETWORKS = {
  mainnet: {
    url: "https://brain.usebrainchain.com",
    payTo: "0x97D558417c3D61f1074422AD843e1Db1E565b952",
    base: { network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", token: "USDC" },
    robinhood: { network: "eip155:4663", asset: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", token: "USDG" },
  },
  testnet: {
    url: "https://brain.testnet.usebrainchain.com",
    payTo: "0xf848984c8A0D9E49Cc9C97380C62b34C6f3b97D1",
    base: { network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", token: "test USDC" },
    robinhood: { network: "eip155:46630", asset: "0x1eC185467cA2D5d1c24f0EdCB91301Bca4d0a787", token: "test USDG" },
  },
} as const;

export interface Settings {
  judge: JudgeConfig;
  worker: string;
  port: number;
}

/** The seller's settings from its environment, or what is wrong with them. With `dry`, no key is read and nothing is paid. */
export function loadSettings(env: Record<string, string | undefined>, dry: boolean): Settings | string {
  const value = (name: string) => env[name]?.trim() || undefined;
  const units = (name: string, fallback: bigint) => {
    const text = value(name);
    if (text === undefined) return fallback;
    return /^\d{1,15}$/.test(text) && BigInt(text) > 0n ? BigInt(text) : undefined;
  };

  const network = value("BRAINCHAIN_NETWORK") ?? "mainnet";
  if (network !== "mainnet" && network !== "testnet") return "BRAINCHAIN_NETWORK is mainnet or testnet.";
  const payOn = value("SELLER_PAY_ON") ?? "base";
  if (payOn !== "base" && payOn !== "robinhood") return "SELLER_PAY_ON is base, to pay in USDC on Base, or robinhood, to pay in USDG on Robinhood Chain.";
  const partner = value("BRAINCHAIN_PARTNER");
  if (partner !== undefined && !/^[a-z0-9-]{2,32}$/.test(partner)) return "BRAINCHAIN_PARTNER is the partner name BrainChain gave you: 2 to 32 of a-z, 0-9 and -.";
  const maxUnits = units("SELLER_MAX_GRADE_UNITS", 250_000n);
  if (maxUnits === undefined) return "SELLER_MAX_GRADE_UNITS is the most one grade may cost, in token units: 250000 is 0.25.";
  const dailyUnits = units("SELLER_DAILY_UNITS", 2_500_000n);
  if (dailyUnits === undefined) return "SELLER_DAILY_UNITS is the most grades may cost in a UTC day, in token units: 2500000 is 2.50.";
  const raw = value("SELLER_KEY");
  const key = raw && !raw.startsWith("0x") ? `0x${raw}` : raw;
  if (!dry && (!key || !/^0x[0-9a-fA-F]{64}$/.test(key))) {
    return "SELLER_KEY is the private key of the wallet that pays for grades, 64 hex characters. Run with --dry to print the grade requests without one.";
  }
  const worker = value("SELLER_WORKER");
  if (!worker) return "SELLER_WORKER is the command that does the work. It reads the job on stdin and prints the delivery.";
  const port = Number(value("PORT") ?? "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return "PORT is a TCP port.";

  const preset = NETWORKS[network];
  const lane = preset[payOn];
  return {
    judge: {
      url: preset.url,
      ...(partner ? { partner } : {}),
      payTo: preset.payTo as Address,
      network: lane.network,
      asset: lane.asset as Address,
      token: lane.token,
      maxUnits,
      dailyUnits,
      // Next to the example, not wherever it was started from: a run from another folder would find no orders and a fresh day.
      dir: value("SELLER_STATE_DIR") ?? fileURLToPath(new URL("../state", import.meta.url)),
      ...(dry ? {} : { key: key as Hex }),
    },
    worker,
    port,
  };
}
