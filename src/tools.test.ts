import { describe, expect, it } from "vitest";

import { formatUnits, resolveConfig } from "./config.js";
import { callTool, GET_TASK_NAME, GET_TASK_TOOL, POST_TASK_NAME, postTaskTool, type Desk } from "./tools.js";

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

  it("rejects a malformed order id and accepts one in capitals", async () => {
    const pattern = new RegExp((GET_TASK_TOOL.inputSchema.properties!.order as { pattern: string }).pattern);
    expect(pattern.test(`0x${"AB".repeat(32)}`)).toBe(true);
    expect((await callTool(desk, GET_TASK_NAME, { order: "42" })).isError).toBe(true);
    const upper = await callTool(desk, GET_TASK_NAME, { order: ` 0x${"AB".repeat(32)} ` });
    expect(upper.isError).toBe(false);
    expect(body(upper)).toMatchObject({ order: `0x${"ab".repeat(32)}` });
  });

  it("returns the result as its own text block, as written", async () => {
    const resultText = 'Line one, "quoted".\n\n```ts\nconst x = 1;\n```';
    const reading: Desk = { ...desk, get: async (order) => ({ order, done: true, resultText }) };
    const result = await callTool(reading, GET_TASK_NAME, { order: `0x${"a".repeat(64)}` });
    expect(result.content).toHaveLength(2);
    expect(body(result)).toEqual({ order: `0x${"a".repeat(64)}`, done: true });
    expect(result.content[1]).toEqual({ type: "text", text: resultText });
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

describe("post tool and config", () => {
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

  it("says the memory of identical posts lasts while the server runs, and that briefs and results are public", () => {
    const { description } = postTaskTool(resolveConfig({}).terms);
    expect(description).toContain("While this server keeps running, an identical post within 15 minutes");
    expect(description).toContain("Briefs and results are public");
  });

  it("leads with a configuration error instead of terms", () => {
    const { description } = postTaskTool("BRAINCHAIN_NETWORK must be mainnet or testnet.");
    expect(description).toMatch(/^Invalid setting: BRAINCHAIN_NETWORK must be mainnet or testnet\./);
    expect(description).not.toContain("Each task costs");
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
