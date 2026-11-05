import { describe, expect, it } from "vitest";

import { formatUnits, resolveConfig } from "./config.js";
import type { Bonds } from "./bonds.js";
import { BOND_STATUS_NAME, BOND_TASK_NAME, bondTools, callTool, GET_TASK_NAME, GET_TASK_TOOL, POST_TASK_NAME, postTaskTool, type Desk } from "./tools.js";

const desk: Desk = {
  post: async (task) => ({ order: "0x01", task }),
  get: async (order) => ({ order, state: "posted" }),
};

function body(result: Awaited<ReturnType<typeof callTool>>): unknown {
  return JSON.parse((result.content[0] as { text: string }).text);
}

describe("bond tools", () => {
  const bonds: Bonds = {
    bond: async (task, amount) => ({ bonded: { task: task.toString(), amount: amount.toString() } }),
    status: async (task) => ({ task: task.toString(), bonds: [] }),
  };

  it("sends the task and the amount in USDG units, and reads a bond's status", async () => {
    const bonded = await callTool(desk, BOND_TASK_NAME, { task: "12", amount: "2.5" }, undefined, bonds);
    expect(bonded.isError).toBe(false);
    expect(body(bonded)).toEqual({ bonded: { task: "12", amount: "2500000" } });
    expect(body(await callTool(desk, BOND_TASK_NAME, { task: "12", amount: "5" }, undefined, bonds))).toEqual({ bonded: { task: "12", amount: "5000000" } });
    expect(body(await callTool(desk, BOND_STATUS_NAME, { task: "12" }, undefined, bonds))).toEqual({ task: "12", bonds: [] });
  });

  it("refuses a bad task, a bad amount and unknown fields before anything is sent", async () => {
    let calls = 0;
    const counting: Bonds = { bond: async () => ++calls, status: async () => ++calls };
    for (const [name, input, error] of [
      [BOND_TASK_NAME, { task: "0", amount: "5" }, "task must be the task's id on BrainChain, a whole number above zero."],
      [BOND_TASK_NAME, { task: "x", amount: "5" }, "task must be the task's id on BrainChain, a whole number above zero."],
      [BOND_TASK_NAME, { amount: "5" }, "task is required."],
      [BOND_TASK_NAME, { task: "12" }, "amount is required."],
      [BOND_TASK_NAME, { task: "12", amount: "0" }, 'amount is in USDG, above zero with at most 6 decimals, such as "5".'],
      [BOND_TASK_NAME, { task: "12", amount: "1.2345678" }, 'amount is in USDG, above zero with at most 6 decimals, such as "5".'],
      [BOND_TASK_NAME, { task: "12", amount: 5 }, "amount must be a string, not a number."],
      [BOND_TASK_NAME, { task: "12", amount: "5", extra: 1 }, "Unknown field: extra. This tool takes only task, amount."],
      [BOND_STATUS_NAME, { task: "12", extra: 1 }, "Unknown field: extra. This tool takes only task."],
      [BOND_STATUS_NAME, {}, "task is required."],
    ] as const) {
      const result = await callTool(desk, name, input, undefined, counting);
      expect(result.isError).toBe(true);
      expect(body(result)).toEqual({ error });
    }
    expect(calls).toBe(0);
    expect(body(await callTool(desk, BOND_TASK_NAME, { task: "12", amount: "5" }))).toEqual({ error: "This server has no bond tools." });
  });

  it("words the tools for the wallet and says why bonds are closed", () => {
    const [bond, status] = bondTools({ maxBond: 10_000_000n, budget: 10_000_000n }, "0xabc", undefined);
    expect(bond.name).toBe(BOND_TASK_NAME);
    expect(bond.description).toContain("from this server's wallet 0xabc, as the worker that will deliver it");
    expect(bond.description).toContain("at least the task's bounty and 2 USDG, at most 10 USDG per task");
    expect(bond.description).not.toContain("Until then");
    expect(status.name).toBe(BOND_STATUS_NAME);
    const [closed] = bondTools({ maxBond: 10_000_000n, budget: 10_000_000n }, undefined, "Delivery bonds are not open yet.");
    expect(closed.description.startsWith("Delivery bonds are not open yet. Until then this tool only returns that error. ")).toBe(true);
    expect(closed.description).toContain("from this server's wallet, as the worker");
  });
});

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

  it("refuses fields the schema does not list, before anything is paid", async () => {
    let calls = 0;
    const counting: Desk = {
      post: async () => ({ calls: ++calls }),
      get: async () => ({ calls: ++calls }),
    };
    const post = await callTool(counting, POST_TASK_NAME, { title: "t", brief: "b", levels: ["good", "ok"], extra: "field" });
    expect(post.isError).toBe(true);
    expect(body(post)).toEqual({ error: "Unknown field: extra. This tool takes only title, brief, levels." });
    const get = await callTool(counting, GET_TASK_NAME, { order: `0x${"a".repeat(64)}`, one: 1, two: 2 });
    expect(get.isError).toBe(true);
    expect(body(get)).toEqual({ error: "Unknown fields: one, two. This tool takes only order." });
    expect(calls).toBe(0);
  });

  it("says what is wrong with a post, field by field", async () => {
    const task = { title: "t", brief: "b", levels: ["good", "ok"] };
    const { title: _title, ...noTitle } = task;
    const { brief: _brief, ...noBrief } = task;
    const { levels: _levels, ...noLevels } = task;
    for (const [input, error] of [
      [{}, "title is required."],
      [noTitle, "title is required."],
      [noBrief, "brief is required."],
      [noLevels, "levels is required."],
      [{ ...task, title: 123 }, "title must be a string, not a number."],
      [{ ...task, title: null }, "title must be a string, not null."],
      [{ ...task, title: true }, "title must be a string, not a boolean."],
      [{ ...task, title: "   " }, "title is empty."],
      [{ ...task, title: "x".repeat(121) }, "title is 121 characters; the limit is 120."],
      [{ ...task, brief: ["not", "a", "string"] }, "brief must be a string, not an array."],
      [{ ...task, brief: {} }, "brief must be a string, not an object."],
      [{ ...task, brief: "x".repeat(32_001) }, "brief is 32,001 characters; the limit is 32,000."],
      [{ ...task, levels: "good" }, "levels must be an array of strings, not a string."],
      [{ ...task, levels: ["good"] }, "levels must list 2 or 3 quality levels, best first; this lists 1."],
      [{ ...task, levels: ["a", "b", "c", "d"] }, "levels must list 2 or 3 quality levels, best first; this lists 4."],
      [{ ...task, levels: ["good", 5] }, "levels[1] must be a string, not a number."],
      [{ ...task, levels: ["good", " "] }, "levels[1] is empty."],
      [{ ...task, levels: ["x".repeat(201), "ok"] }, "levels[0] is 201 characters; the limit is 200."],
      [{ ...task, title: "line one\nline two" }, "title must be one line."],
      [{ ...task, title: "line one\u2028line two" }, "title must be one line."],
      [{ ...task, brief: "\u200b" }, "brief is empty."],
      [{ ...task, brief: " \u2800\u3164\ufeff\u{e0041} " }, "brief is empty."],
      [{ ...task, levels: ["good", "\u200d"] }, "levels[1] is empty."],
      [{ ...task, levels: ["Accurate", " Accurate "] }, "levels[1] repeats levels[0]; each level must describe a different quality."],
      [{ ...task, levels: ["good", "ok", "good"] }, "levels[2] repeats levels[0]; each level must describe a different quality."],
      [{ ...task, brief: "漢".repeat(25_000) }, "The task is 75,061 bytes as JSON; the limit is 64,000. Shorten the brief."],
    ] as const) {
      const result = await callTool(desk, POST_TASK_NAME, input);
      expect(result.isError).toBe(true);
      expect(body(result)).toEqual({ error });
    }
  });

  it("says what is wrong with an order id", async () => {
    for (const [input, error] of [
      [{}, "order is required."],
      [{ order: 42 }, "order must be a string, not a number."],
      [{ order: " " }, "order is empty."],
      [{ order: "42" }, "order must be the 0x-prefixed, 64-character hex id that brainchain_post_task returned."],
    ] as const) {
      const result = await callTool(desk, GET_TASK_NAME, input);
      expect(result.isError).toBe(true);
      expect(body(result)).toEqual({ error });
    }
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

describe("stock premiums", () => {
  it("serves the board without a desk or a key", async () => {
    const board = { chain: "Robinhood Chain" as const, readAt: "2026-11-04T14:40:00.000Z", usMarketOpen: true, stocks: [] };
    const result = await callTool(desk, "brainchain_stock_premiums", {}, async () => board);
    expect(result.isError).toBe(false);
    expect(body(result)).toEqual(board);
  });
});
