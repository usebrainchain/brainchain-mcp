import { readFileSync } from "node:fs";

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
    const [bond, status] = bondTools({ maxBond: 10_000_000n }, "0xabc");
    expect(bond.name).toBe(BOND_TASK_NAME);
    expect(bond.description).toContain("from this server's wallet 0xabc, as the worker that will deliver it");
    expect(bond.description).toContain("at least the task's bounty and 2 USDG, at most 10 USDG per task");
    expect(bond.description).not.toContain("Until then");
    expect(status.name).toBe(BOND_STATUS_NAME);
    expect(status.description).toMatch(/^Where this server's wallet 0xabc's bonds on a task stand: /);
    const [closed, closedStatus] = bondTools({ maxBond: 10_000_000n }, undefined, { bond: "Delivery bonds are not open yet.", status: "Delivery bonds are not open yet." });
    expect(closed.description!.startsWith("Delivery bonds are not open yet. Until then this tool only returns that error. ")).toBe(true);
    expect(closed.description).toContain("from this server's wallet, as the worker");
    expect(closedStatus.description).toMatch(/^Delivery bonds are not open yet\. Until then this tool only returns that error\. Where this server's wallet's bonds/);
  });

  it("leads each tool only with what stops that tool, and names the cap by its variable when no setting could be read", () => {
    // A state folder that cannot be used stops a bond from being placed, not from being read.
    const [bond, status] = bondTools({ maxBond: 10_000_000n }, "0xabc", { bond: "Invalid setting: BRAINCHAIN_STATE_DIR is unusable." });
    expect(bond.description).toMatch(/^Invalid setting: BRAINCHAIN_STATE_DIR is unusable\. Until then this tool only returns that error\. Lock USDG/);
    expect(status.description).toMatch(/^Where this server's wallet 0xabc's bonds on a task stand: /);
    const [unread] = bondTools({}, undefined, { bond: "Invalid setting: BRAINCHAIN_NETWORK must be mainnet or testnet." });
    expect(unread.description).toContain("at least the task's bounty and 2 USDG, at most BRAINCHAIN_MAX_BOND_UNITS per task");
    expect(unread.description).not.toContain("0 USDG");
  });

  it("says the same of a bond in both tools and the README: when it is placed, what Jev reads, every state, and who a missed one pays", () => {
    const [bond, status] = bondTools({ maxBond: 10_000_000n }, "0xabc");
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const row = (name: string) => readme.split("\n").find((line) => line.startsWith(`| \`${name}\` |`))!;
    const missedTo = "the agent that paid BrainChain's desk for the task, or to the poster for a task posted on the board directly";
    for (const text of [bond.description!, status.description!, row(BOND_TASK_NAME)]) expect(text).toContain(missedTo);
    for (const text of [bond.description!, status.description!, readme]) {
      expect(text).not.toMatch(/Jev reads the bond/);
      expect(text).not.toMatch(/(goes|paid|settles) to the (task's )?poster/);
      expect(text).not.toContain("is owed to th");
    }
    // A bond is placed only after the hire, so only settled bonds can be read at one.
    for (const text of [bond.description!, row(BOND_TASK_NAME)]) {
      expect(text).toMatch(/Jev must already have hired this wallet for/);
      expect(text).toContain("A worker's settled bonds, delivered and missed, are part of what Jev reads at later hires.");
      expect(text).toContain("possiblyBonded");
    }
    expect(status.description).toMatch(/open, marked \(.*\), lapsed \(.*\), delivered \(.*\) or missed \(.*\), with the next step\.$/);
    expect(row(BOND_STATUS_NAME)).toContain("open, marked, lapsed, delivered or missed");
  });
});

