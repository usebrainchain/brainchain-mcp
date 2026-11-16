import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadSettings, type Settings } from "../src/config.ts";
import { commandWorker } from "../src/worker.ts";

const KEY = "59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const ENV = { SELLER_KEY: KEY, SELLER_WORKER: "claude -p" };

describe("settings", () => {
  it("pays the public route in USDC on Base by default, at most 0.25 a grade and 2.50 a day", () => {
    expect(loadSettings(ENV, false)).toEqual({
      judge: {
        url: "https://brain.usebrainchain.com",
        payTo: "0x97D558417c3D61f1074422AD843e1Db1E565b952",
        network: "eip155:8453",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        token: "USDC",
        maxUnits: 250_000n,
        dailyUnits: 2_500_000n,
        dir: fileURLToPath(new URL("../state", import.meta.url)),
        key: `0x${KEY}`,
      },
      worker: "claude -p",
      port: 3000,
    });
  });

  it("keeps its state next to the example wherever it is started from, unless told otherwise", () => {
    const { judge } = loadSettings(ENV, false) as Settings;
    expect(isAbsolute(judge.dir)).toBe(true);
    expect(judge.dir).toBe(join(dirname(fileURLToPath(import.meta.url)), "..", "state"));
    expect((loadSettings({ ...ENV, SELLER_STATE_DIR: "/var/seller" }, false) as Settings).judge.dir).toBe("/var/seller");
  });

  it("takes a partner, Robinhood Chain and testnet", () => {
    const settings = loadSettings({ ...ENV, BRAINCHAIN_PARTNER: "acme", SELLER_PAY_ON: "robinhood", BRAINCHAIN_NETWORK: "testnet", SELLER_DAILY_UNITS: "1000000" }, false);
    expect(settings).toMatchObject({
      judge: { url: "https://brain.testnet.usebrainchain.com", partner: "acme", network: "eip155:46630", token: "test USDG", dailyUnits: 1_000_000n },
    });
  });

  it("needs no key for a dry run, and never pays in one", () => {
    expect(loadSettings({ SELLER_WORKER: "claude -p" }, true)).toMatchObject({ judge: { url: "https://brain.usebrainchain.com" } });
    expect(loadSettings(ENV, true)).not.toHaveProperty("judge.key");
  });

  it.each([
    [{ SELLER_KEY: undefined }, /^SELLER_KEY is the private key/],
    [{ SELLER_KEY: "0x1234" }, /^SELLER_KEY is the private key/],
    [{ SELLER_WORKER: " " }, /^SELLER_WORKER is the command/],
    [{ BRAINCHAIN_PARTNER: "Acme Corp" }, /^BRAINCHAIN_PARTNER is the partner name/],
    [{ SELLER_MAX_GRADE_UNITS: "0.25" }, /^SELLER_MAX_GRADE_UNITS is the most one grade may cost/],
    [{ SELLER_PAY_ON: "solana" }, /^SELLER_PAY_ON is base/],
  ])("refuses %o", (change, message) => {
    expect(loadSettings({ ...ENV, ...change }, false)).toMatch(message);
  });
});

describe("a command worker", () => {
  it("hands the job to the command on stdin and returns what it prints", async () => {
    expect(await commandWorker("tr a-z A-Z")("def f(): pass")).toBe("DEF F(): PASS");
  });

  it("takes the work of a command that never reads the job", async () => {
    await expect(commandWorker("printf done")("x".repeat(1 << 20))).resolves.toBe("done");
  });

  it("says why a command failed", async () => {
    await expect(commandWorker("echo out of credit >&2; exit 3")("job")).rejects.toThrow("The worker exited with 3: out of credit");
  });
});
