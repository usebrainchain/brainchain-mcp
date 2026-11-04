import { homedir } from "node:os";
import { join } from "node:path";

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

  it("treats empty and blank variables as unset, as MCP clients often pass them", () => {
    expect(resolveConfig({ BRAINCHAIN_NETWORK: "", BRAINCHAIN_PAY_ON: " ", BRAINCHAIN_PAYMENT_NETWORK: "", BRAINCHAIN_MAX_PRICE_UNITS: "" })).toMatchObject({
      name: "mainnet",
      payOn: "robinhood",
      network: "eip155:4663",
      maxPrice: 1_000_000n,
    });
  });

  it("expands ~ in the state directory, since no shell does it for an MCP client", () => {
    expect(resolveConfig({}).stateDir).toBe(join(homedir(), ".brainchain"));
    expect(resolveConfig({ BRAINCHAIN_STATE_DIR: "~/.brainchain-audit" }).stateDir).toBe(join(homedir(), ".brainchain-audit"));
    expect(resolveConfig({ BRAINCHAIN_STATE_DIR: "/var/brainchain" }).stateDir).toBe("/var/brainchain");
  });

  it("refuses a state directory that would follow wherever the client starts", () => {
    for (const path of ["state", "./state", "~other/state", "$HOME/state"]) {
      expect(() => resolveConfig({ BRAINCHAIN_STATE_DIR: path })).toThrow("BRAINCHAIN_STATE_DIR must be an absolute path or start with ~/.");
    }
  });

  it("refuses a desk or RPC that is not a URL, without echoing it", () => {
    for (const name of ["BRAINCHAIN_DESK_URL", "BRAINCHAIN_PAYMENT_RPC"]) {
      for (const value of ["notaurl", "ftp://example.com", "file:///etc/passwd"]) {
        expect(() => resolveConfig({ [name]: value })).toThrow(new RegExp(`^${name} must be an http or https URL\\.$`));
      }
    }
    expect(resolveConfig({ BRAINCHAIN_DESK_URL: "http://localhost:8080/" }).desk).toBe("http://localhost:8080");
  });

  it("refuses an unknown chain", () => {
    expect(() => resolveConfig({ BRAINCHAIN_PAY_ON: "solana" })).toThrow(/robinhood or base/);
  });
});
