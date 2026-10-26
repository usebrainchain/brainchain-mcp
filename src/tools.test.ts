import { describe, expect, it } from "vitest";

import { formatUnits, resolveConfig } from "./config.js";
import { callTool, GET_TASK_NAME, POST_TASK_NAME, postTaskTool, type Desk } from "./tools.js";

const desk: Desk = {
  post: async (task) => ({ order: "0x01", task }),
  get: async (order) => ({ order, state: "posted" }),
};

function body(result: Awaited<ReturnType<typeof callTool>>): unknown {
  return JSON.parse((result.content[0] as { text: string }).text);
}

describe("callTool", () => {
  it("posts a task", async () => {
    const result = await callTool(desk, POST_TASK_NAME, { title: "t", brief: "b", levels: ["good", "ok"] });
    expect(result.isError).toBe(false);
    expect(body(result)).toMatchObject({ order: "0x01" });
  });

  it("rejects a post without levels", async () => {
    const result = await callTool(desk, POST_TASK_NAME, { title: "t", brief: "b" });
    expect(result.isError).toBe(true);
  });

  it("rejects a malformed order id", async () => {
    expect((await callTool(desk, GET_TASK_NAME, { order: "42" })).isError).toBe(true);
  });

  it("reports desk errors as tool errors", async () => {
    const failing: Desk = { ...desk, get: async () => Promise.reject(new Error("No order with that id.")) };
    const result = await callTool(failing, GET_TASK_NAME, { order: `0x${"a".repeat(64)}` });
    expect(result.isError).toBe(true);
    expect(body(result)).toEqual({ error: "No order with that id." });
  });

  it("refuses unknown tools", async () => {
    expect((await callTool(desk, "other", {})).isError).toBe(true);
  });
});

describe("resolveConfig", () => {
  it("defaults to mainnet: the USDG desk on Robinhood Chain", () => {
    const config = resolveConfig({});
    expect(config).toMatchObject({
      desk: "https://brain.usebrainchain.com",
      network: "eip155:4663",
      chainId: 4663,
      asset: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
      maxPrice: 1_000_000n,
    });
    expect(postTaskTool(config.terms).description).toContain("Each task costs 1 USDG, paid from this server's wallet on Robinhood Chain");
    expect(postTaskTool(config.terms).description).toContain("about six hours after grading");
  });

  it("switches every setting with BRAINCHAIN_NETWORK=testnet", () => {
    const config = resolveConfig({ BRAINCHAIN_NETWORK: "testnet" });
    expect(config).toMatchObject({ desk: "https://brain.testnet.usebrainchain.com", network: "eip155:46630", chainId: 46630 });
    expect(postTaskTool(config.terms).description).toContain("1 test USDG");
  });

  it("lets single overrides win over the preset", () => {
    const config = resolveConfig({ BRAINCHAIN_DESK_URL: "http://localhost:10000/", BRAINCHAIN_MAX_PRICE_UNITS: "2500000" });
    expect(config.desk).toBe("http://localhost:10000");
    expect(config.terms.cost).toBe("at most 2.5 USDG");
  });

  it("refuses unknown networks and malformed values", () => {
    expect(() => resolveConfig({ BRAINCHAIN_NETWORK: "devnet" })).toThrow();
    expect(() => resolveConfig({ BRAINCHAIN_PAYMENT_NETWORK: "base" })).toThrow();
    expect(() => resolveConfig({ BRAINCHAIN_MAX_PRICE_UNITS: "1.5" })).toThrow();
  });

  it("formats base units", () => {
    expect(formatUnits(1_000_000n)).toBe("1");
    expect(formatUnits(970_000n)).toBe("0.97");
    expect(formatUnits(0n)).toBe("0");
  });
});
