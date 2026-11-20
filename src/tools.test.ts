import { readFileSync } from "node:fs";

import { getAddress } from "viem";
import { describe, expect, it } from "vitest";

import { formatUnits, resolveConfig } from "./config.js";
import { CustodyError, type CustodyToken } from "./custody.js";
import { ChainError, STILL_READING } from "./history.js";
import type { MakerBoard } from "./makers.js";
import { bondsClosed, type Bonds } from "./bonds.js";
import { PREMIUMS_TOOL } from "./premiums.js";
import { SightingsError } from "./sightings.js";
import { BOND_STATUS_NAME, BOND_TASK_NAME, bondTools, callTool, GET_GRADE_TOOL, GET_TASK_NAME, GET_TASK_TOOL, gradeTool, POST_TASK_NAME, postTaskTool, type Desk } from "./tools.js";

const desk: Desk = {
  post: async (task) => ({ order: "0x01", task }),
  get: async (order) => ({ order, state: "posted" }),
};

function body(result: Awaited<ReturnType<typeof callTool>>): unknown {
  return JSON.parse((result.content[0] as { text: string }).text);
}

/** BitGo's lists, for a test that sends no symbol: one that does gets told so instead of reading GitHub. */
const noLookup = async (): Promise<never> => {
  throw new Error("This test looks nothing up.");
};

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
    const [closed, closedStatus] = bondTools({ maxBond: 10_000_000n }, undefined, { closed: "Delivery bonds are not open yet." });
    expect(closed.description!.startsWith("Delivery bonds are not open yet. On this network this tool only returns that error. ")).toBe(true);
    expect(closed.description).toContain("from this server's wallet, as the worker");
    expect(closedStatus.description).toMatch(/^Delivery bonds are not open yet\. On this network this tool only returns that error\. Where this server's wallet's bonds/);
  });

  it("says on testnet that bonds run on mainnet, with no condition left hanging", () => {
    const testnet = resolveConfig({ BRAINCHAIN_NETWORK: "testnet" });
    for (const tool of bondTools(testnet, "0xabc", { closed: bondsClosed(testnet) })) {
      expect(tool.description).toMatch(/^Delivery bonds run on Robinhood Chain against Shipped's registry, which BrainChain testnet has no counterpart of\. They are open with BRAINCHAIN_NETWORK=mainnet\. On this network this tool only returns that error\. /);
      expect(tool.description).not.toContain("Until then");
    }
  });

  it("leads each tool only with what stops that tool, and names the cap by its variable when no setting could be read", () => {
    // A state folder that cannot be used stops a bond from being placed, not from being read.
    const [bond, status] = bondTools({ maxBond: 10_000_000n }, "0xabc", { invalid: { bond: "BRAINCHAIN_STATE_DIR is unusable." } });
    expect(bond.description).toMatch(/^Invalid setting: BRAINCHAIN_STATE_DIR is unusable\. Until the operator fixes it, this tool only returns that error\. Lock USDG/);
    expect(status.description).toMatch(/^Where this server's wallet 0xabc's bonds on a task stand: /);
    // A setting to fix comes before a closed network, since fixing it is what the operator can do now.
    const [both] = bondTools({ maxBond: 10_000_000n }, "0xabc", { closed: "Delivery bonds are not open yet.", invalid: { bond: "BRAINCHAIN_STATE_DIR is unusable." } });
    expect(both.description).toMatch(/^Invalid setting: BRAINCHAIN_STATE_DIR is unusable\. Until the operator fixes it/);
    const [unread] = bondTools({}, undefined, { invalid: { bond: "BRAINCHAIN_NETWORK must be mainnet or testnet." } });
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
      expect(text).toMatch(/(Jev|BrainChain) must already have hired this wallet for/);
      expect(text).toMatch(/A worker's settled bonds, delivered and missed, are part of what (Jev|BrainChain) reads at later hires\./);
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

  it("measures a post in UTF-16 units, and says so wherever a length is given", async () => {
    const flag = "\u{1F1FA}\u{1F1F8}";
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}";
    expect([flag.length, family.length]).toEqual([4, 11]);
    const task = { title: "t", brief: "b", levels: ["good", "ok"] };
    const units = "Most characters take one, an emoji two or more.";
    expect((await callTool(desk, POST_TASK_NAME, { ...task, title: flag.repeat(30) })).isError).toBe(false);
    for (const [input, error] of [
      [{ ...task, title: flag.repeat(31) }, `title is 124 UTF-16 units; the limit is 120. ${units}`],
      [{ ...task, levels: [family.repeat(19), "ok"] }, `levels[0] is 209 UTF-16 units; the limit is 200. ${units}`],
      [{ ...task, brief: family.repeat(2_910) }, `brief is 32,010 UTF-16 units; the limit is 32,000. ${units}`],
    ] as const) {
      expect(body(await callTool(desk, POST_TASK_NAME, input))).toEqual({ error });
    }

    const { description, inputSchema } = postTaskTool(resolveConfig({}).terms);
    const fields = inputSchema.properties as Record<string, { description: string }>;
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const row = readme.split("\n").find((line) => line.startsWith(`| \`${POST_TASK_NAME}\` |`))!;
    for (const text of [fields.brief!.description, row]) expect(text).toContain("most characters take one, an emoji two or more (a flag four, a family emoji eleven)");
    expect(description).toContain("up to 32,000 UTF-16 units (most characters take one, an emoji two or more)");
    expect(fields.title!.description).toContain("up to 120 UTF-16 units");
    expect(fields.levels!.description).toContain("up to 200 UTF-16 units");
    for (const text of [description, fields.brief!.description, readme]) expect(text).not.toMatch(/emoji (counts|counting) as two/);
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
      [{ ...task, title: "x".repeat(121) }, "title is 121 UTF-16 units; the limit is 120. Most characters take one, an emoji two or more."],
      [{ ...task, brief: ["not", "a", "string"] }, "brief must be a string, not an array."],
      [{ ...task, brief: {} }, "brief must be a string, not an object."],
      [{ ...task, brief: "x".repeat(32_001) }, "brief is 32,001 UTF-16 units; the limit is 32,000. Most characters take one, an emoji two or more."],
      [{ ...task, levels: "good" }, "levels must be an array of strings, not a string."],
      [{ ...task, levels: ["good"] }, "levels must list 2 or 3 quality levels, best first; this lists 1."],
      [{ ...task, levels: ["a", "b", "c", "d"] }, "levels must list 2 or 3 quality levels, best first; this lists 4."],
      [{ ...task, levels: ["good", 5] }, "levels[1] must be a string, not a number."],
      [{ ...task, levels: ["good", " "] }, "levels[1] is empty."],
      [{ ...task, levels: ["x".repeat(201), "ok"] }, "levels[0] is 201 UTF-16 units; the limit is 200. Most characters take one, an emoji two or more."],
      [{ ...task, title: "line one\nline two" }, "title must be one line."],
      [{ ...task, title: "line one\u2028line two" }, "title must be one line."],
      [{ ...task, brief: "\u200b" }, "brief is empty."],
      [{ ...task, brief: " \u2800\u3164\ufeff\u{e0041} " }, "brief is empty."],
      [{ ...task, levels: ["good", "\u200d"] }, "levels[1] is empty."],
      [{ ...task, levels: ["Accurate", " Accurate "] }, "levels[1] repeats levels[0]; each level must describe a different quality."],
      [{ ...task, levels: ["good", "ok", "good"] }, "levels[2] repeats levels[0]; each level must describe a different quality."],
      [{ ...task, levels: ["Same", "same "] }, "levels[1] repeats levels[0]; each level must describe a different quality."],
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
    const said = "A result over 20,000 UTF-16 units (most characters take one, an emoji two or more) is cut there, ending with a link to the full text.";
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

  it("names the desk's prices, and says posts and grades are refused under a lower price limit", () => {
    const tools = (env: Record<string, string>) => {
      const { terms } = resolveConfig(env);
      return [postTaskTool(terms).description!, gradeTool(terms).description!];
    };
    const [post, grade] = tools({});
    expect(post).toContain("Each task costs 1 USDG, paid from this server's wallet on Robinhood Chain. The result");
    expect(grade).toContain("Each grade costs 0.25 USDG whatever the verdict, paid from this server's wallet on Robinhood Chain, and counts against its budget and daily limit.");
    for (const text of [post, grade]) expect(text).not.toContain("refused");

    const [cheapPost, cheapGrade] = tools({ BRAINCHAIN_MAX_PRICE_UNITS: "500000" });
    expect(cheapPost).toContain(
      "Each task costs 1 USDG, paid from this server's wallet on Robinhood Chain. This server pays at most 0.5 USDG at a time (BRAINCHAIN_MAX_PRICE_UNITS), under that price, so posts are refused and nothing is charged until the operator raises it.",
    );
    expect(cheapPost).not.toContain("at most 0.5 USDG, paid");
    expect(cheapGrade).toContain("Each grade costs 0.25 USDG whatever the verdict");
    expect(cheapGrade).not.toContain("refused");

    const [, cheaperGrade] = tools({ BRAINCHAIN_MAX_PRICE_UNITS: "100000", BRAINCHAIN_PAY_ON: "base" });
    expect(cheaperGrade).toContain("Each grade costs 0.25 USDC whatever the verdict, paid from this server's wallet on Base, and counts against its budget and daily limit. This server pays at most 0.1 USDC at a time (BRAINCHAIN_MAX_PRICE_UNITS), under that price, so grades are refused");

    // Under a raised ceiling the desk may have raised its prices too, so both are named up to the ceiling.
    const [raisedPost, raisedGrade] = tools({ BRAINCHAIN_MAX_PRICE_UNITS: "2500000" });
    expect(raisedPost).toContain("Each task costs at most 2.5 USDG");
    expect(raisedGrade).toContain("Each grade costs at most 2.5 USDG");
  });

  it("marks every tool that spends as destructive and every free read as read-only", () => {
    const { terms } = resolveConfig({});
    const [bond, status] = bondTools({ maxBond: 10_000_000n }, "0xabc");
    for (const tool of [postTaskTool(terms), gradeTool(terms), bond]) expect(tool.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
    for (const tool of [GET_TASK_TOOL, GET_GRADE_TOOL, PREMIUMS_TOOL, status]) expect(tool.annotations).toEqual({ readOnlyHint: true, openWorldHint: true });
  });

  it("lets single overrides win over the preset", () => {
    const config = resolveConfig({ BRAINCHAIN_DESK_URL: "http://localhost:10000/", BRAINCHAIN_PAY_TO: "0x000000000000000000000000000000000000dEaD", BRAINCHAIN_MAX_PRICE_UNITS: "2500000" });
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

describe("custody additions", () => {
  const board = { chain: "Robinhood Chain" as const, source: "https://github.com/BitGo/BitGoJS/tree/master/modules/statics/src/coins", readAt: "2026-11-16T10:00:00.000Z", since: "2026-10-17T10:00:00.000Z", additions: [] };
  const call = (args: unknown, custody: (period: number | Date) => Promise<typeof board>) => callTool(desk, "brainchain_custody_additions", args, undefined, undefined, undefined, { custody });

  it("serves the board without a desk or a key, for 30 days unless told otherwise", async () => {
    const asked: number[] = [];
    const read = async (days: number) => (asked.push(days), board);
    for (const args of [{}, undefined, { days: 1 }, { days: 7 }, { days: 90 }]) {
      const result = await call(args, read);
      expect(result.isError).toBe(false);
      expect(body(result)).toEqual(board);
    }
    expect(asked).toEqual([30, 30, 1, 7, 90]);
  });

  it("refuses a period it does not read, and fields it does not take, before reading anything", async () => {
    let reads = 0;
    const read = async () => (reads++, board);
    for (const days of [0, 91, 1.5, -3, "30", null, Number.NaN]) {
      const result = await call({ days }, read);
      expect(result.isError).toBe(true);
      expect(body(result)).toEqual({ error: "days must be a whole number from 1 to 90. Leave it out to look back 30 days." });
    }
    expect(body(await call({ token: "cashcat" }, read))).toEqual({ error: "Unknown field: token. This tool takes only days, since." });
    expect(reads).toBe(0);
  });

  it("reads from `since` when it is given, in place of `days`", async () => {
    const asked: (number | Date)[] = [];
    const read = async (period: number | Date) => (asked.push(period), board);
    const recent = new Date(Date.now() - 3_600_000).toISOString();
    for (const args of [{ since: recent }, { since: recent, days: 7 }, { since: recent.slice(0, 10) }]) expect((await call(args, read)).isError).toBe(false);
    expect(asked).toEqual([new Date(recent), new Date(recent), new Date(`${recent.slice(0, 10)}T00:00:00Z`)]);
  });

  it("refuses a `since` it cannot read, or one further back than it reads, before reading anything", async () => {
    let reads = 0;
    const read = async () => (reads++, board);
    const far = new Date(Date.now() - 91 * 86_400_000).toISOString();
    for (const [args, said] of [
      [{ since: "last week" }, "since must be a time in ISO 8601, such as 2026-11-01T00:00:00Z, or a date, such as 2026-11-01."],
      [{ since: "2026-11-01T00:00:00" }, "since must be a time in ISO 8601, such as 2026-11-01T00:00:00Z, or a date, such as 2026-11-01."],
      [{ since: 1_793_491_200_000 }, "since must be a string, not a number."],
      [{ since: "2999-01-01" }, "since is in the future."],
      [{ since: far }, "since can be at most 90 days back, as far as this tool reads BitGo's changes."],
      // `since` wins over `days`, and a `days` that is wrong in itself is still refused.
      [{ since: new Date().toISOString().slice(0, 10), days: 0 }, "days must be a whole number from 1 to 90. Leave it out to look back 30 days."],
    ] as const) {
      const result = await call(args, read);
      expect(result.isError).toBe(true);
      expect(body(result)).toEqual({ error: said });
    }
    expect(reads).toBe(0);
  });

  it("answers a failed read in one line, and passes on what is already written for the reader", async () => {
    const dump = Object.assign(new Error("GitHub answered 502."), { status: 502 });
    for (const [error, said] of [
      [dump, "BitGo's code on GitHub could not be read just now: HTTP 502. Try again in a minute."],
      [new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND api.github.com") }), "BitGo's code on GitHub could not be read just now: fetch failed. Try again in a minute."],
      [new Error("GitHub's answer was not a list of changes to a branch."), "BitGo's code on GitHub could not be read just now: GitHub's answer was not a list of changes to a branch. Try again in a minute."],
      [new CustodyError("GitHub allows 60 unauthenticated API requests an hour from one IP address, and this address has used them up. Try again after 12:17 UTC."), "GitHub allows 60 unauthenticated API requests an hour from one IP address, and this address has used them up. Try again after 12:17 UTC."],
    ] as const) {
      const result = await call({}, async () => Promise.reject(error));
      expect(result.isError).toBe(true);
      expect(body(result)).toEqual({ error: said });
    }
  });
});

describe("market maker holdings", () => {
  const CASHCAT = "0x020bfC650A365f8BB26819deAAbF3E21291018b4";
  const WALLET = "0xB97e4298c7F5f55360d207a6196125376675B3eA";
  const board: MakerBoard = { chain: "Robinhood Chain", token: { contract: CASHCAT, decimals: 18, totalSupply: "1000000000" }, readAt: "2026-11-16T14:40:50.000Z", wallets: [] };
  const call = (args: unknown, makers: (token: string, wallet?: string) => Promise<MakerBoard>) => callTool(desk, "brainchain_market_maker_holdings", args, undefined, undefined, undefined, { makers, listed: noLookup });

  it("serves the board without a desk or a key, for the wallets it knows unless given another", async () => {
    const asked: [string, string | undefined][] = [];
    const read = async (token: string, wallet?: string) => (asked.push([token, wallet]), board);
    for (const args of [{ token: CASHCAT }, { token: CASHCAT.toLowerCase() }, { token: ` ${CASHCAT}\n` }, { token: CASHCAT.toUpperCase().replace("0X", "0x") }, { token: CASHCAT, wallet: WALLET.toLowerCase() }]) {
      const result = await call(args, read);
      expect(result.isError).toBe(false);
      expect(body(result)).toEqual(board);
    }
    expect(asked).toEqual([[CASHCAT, undefined], [CASHCAT, undefined], [CASHCAT, undefined], [CASHCAT, undefined], [CASHCAT, WALLET]]);
  });

  it("refuses what is not an address, and fields it does not take, before reading anything", async () => {
    let reads = 0;
    const read = async () => (reads++, board);
    const shape = (name: string) => `${name} must be an address on Robinhood Chain: 0x followed by 40 hex characters.`;
    const checksum = (name: string) => `The capital and small letters in ${name} do not match its checksum, which usually means a character was mistyped. Compare it with the source you copied it from. If the two match, send the address in lowercase.`;
    for (const [args, said] of [
      [{}, "token is required."],
      [undefined, "token is required."],
      [{ token: 4663 }, "token must be a string, not a number."],
      [{ token: " " }, "token is empty."],
      [{ token: CASHCAT.slice(0, -1) }, shape("token")],
      [{ token: "0xcashcat" }, shape("token")],
      [{ token: `${CASHCAT}0` }, shape("token")],
      [{ token: CASHCAT.replace("0x", "") }, shape("token")],
      [{ token: CASHCAT.replace("bfC", "bFc") }, checksum("token")],
      [{ token: CASHCAT, wallet: "wintermute" }, shape("wallet")],
      [{ token: CASHCAT, wallet: null }, "wallet must be a string, not null."],
      [{ token: CASHCAT, wallet: WALLET.replace("B97e", "b97E") }, checksum("wallet")],
      [{ token: CASHCAT, days: 30 }, "Unknown field: days. This tool takes only token, wallet, atBlock, at."],
    ] as const) {
      const result = await call(args, read);
      expect(result.isError).toBe(true);
      expect(body(result)).toEqual({ error: said });
    }
    expect(reads).toBe(0);
  });

  it("passes on a past block, or a time in ISO 8601, and nothing for a read of the newest block", async () => {
    const asked: unknown[] = [];
    const read = async (_token: string, _wallet?: string, moment?: unknown) => (asked.push(moment), board);
    for (const when of [{}, { atBlock: 0 }, { atBlock: 117_000_000 }, { at: "2026-11-01" }, { at: "2026-11-01T12:30Z" }, { at: " 2026-11-01T12:30:00.25+02:00 " }, { at: "2024-02-29T23:59:59Z" }]) {
      const result = await call({ token: CASHCAT, ...when }, read);
      expect(result.isError).toBe(false);
    }
    expect(asked).toEqual([
      undefined,
      { block: 0n },
      { block: 117_000_000n },
      { time: Date.parse("2026-11-01T00:00:00Z") },
      { time: Date.parse("2026-11-01T12:30:00Z") },
      { time: Date.parse("2026-11-01T10:30:00.250Z") },
      { time: Date.parse("2024-02-29T23:59:59Z") },
    ]);
  });

  it("refuses a block or a time it cannot read, and both at once, before reading anything", async () => {
    let reads = 0;
    const read = async () => (reads++, board);
    const block = "atBlock must be a block number: a whole number from 0.";
    const time = "at must be a time in ISO 8601, such as 2026-11-01T00:00:00Z, or a date, such as 2026-11-01.";
    for (const [when, said] of [
      [{ atBlock: -1 }, block],
      [{ atBlock: 1.5 }, block],
      [{ atBlock: "117000000" }, block],
      [{ atBlock: null }, block],
      [{ atBlock: 2 ** 53 }, block],
      [{ at: "yesterday" }, time],
      [{ at: "2026-02-30" }, time],
      [{ at: "2026-11-01T24:00:00Z" }, time],
      // Without an offset the server's own time zone would decide which block it is.
      [{ at: "2026-11-01T12:30:00" }, time],
      [{ at: "2026-11-01 12:30:00Z" }, time],
      [{ at: 1_793_491_200 }, "at must be a string, not a number."],
      [{ at: "2999-01-01" }, "at is in the future."],
      [{ atBlock: 5, at: "2026-11-01" }, "Pass atBlock or at, not both."],
    ] as const) {
      const result = await call({ token: CASHCAT, ...when }, read);
      expect(result.isError).toBe(true);
      expect(body(result)).toEqual({ error: said });
    }
    expect(reads).toBe(0);
  });

  it("answers a failed read in one line, and passes on what is already written for the reader", async () => {
    const dump = Object.assign(new Error('HTTP request failed.\n\nStatus: 429\nURL: https://rpc.mainnet.chain.robinhood.com/\nRequest body: {"method":"eth_getLogs"}'), { status: 429 });
    const missing = new ChainError(`There is no contract at ${CASHCAT} on Robinhood Chain. Otherwise check the address.`);
    for (const [error, said] of [
      [dump, "Robinhood Chain could not be read just now: HTTP 429. Try again in a minute."],
      [new Error("The request took too long to respond.\n\nURL: https://rpc.example"), "Robinhood Chain could not be read just now: The request took too long to respond. Try again in a minute."],
      [missing, missing.message],
      [new ChainError(STILL_READING), STILL_READING],
    ] as const) {
      const result = await call({ token: CASHCAT }, async () => Promise.reject(error));
      expect(result.isError).toBe(true);
      expect(body(result)).toEqual({ error: said });
    }
  });
});

describe("token readiness", () => {
  const CASHCAT = "0x020bfC650A365f8BB26819deAAbF3E21291018b4";
  const board = { chain: "Robinhood Chain" as const, token: { contract: CASHCAT as `0x${string}` }, readAt: "2026-11-16T21:00:00.000Z", deployed: false };
  const call = (args: unknown, readiness: (token: string) => Promise<typeof board>) => callTool(desk, "brainchain_token_readiness", args, undefined, undefined, undefined, { readiness, listed: noLookup });

  it("serves the board without a desk or a key, for the address as its checksum writes it", async () => {
    const asked: string[] = [];
    for (const token of [CASHCAT, CASHCAT.toLowerCase(), ` ${CASHCAT} `]) {
      const result = await call({ token }, async (address) => (asked.push(address), board));
      expect(result.isError).toBe(false);
      expect(body(result)).toEqual(board);
    }
    expect(asked).toEqual([CASHCAT, CASHCAT, CASHCAT]);
  });

  it("refuses what is not an address, and fields it does not take, before reading anything", async () => {
    let reads = 0;
    const read = async () => (reads++, board);
    for (const [args, said] of [
      [{}, "token is required."],
      [{ token: "0xCASHCAT" }, "token must be an address on Robinhood Chain: 0x followed by 40 hex characters."],
      [{ token: CASHCAT, wallet: CASHCAT }, "Unknown field: wallet. This tool takes only token."],
    ] as const) {
      const result = await call(args, read);
      expect(result.isError).toBe(true);
      expect(body(result)).toEqual({ error: said });
    }
    expect(reads).toBe(0);
  });

  it("answers a failed read in one line, and passes on what is already written for the reader", async () => {
    const slow = new ChainError(STILL_READING);
    for (const [error, said] of [
      [Object.assign(new Error("HTTP request failed.\n\nStatus: 429"), { status: 429 }), "Robinhood Chain could not be read just now: HTTP 429. Try again in a minute."],
      [slow, slow.message],
    ] as const) {
      const result = await call({ token: CASHCAT }, async () => Promise.reject(error));
      expect(result.isError).toBe(true);
      expect(body(result)).toEqual({ error: said });
    }
  });
});

describe("token sightings", () => {
  const CASHCAT = "0x020bfC650A365f8BB26819deAAbF3E21291018b4";
  const board = { chain: "Robinhood Chain" as const, token: { contract: CASHCAT as `0x${string}` }, readAt: "2026-11-16T22:00:00.000Z", lists: [], exchanges: [], robinhood: [], unread: [] };
  const call = (args: unknown, sightings: (token: string) => Promise<typeof board>) => callTool(desk, "brainchain_token_sightings", args, undefined, undefined, undefined, { sightings, listed: noLookup });

  it("serves the board without a desk or a key, and refuses what is not an address before reading anything", async () => {
    const asked: string[] = [];
    const read = async (token: string) => (asked.push(token), board);
    expect(body(await call({ token: CASHCAT.toLowerCase() }, read))).toEqual(board);
    for (const [args, said] of [
      [{}, "token is required."],
      [{ token: "0xCASHCAT" }, "token must be an address on Robinhood Chain: 0x followed by 40 hex characters."],
      [{ token: CASHCAT, symbol: "CASHCAT" }, "Unknown field: symbol. This tool takes only token, atBlock, at."],
      [{ token: CASHCAT, at: "2026-08-06", atBlock: 1 }, "Pass atBlock or at, not both."],
      [{ token: CASHCAT, at: "2126-08-06" }, "at is in the future."],
    ] as const) {
      const result = await call(args, read);
      expect(result.isError).toBe(true);
      expect(body(result)).toEqual({ error: said });
    }
    expect(asked).toEqual([CASHCAT]);
  });

  it("hands a cut-off to the reader as a block or a time, and passes on what the chain says of a block", async () => {
    const asked: unknown[] = [];
    const read = (async (_token: string, until?: unknown) => (asked.push(until), board)) as (token: string) => Promise<typeof board>;
    await call({ token: CASHCAT, at: "2026-08-06T00:00:00Z" }, read);
    await call({ token: CASHCAT, atBlock: 28_900_542 }, read);
    expect(asked).toEqual([{ time: Date.parse("2026-08-06T00:00:00Z") }, { block: 28_900_542n }]);
    const later = new ChainError("Block 99999999999 is not on Robinhood Chain yet: the newest block is 29000000.");
    expect(body(await call({ token: CASHCAT, atBlock: 99_999_999_999 }, async () => Promise.reject(later)))).toEqual({ error: later.message });
  });

  it("answers a failed read in one line, and passes on what is already written for the reader", async () => {
    const none = new SightingsError("None of the lists could be read just now. Try again in a minute.");
    for (const [error, said] of [
      [new TypeError("fetch failed"), "The lists could not be read just now: fetch failed. Try again in a minute."],
      [none, none.message],
    ] as const) {
      const result = await call({ token: CASHCAT }, async () => Promise.reject(error));
      expect(result.isError).toBe(true);
      expect(body(result)).toEqual({ error: said });
    }
  });
});

describe("a token by symbol", () => {
  const RLUSD = "0x8d58C0C60B8D6b88Fa98B291a646dB34d0F98258";
  const CASHCAT = "0x020bfC650A365f8BB26819deAAbF3E21291018b4";
  const TWIN = "0x0000000000000000000000000000000000000Ca7";
  // BitGo's own ids and names, as its lists held them on 2026-11-18; the second Cash Cat is made up.
  const LISTED: CustodyToken[] = [
    { id: "hoodeth:rlusd", name: "Ripple USD", contract: RLUSD, decimals: 18 },
    { id: "hoodeth:cashcat", name: "Cash Cat", contract: CASHCAT, decimals: 18 },
    { id: "hoodeth:tsla", name: "Tesla • Robinhood", contract: "0x322F0c7BE2B2Aa2d1E4f0F6F3fAAB0C7C3E00DDc" as `0x${string}`, decimals: 18 },
  ];
  const twins: CustodyToken[] = [...LISTED, { id: "hoodeth:cashcat2", name: "Cash Cat", contract: TWIN, decimals: 18 }];
  const boards = {
    makers: { chain: "Robinhood Chain", token: { contract: RLUSD }, readAt: "x", wallets: [] },
    readiness: { chain: "Robinhood Chain", deployed: true },
    sightings: { chain: "Robinhood Chain", lists: [] },
    timeline: { chain: "Robinhood Chain", steps: [] },
    marketCap: { chain: "Robinhood Chain", priceUsd: "0.1" },
  };
  const tools = [
    ["brainchain_market_maker_holdings", "makers"],
    ["brainchain_token_readiness", "readiness"],
    ["brainchain_token_sightings", "sightings"],
    ["brainchain_token_timeline", "timeline"],
    ["brainchain_token_market_cap", "marketCap"],
  ] as const;

  it("reads the one token a symbol, an id or a name stands for, and says which contract it was", async () => {
    for (const [name, reader] of tools) {
      for (const [asked, id, contract] of [
        ["RLUSD", "hoodeth:rlusd", RLUSD],
        ["$rlusd", "hoodeth:rlusd", RLUSD],
        ["hoodeth:rlusd", "hoodeth:rlusd", RLUSD],
        ["  ripple   USD ", "hoodeth:rlusd", RLUSD],
        ["TSLA", "hoodeth:tsla", LISTED[2]!.contract],
      ] as const) {
        const read: string[] = [];
        const result = await callTool(desk, name, { token: asked }, undefined, undefined, undefined, { [reader]: async (token: string) => (read.push(token), boards[reader]), listed: async () => LISTED });
        expect(result.isError, `${name} ${asked}`).toBe(false);
        expect(read).toEqual([contract]);
        const answer = body(result) as Record<string, unknown>;
        expect(Object.keys(answer)[0]).toBe("lookup");
        expect(answer.lookup).toEqual({ asked: asked.trim(), id, name: LISTED.find((token) => token.id === id)!.name, contract, source: "BitGo" });
        expect(answer).toMatchObject(boards[reader]);
      }
    }
  });

  it("lists the tokens a symbol several go by, and reads none of them", async () => {
    for (const [name, reader] of tools) {
      let reads = 0;
      const result = await callTool(desk, name, { token: "cash cat" }, undefined, undefined, undefined, { [reader]: async () => (reads++, boards[reader]), listed: async () => twins });
      expect(result.isError).toBe(true);
      expect(body(result)).toEqual({
        error: '2 tokens on BitGo\'s lists for Robinhood Chain go by "cash cat", so nothing was read. Pass the contract address of the one you mean, from `candidates`.',
        candidates: [twins[1], twins[3]].map((token) => ({ ...token, source: "BitGo" })),
      });
      expect(reads).toBe(0);
    }
  });

  const DOGE = "0xb66d83f0a5a3b5eE6f4C1C1c11F1aE10b2B71a31";
  const PEPES = ["0xa4bd8def00000000000000000000000000000001", "0x9b09c43500000000000000000000000000000002"];
  const listed = (tokens: { token: string; symbol?: string; name?: string; sources: string[] }[]) => async () => ({ tokens, steps: [], outcomes: [], rates: {}, ref: {} }) as never;

  it("looks past BitGo's lists at the lists the dataset records, then at every token with a pool, naming where each was found", async () => {
    for (const [name, reader] of tools) {
      const read: string[] = [];
      const ask = (token: string, extra: object) => callTool(desk, name, { token }, undefined, undefined, undefined, { [reader]: async (address: string) => (read.push(address), boards[reader]), listed: async () => LISTED, ...extra });
      const fromList = await ask("doge", { dataset: listed([{ token: DOGE.toLowerCase(), symbol: "DOGE", name: "DoOnlyGoodEveryday", sources: ["CoinGecko"] }]), symbols: async () => [] });
      expect(fromList.isError).toBe(false);
      expect((body(fromList) as { lookup: unknown }).lookup).toEqual({ asked: "doge", symbol: "DOGE", name: "DoOnlyGoodEveryday", contract: getAddress(DOGE), source: "CoinGecko" });
      const fromPools = await ask("$frog", { dataset: listed([]), symbols: async () => [{ symbol: "FROG", token: PEPES[0]! }] });
      expect((body(fromPools) as { lookup: unknown }).lookup).toEqual({ asked: "$frog", symbol: "FROG", contract: getAddress(PEPES[0]!), source: "pool index" });
      expect(read).toEqual([getAddress(DOGE), getAddress(PEPES[0]!)]);

      const many = await ask("PEPE", { dataset: listed([]), symbols: async () => PEPES.map((token) => ({ symbol: "PEPE", token })) });
      expect(many.isError).toBe(true);
      expect(body(many)).toEqual({
        error: '2 tokens with a Uniswap pool, by the symbol the contract gives itself, go by "PEPE", so nothing was read. Pass the contract address of the one you mean, from `candidates`.',
        candidates: PEPES.map((token) => ({ contract: getAddress(token), symbol: "PEPE", source: "pool index" })),
      });
      const crowd = Array.from({ length: 25 }, (_, i) => ({ symbol: "PEPE", token: `0x${String(i + 1).padStart(40, "0")}` }));
      const capped = body(await ask("PEPE", { dataset: listed([]), symbols: async () => crowd })) as { error: string; candidates: unknown[]; total: number };
      expect(capped.candidates).toHaveLength(20);
      expect(capped.total).toBe(25);
      expect(capped.error).toContain("`candidates` lists the first 20");
    }
  });

  it("says so when no token goes by the symbol, or BitGo gives the one that does no contract", async () => {
    for (const [name, reader] of tools) {
      let reads = 0;
      const nothing = { dataset: listed([]), symbols: async () => [] };
      const ask = (token: string, listed: () => Promise<CustodyToken[]>, extra: object = nothing) => callTool(desk, name, { token }, undefined, undefined, undefined, { [reader]: async () => (reads++, boards[reader]), listed, ...extra });
      expect(body(await ask("DOGE", async () => LISTED))).toEqual({ error: 'No token on BitGo\'s lists for Robinhood Chain, on the lists the dataset records or with a Uniswap pool goes by "DOGE". Pass the token\'s contract address instead.' });
      expect(body(await ask("DOGE", async () => LISTED, { dataset: async () => Promise.reject(new TypeError("fetch failed")) }))).toEqual({
        error: 'No token on BitGo\'s lists for Robinhood Chain has the id or name "DOGE", and the dataset could not be read just now to look further. Pass the token\'s contract address instead.',
      });
      expect(body(await ask("deed", async () => [{ id: "hoodeth:deed" }]))).toEqual({ error: "BitGo lists hoodeth:deed in a form this tool does not read, so it has no contract address for it. Pass the token's contract address instead." });
      expect(body(await ask("x".repeat(81), async () => LISTED))).toEqual({ error: "token must be a contract address on Robinhood Chain, or a symbol or name of one line and at most 80 characters." });
      expect(body(await ask("Cash\nCat", async () => LISTED))).toEqual({ error: "token must be a contract address on Robinhood Chain, or a symbol or name of one line and at most 80 characters." });
      expect(reads).toBe(0);
    }
  });

  it("passes on why BitGo's lists could not be read, and looks nothing up for an address", async () => {
    const said = [
      [new TypeError("fetch failed"), "BitGo's code on GitHub could not be read just now to look up the symbol: fetch failed. Pass the token's contract address, or try again in a minute."],
      [new CustodyError("GitHub is temporarily refusing requests from this IP address. Try again in a minute."), "GitHub is temporarily refusing requests from this IP address. Try again in a minute."],
    ] as const;
    for (const [name, reader] of tools) {
      for (const [error, message] of said) {
        const result = await callTool(desk, name, { token: "RLUSD" }, undefined, undefined, undefined, { [reader]: async () => boards[reader], listed: async () => Promise.reject(error) });
        expect(body(result)).toEqual({ error: message });
      }
      const result = await callTool(desk, name, { token: RLUSD.toLowerCase() }, undefined, undefined, undefined, { [reader]: async () => boards[reader], listed: noLookup });
      expect(result.isError).toBe(false);
      expect(body(result)).not.toHaveProperty("lookup");
    }
  });

  it("checks the rest of a market maker call before it looks a symbol up", async () => {
    let lookups = 0;
    const result = await callTool(desk, "brainchain_market_maker_holdings", { token: "RLUSD", atBlock: -1 }, undefined, undefined, undefined, { listed: async () => (lookups++, LISTED) });
    expect(body(result)).toEqual({ error: "atBlock must be a block number: a whole number from 0." });
    expect(lookups).toBe(0);
  });
});

describe("token timeline", () => {
  const CASHCAT = "0x020bfC650A365f8BB26819deAAbF3E21291018b4";
  const board = { chain: "Robinhood Chain" as const, token: { contract: CASHCAT as `0x${string}` }, readAt: "2026-11-18T12:00:00.000Z", deployed: true, steps: [], undated: [], unread: [] };
  const call = (args: unknown, timeline: (token: string, until?: unknown) => Promise<typeof board>) => callTool(desk, "brainchain_token_timeline", args, undefined, undefined, undefined, { timeline, listed: noLookup });

  it("serves the board without a desk or a key, with a cut-off at a past block or time, or none", async () => {
    const asked: unknown[][] = [];
    const read = async (token: string, until?: unknown) => (asked.push([token, until]), board);
    for (const args of [{ token: CASHCAT.toLowerCase() }, { token: CASHCAT, atBlock: 820_611 }, { token: CASHCAT, at: "2026-07-08T15:00:00Z" }]) {
      const result = await call(args, read);
      expect(result.isError).toBe(false);
      expect(body(result)).toEqual(board);
    }
    expect(asked).toEqual([
      [CASHCAT, undefined],
      [CASHCAT, { block: 820_611n }],
      [CASHCAT, { time: Date.parse("2026-07-08T15:00:00Z") }],
    ]);
  });

  it("refuses what it cannot read, and fields it does not take, before reading anything", async () => {
    let reads = 0;
    const read = async () => (reads++, board);
    for (const [args, said] of [
      [{}, "token is required."],
      [{ token: "0xCASHCAT" }, "token must be an address on Robinhood Chain: 0x followed by 40 hex characters."],
      [{ token: CASHCAT, atBlock: -5 }, "atBlock must be a block number: a whole number from 0."],
      [{ token: CASHCAT, at: "2026-07-08T15:00" }, "at must be a time in ISO 8601, such as 2026-11-01T00:00:00Z, or a date, such as 2026-11-01."],
      [{ token: CASHCAT, atBlock: 1, at: "2026-07-08" }, "Pass atBlock or at, not both."],
      [{ token: CASHCAT, days: 30 }, "Unknown field: days. This tool takes only token, atBlock, at."],
    ] as const) {
      const result = await call(args, read);
      expect(result.isError).toBe(true);
      expect(body(result)).toEqual({ error: said });
    }
    expect(reads).toBe(0);
  });

  it("answers a failed read in one line, and passes on what is already written for the reader", async () => {
    const slow = new ChainError(STILL_READING);
    for (const [error, said] of [
      [Object.assign(new Error("HTTP request failed.\n\nStatus: 429"), { status: 429 }), "Robinhood Chain could not be read just now: HTTP 429. Try again in a minute."],
      [slow, slow.message],
      [new ChainError("Block 9 is not on Robinhood Chain yet: the newest block is 8."), "Block 9 is not on Robinhood Chain yet: the newest block is 8."],
    ] as const) {
      const result = await call({ token: CASHCAT }, async () => Promise.reject(error));
      expect(result.isError).toBe(true);
      expect(body(result)).toEqual({ error: said });
    }
  });
});

describe("token market cap", () => {
  const CASHCAT = "0x020bfC650A365f8BB26819deAAbF3E21291018b4";
  const board = { chain: "Robinhood Chain" as const, token: { contract: CASHCAT as `0x${string}`, decimals: 18 }, readAt: "2026-11-19T08:00:00.000Z", priceUsd: "0.038251409", supply: "1000000000", marketCapUsd: "38251409.44" };
  const call = (args: unknown, marketCap: (token: string, moment?: unknown) => Promise<typeof board>) =>
    callTool(desk, "brainchain_token_market_cap", args, undefined, undefined, undefined, { marketCap: marketCap as never, listed: noLookup });

  it("serves the board without a desk or a key, at a past block or time, or at the newest block", async () => {
    const asked: unknown[][] = [];
    const read = async (token: string, moment?: unknown) => (asked.push([token, moment]), board);
    for (const args of [{ token: CASHCAT.toLowerCase() }, { token: CASHCAT, atBlock: 29_356_674 }, { token: CASHCAT, at: "2026-07-28T07:09:00Z" }]) {
      const result = await call(args, read);
      expect(result.isError).toBe(false);
      expect(body(result)).toEqual(board);
    }
    expect(asked).toEqual([
      [CASHCAT, undefined],
      [CASHCAT, { block: 29_356_674n }],
      [CASHCAT, { time: Date.parse("2026-07-28T07:09:00Z") }],
    ]);
  });

  it("refuses what it cannot read, and fields it does not take, before reading anything", async () => {
    let reads = 0;
    const read = async () => (reads++, board);
    for (const [args, said] of [
      [{}, "token is required."],
      [{ token: CASHCAT, atBlock: 1.5 }, "atBlock must be a block number: a whole number from 0."],
      [{ token: CASHCAT, at: "2099-01-01" }, "at is in the future."],
      [{ token: CASHCAT, atBlock: 1, at: "2026-07-08" }, "Pass atBlock or at, not both."],
      [{ token: CASHCAT, wallet: CASHCAT }, "Unknown field: wallet. This tool takes only token, atBlock, at."],
    ] as const) {
      const result = await call(args, read);
      expect(result.isError).toBe(true);
      expect(body(result)).toEqual({ error: said });
    }
    expect(reads).toBe(0);
  });

  it("answers a failed read in one line, and passes on what is already written for the reader", async () => {
    const written = new ChainError("USDG is the dollar this tool prices in: it counts one USDG as one dollar.");
    for (const [error, said] of [
      [Object.assign(new Error("HTTP request failed.\n\nStatus: 429"), { status: 429 }), "Robinhood Chain could not be read just now: HTTP 429. Try again in a minute."],
      [written, written.message],
    ] as const) {
      const result = await call({ token: CASHCAT }, async () => Promise.reject(error));
      expect(result.isError).toBe(true);
      expect(body(result)).toEqual({ error: said });
    }
  });
});
