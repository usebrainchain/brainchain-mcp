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

  it("sends payments to a desk over https, or plain http only on this machine", () => {
    expect(() => resolveConfig({ BRAINCHAIN_DESK_URL: "http://desk.example.com" })).toThrow(
      /^BRAINCHAIN_DESK_URL must be an https URL, or http on localhost or 127\.0\.0\.1\.$/,
    );
    expect(resolveConfig({ BRAINCHAIN_DESK_URL: "http://127.0.0.1:8080" }).desk).toBe("http://127.0.0.1:8080");
    expect(resolveConfig({ BRAINCHAIN_DESK_URL: "http://[::1]:8080" }).desk).toBe("http://[::1]:8080");
    expect(resolveConfig({ BRAINCHAIN_DESK_URL: "https://desk.example.com//" }).desk).toBe("https://desk.example.com");
  });

  it("pays in USDC on Solana with BRAINCHAIN_PAY_ON=solana, to the desk's Solana wallet", () => {
    const config = resolveConfig({ BRAINCHAIN_PAY_ON: "solana" });
    expect(config).toMatchObject({
      payOn: "solana",
      network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      payTo: "3dE26QRuereRQWFd8ZTKcoAmNVPxdzJyPUsgarYScCrL",
      rpc: "https://api.mainnet-beta.solana.com",
      desk: resolveConfig({}).desk,
      token: "USDC",
      chain: "Solana",
      permit2: false,
    });
    expect(config.chainId).toBeUndefined();
    expect(config.terms).toEqual({ cost: "1 USDC", chain: "Solana", finalAfter: "about six hours" });
  });

  it("pairs testnet with Solana devnet and the testnet desk's Solana wallet", () => {
    expect(resolveConfig({ BRAINCHAIN_NETWORK: "testnet", BRAINCHAIN_PAY_ON: "Solana" })).toMatchObject({
      network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      payTo: "AeRePM6UDB8onv5Mt9crXSaxfH8ivd7L7X71iqRaZ3Qi",
      rpc: "https://api.devnet.solana.com",
      desk: resolveConfig({ BRAINCHAIN_NETWORK: "testnet" }).desk,
      chain: "Solana devnet",
      token: "test USDC",
    });
  });

  it("checks overrides on Solana as Solana addresses and a solana: network", () => {
    const solana = { BRAINCHAIN_PAY_ON: "solana" };
    expect(() => resolveConfig({ ...solana, BRAINCHAIN_PAY_TO: "0xafB0C4Ef895D4895040cdC6435B96D3EE8350c6E" })).toThrow("BRAINCHAIN_PAY_TO must be a Solana address when BRAINCHAIN_PAY_ON is solana.");
    expect(() => resolveConfig({ ...solana, BRAINCHAIN_PAYMENT_ASSET: "not-a-mint" })).toThrow("BRAINCHAIN_PAYMENT_ASSET must be a Solana address");
    expect(() => resolveConfig({ ...solana, BRAINCHAIN_PAYMENT_NETWORK: "eip155:8453" })).toThrow(/solana:<genesis hash>/);
    expect(() => resolveConfig({ BRAINCHAIN_PAYMENT_NETWORK: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" })).toThrow(/eip155:<chain id>/);
    expect(resolveConfig({ ...solana, BRAINCHAIN_PAY_TO: "AeRePM6UDB8onv5Mt9crXSaxfH8ivd7L7X71iqRaZ3Qi" }).payTo).toBe("AeRePM6UDB8onv5Mt9crXSaxfH8ivd7L7X71iqRaZ3Qi");
  });

  it("refuses an unknown chain", () => {
    expect(() => resolveConfig({ BRAINCHAIN_PAY_ON: "ethereum" })).toThrow(/robinhood, base or solana/);
  });
});