describe("callTool", () => {
  it("posts a task", async () => {
    const result = await callTool(desk, POST_TASK_NAME, { title: "t", brief: "b", levels: ["good", "ok"] });
    expect(result.isError).toBe(false);
    expect(body(result)).toMatchObject({ order: "0x01" });
  });

  it("takes a brief copied with the pass level the tool sets itself, and refuses any other", async () => {
    const posted: unknown[] = [];
    const recording: Desk = { ...desk, post: async (task) => (posted.push(task), { order: "0x01" }) };
    const three = { title: "t", brief: "b", levels: ["best", "good", "poor"] };
    const two = { title: "t", brief: "b", levels: ["good", "poor"] };
    for (const input of [three, { ...three, passIndex: 1 }, two, { ...two, passIndex: 0 }]) expect((await callTool(recording, POST_TASK_NAME, input)).isError).toBe(false);
    // The desk sets the level itself, so the field is never sent on.
    expect(posted).toEqual([three, three, two, two]);

    const second = "passIndex must be 1 here: with three levels this tool pays work that reaches the second level or better. Leave passIndex out.";
    const first = "passIndex must be 0 here: with two levels this tool pays only work that reaches the first. Leave passIndex out.";
    for (const [input, error] of [
      [{ ...three, passIndex: 0 }, second],
      [{ ...three, passIndex: 2 }, second],
      [{ ...three, passIndex: "1" }, second],
      [{ ...three, passIndex: null }, second],
      [{ ...two, passIndex: 1 }, first],
    ] as const) {
      const result = await callTool(recording, POST_TASK_NAME, input);
      expect(result.isError).toBe(true);
      expect(body(result)).toEqual({ error });
    }
    expect(posted).toHaveLength(4);
    const schema = postTaskTool(resolveConfig({}).terms).inputSchema as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(schema.properties)).toEqual(["title", "brief", "levels", "passIndex"]);
    expect(schema.required).toEqual(["title", "brief", "levels"]);
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
    expect(body(post)).toEqual({ error: "Unknown field: extra. This tool takes only title, brief, levels, passIndex." });
    const get = await callTool(counting, GET_TASK_NAME, { order: `0x${"a".repeat(64)}`, one: 1, two: 2 });
    expect(get.isError).toBe(true);
    expect(body(get)).toEqual({ error: "Unknown fields: one, two. This tool takes only order." });
    expect(calls).toBe(0);
  });

  it("answers a tool that a setting keeps from running with that setting's error, whatever it is sent", async () => {
    let calls = 0;
    const counting: Desk = { post: async () => ({ calls: ++calls }), get: async (order) => ({ order, calls: ++calls }) };
    const refused = new Map([[POST_TASK_NAME, "BRAINCHAIN_STATE_DIR cannot be used."]]);
    for (const input of [{ title: "t", brief: "b", levels: ["good", "ok"] }, {}, { title: 5, extra: true }, undefined]) {
      const result = await callTool(counting, POST_TASK_NAME, input, undefined, undefined, refused);
      expect(result.isError).toBe(true);
      expect(body(result)).toEqual({ error: "BRAINCHAIN_STATE_DIR cannot be used." });
    }
    expect(calls).toBe(0);
    // The other tools are untouched, and a name that is no tool's stays unknown.
    expect((await callTool(counting, GET_TASK_NAME, { order: `0x${"a".repeat(64)}` }, undefined, undefined, refused)).isError).toBe(false);
    expect(body(await callTool(counting, "constructor", {}, undefined, undefined, refused))).toEqual({ error: "Unknown tool constructor." });
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

describe("get tool", () => {
  it("says a long result is cut, as the README does", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const row = readme.split("\n").find((line) => line.startsWith(`| \`${GET_TASK_NAME}\` |`))!;
    const said = "A result over 20,000 characters is cut there, ending with a link to the full text.";
    expect(GET_TASK_TOOL.description).toContain(said);
    expect(row).toContain(said);
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
    expect(description).toContain("While this server keeps running, an identical post within 15 minutes returns the first post's order, marked duplicate, instead of paying again, unless brainchain_get_task has read that order's payment as failed.");
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
  const board = { chain: "Robinhood Chain" as const, readAt: "2026-11-04T14:40:00.000Z", usMarketOpen: true, stocks: [] };

  it("serves the board without a desk or a key", async () => {
    const result = await callTool(desk, "brainchain_stock_premiums", {}, async () => board);
    expect(result.isError).toBe(false);
    expect(body(result)).toEqual(board);
    expect(body(await callTool(desk, "brainchain_stock_premiums", undefined, async () => board))).toEqual(board);
  });

  it("answers a failed read in one line, never with the library's report", async () => {
    const dump = Object.assign(new Error('HTTP request failed.\n\nStatus: 429\nURL: https://rpc.mainnet.chain.robinhood.com/\nRequest body: {"method":"eth_call"}'), { status: 429 });
    const wrapped = new Error("The contract function \"tokenCount\" reverted.\n\nDetails: ...", { cause: dump });
    for (const [error, said] of [
      [dump, "Robinhood Chain could not be read just now: HTTP 429. Try again in a minute."],
      [wrapped, "Robinhood Chain could not be read just now: HTTP 429. Try again in a minute."],
      [new Error("The request took too long to respond.\n\nURL: https://rpc.example"), "Robinhood Chain could not be read just now: The request took too long to respond. Try again in a minute."],
    ] as const) {
      const result = await callTool(desk, "brainchain_stock_premiums", {}, async () => Promise.reject(error));
      expect(result.isError).toBe(true);
      expect(body(result)).toEqual({ error: said });
    }
  });

  it("refuses fields, as its schema says it takes none", async () => {
    let reads = 0;
    const result = await callTool(desk, "brainchain_stock_premiums", { symbol: "NVDA" }, async () => (reads++, board));
    expect(result.isError).toBe(true);
    expect(body(result)).toEqual({ error: "Unknown field: symbol. This tool takes nothing." });
    expect(reads).toBe(0);
  });
});
