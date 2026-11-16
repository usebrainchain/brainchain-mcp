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
    expect(config.terms).toEqual({ cost: "1 USDC", gradeCost: "0.25 USDC", chain: "Base", finalAfter: "about six hours" });
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
    expect(resolveConfig({ BRAINCHAIN_DESK_URL: "http://localhost:8080/", BRAINCHAIN_PAY_TO: "0x000000000000000000000000000000000000dEaD" }).desk).toBe("http://localhost:8080");
  });

  it("sends payments to a desk over https, or plain http only on this machine", () => {
    expect(() => resolveConfig({ BRAINCHAIN_DESK_URL: "http://desk.example.com" })).toThrow(
      /^BRAINCHAIN_DESK_URL must be an https URL, or http on localhost or 127\.0\.0\.1\.$/,
    );
    expect(resolveConfig({ BRAINCHAIN_DESK_URL: "http://127.0.0.1:8080", BRAINCHAIN_PAY_TO: "0x000000000000000000000000000000000000dEaD" }).desk).toBe("http://127.0.0.1:8080");
    expect(resolveConfig({ BRAINCHAIN_DESK_URL: "http://[::1]:8080", BRAINCHAIN_PAY_TO: "0x000000000000000000000000000000000000dEaD" }).desk).toBe("http://[::1]:8080");
    expect(resolveConfig({ BRAINCHAIN_DESK_URL: "https://desk.example.com//", BRAINCHAIN_PAY_TO: "0x000000000000000000000000000000000000dEaD" }).desk).toBe("https://desk.example.com");
  });

  it("needs a payee for a desk other than the network's own", () => {
    const own = "BRAINCHAIN_DESK_URL names a desk other than the network's own, so set BRAINCHAIN_PAY_TO to the address that desk takes payment at: this server pays no other address.";
    expect(() => resolveConfig({ BRAINCHAIN_DESK_URL: "http://localhost:8080" })).toThrow(own);
    expect(() => resolveConfig({ BRAINCHAIN_DESK_URL: "https://brain.testnet.usebrainchain.com" })).toThrow(own);
    expect(resolveConfig({ BRAINCHAIN_DESK_URL: "https://Brain.usebrainchain.com/" }).desk).toBe("https://Brain.usebrainchain.com");
    expect(resolveConfig({ BRAINCHAIN_NETWORK: "testnet", BRAINCHAIN_DESK_URL: "https://brain.testnet.usebrainchain.com" }).payTo).toBe(resolveConfig({ BRAINCHAIN_NETWORK: "testnet" }).payTo);
    // A server that only reads goes to that desk all the same.
    expect(resolveConfig({ BRAINCHAIN_DESK_URL: "http://localhost:8080" }, { payments: false }).desk).toBe("http://localhost:8080");
  });

  it("leaves the settings only payments read at the preset for a server that only reads", () => {
    const env = { BRAINCHAIN_NETWORK: "testnet", BRAINCHAIN_BUDGET_UNITS: "-5", BRAINCHAIN_PAYMENT_RPC: "notaurl", BRAINCHAIN_STATE_DIR: "state", BRAINCHAIN_PAY_TO: "0x12" };
    expect(() => resolveConfig(env)).toThrow();
    expect(resolveConfig(env, { payments: false })).toEqual(resolveConfig({ BRAINCHAIN_NETWORK: "testnet" }));
    expect(() => resolveConfig({ ...env, BRAINCHAIN_PAY_ON: "solana" }, { payments: false })).toThrow("BRAINCHAIN_PAY_ON must be robinhood or base.");
  });

  it("refuses a bond cap under the smallest bond, which would refuse every bond", () => {
    expect(() => resolveConfig({ BRAINCHAIN_MAX_BOND_UNITS: "1999999" })).toThrow("BRAINCHAIN_MAX_BOND_UNITS must be at least 2000000 (2 USDG), the smallest bond this server places.");
    expect(resolveConfig({ BRAINCHAIN_MAX_BOND_UNITS: "2000000" }).maxBond).toBe(2_000_000n);
  });

  it("refuses an unknown chain", () => {
    expect(() => resolveConfig({ BRAINCHAIN_PAY_ON: "solana" })).toThrow(/robinhood or base/);
  });
});
