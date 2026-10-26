import { describe, expect, it } from "vitest";

import { resolveConfig } from "./config.js";

describe("resolveConfig", () => {
  it("pays in USDG on Robinhood Chain by default", () => {
    const config = resolveConfig({});
    expect(config).toMatchObject({ name: "mainnet", payOn: "robinhood", network: "eip155:4663", token: "USDG", permit2: true });
  });

  it("pays in USDC on Base with BRAINCHAIN_PAY_ON=base, to the same desk", () => {
    const config = resolveConfig({ BRAINCHAIN_PAY_ON: "base" });
    expect(config).toMatchObject({
      payOn: "base",
      network: "eip155:8453",
      chainId: 8453,
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      payTo: resolveConfig({}).payTo,
      token: "USDC",
      chain: "Base",
      permit2: false,
    });
    expect(config.terms).toEqual({ cost: "1 USDC", chain: "Base", finalAfter: "about six hours" });
  });

  it("pairs testnet with Base Sepolia", () => {
    expect(resolveConfig({ BRAINCHAIN_NETWORK: "testnet", BRAINCHAIN_PAY_ON: "Base" })).toMatchObject({
      network: "eip155:84532",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      payTo: resolveConfig({ BRAINCHAIN_NETWORK: "testnet" }).payTo,
      chain: "Base Sepolia",
      token: "test USDC",
    });
  });

  it("refuses an unknown chain", () => {
    expect(() => resolveConfig({ BRAINCHAIN_PAY_ON: "solana" })).toThrow(/robinhood or base/);
  });
});
