import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";

import { CHANGES_NAME, CHANGES_TOOL, changesQuery, createWatch, HOSTED_WATCH_URL, readChanges, removeWatch, UNWATCH_NAME, WATCH_NAME, WATCH_TOOL, watchUrl } from "../changes.js";
import { createServer } from "../server.js";
import { callTool, type Desk } from "../tools.js";
import type { IndexedCall } from "../calls.js";
import { discordRelay, githubEvery, githubToken, watchArgs } from "./cli.js";
import { useGitHubToken } from "../github.js";
import { Deliveries } from "./deliver.js";
import { EventLog, KINDS, type Found } from "./events.js";
import type { Post } from "./net.js";
import { INDEX_FROM, PoolIndex, type IndexedPool } from "./pools.js";
import { clientOf, eventsQuery, keyOf, MAX_POOLS, SERVE_LIMITS, serveEvents, type PageNames, type PoolLookup, type ServeOptions } from "./serve.js";

const CASHCAT = "0x020bfC650A365f8BB26819deAAbF3E21291018b4";
const found = (kind: Found["kind"], ref: string, token: Found["token"] = { address: CASHCAT, symbol: "CASHCAT", name: "Cash Cat" }): Found => ({ kind, token, source: "x", ref, at: null, detail: {} });

let close: (() => void) | undefined;
afterEach(() => close?.());

const dir = () => mkdtempSync(join(tmpdir(), "brainchain-watch-"));
/** Appends rows and settles each new event's context, so it is published. */
const settled = (log: EventLog, rows: (Found & { observedAt: string; baseline?: true })[]) => {
  const { written } = log.append(rows);
  return written.flatMap((event) => log.settle(event.id, {}));
};

/** A sender that records what it was asked to post and answers with `status`. */
function poster(status = 204) {
  const posts: { url: string; body: string; headers: Record<string, string> }[] = [];
  const post: Post = async (url, body, headers) => (posts.push({ url: url.href, body, headers }), { status: status, body: "" });
  return { posts, post };
}

async function serving({ healthy = true, trustProxy = false, limits = SERVE_LIMITS, post = poster().post, pools = undefined as PoolLookup | undefined, names = undefined as PageNames | undefined, calls = undefined as ServeOptions["calls"] } = {}) {
  const where = dir();
  const log = new EventLog(where);
  settled(log, [{ ...found("bitgo.merged", "old"), observedAt: "2026-11-18T00:00:00.000Z", baseline: true }]);
  settled(log, [{ ...found("bitgo.pr_opened", "pr"), observedAt: "2026-11-19T10:00:00.000Z" }]);
  settled(log, [{ ...found("pool.created", "0xabc"), observedAt: "2026-11-19T11:00:00.000Z" }]);
  settled(log, [{ ...found("robinhood.pair_added", "pairs#PONS", { address: null, symbol: "PONS", name: "Pons" }), observedAt: "2026-11-19T12:00:00.000Z" }]);
  const deliveries = new Deliveries({ dir: where, log, post, check: async () => {} });
  const served = serveEvents({ log, ...(pools ? { pools } : {}), ...(names ? { names } : {}), ...(calls ? { calls } : {}), health: () => ({ ok: healthy, sources: {} }), deliveries, trustProxy, limits, clock: () => Date.parse("2026-11-19T13:00:00Z") });
  await new Promise<void>((resolve) => served.server.listen(0, "127.0.0.1", resolve));
  close = () => served.close();
  return { base: new URL(`http://127.0.0.1:${(served.server.address() as AddressInfo).port}`), log, served, deliveries };
}

const get = async (url: URL | string) => {
  const response = await fetch(url);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

describe("GET /events", () => {
  it("serves the events after a cursor, filtered by kind and token, with where to go on from", async () => {
    const { base } = await serving();
    const all = await get(new URL("/events", base));
    expect(all.status).toBe(200);
    expect(all.body).toMatchObject({ readAt: "2026-11-19T13:00:00.000Z", next: 4, more: false });
    expect((all.body.events as { id: number }[]).map(({ id }) => id)).toEqual([2, 3, 4]);
    expect(((await get(new URL("/events?since=2&limit=1", base))).body.events as { id: number }[]).map(({ id }) => id)).toEqual([3]);
    expect(((await get(new URL("/events?since=2026-11-19T11:00:00Z", base))).body.events as { id: number }[]).map(({ id }) => id)).toEqual([3, 4]);
    expect(((await get(new URL("/events?kinds=bitgo,robinhood.pair_added", base))).body.events as { id: number }[]).map(({ id }) => id)).toEqual([2, 4]);
    expect(((await get(new URL(`/events?tokens=${CASHCAT.toLowerCase()}&baseline=1`, base))).body.events as { id: number }[]).map(({ id }) => id)).toEqual([1, 2, 3]);
  });

  it("says what is wrong with a query, and serves nothing else", async () => {
    const { base } = await serving();
    for (const [query, error] of [
      ["since=yesterday", /^since must be an event id/],
      ["kinds=binance", /^Unknown kind: binance\./],
      ["limit=0", /^limit must be a whole number from 1 to 1000/],
      ["limit=5000", /^limit must be/],
    ] as const) {
      const { status, body } = await get(new URL(`/events?${query}`, base));
      expect(status).toBe(400);
      expect(body.error).toMatch(error);
    }
    expect((await get(new URL("/nothing", base))).status).toBe(404);
    expect((await fetch(new URL("/events", base), { method: "POST" })).status).toBe(405);
  });
});

describe("GET /health", () => {
  it("answers 200 while every source reads, and 503 while one keeps failing", async () => {
    expect((await get(new URL("/health", (await serving()).base))).status).toBe(200);
    close?.();
    expect((await get(new URL("/health", (await serving({ healthy: false })).base))).status).toBe(503);
  });
});

describe("the events query", () => {
  it("takes an id or a time as since, and lists separated by commas", () => {
    expect(eventsQuery(new URLSearchParams("since=12&kinds=bitgo, maker&tokens=CASHCAT,0xabc&limit=5"))).toEqual({ since: { id: 12 }, kinds: ["bitgo", "maker"], tokens: ["CASHCAT", "0xabc"], limit: 5 });
    expect(eventsQuery(new URLSearchParams("since=2026-11-19"))).toEqual({ since: { time: Date.parse("2026-11-19") } });
  });
});

const desk = {} as Desk;
const text = (result: { content: unknown }) => (result.content as { text: string }[])[0]!.text;

describe("the changes tool", () => {
  it("names every kind the watcher records, in the description and in the README, and says what the Robinhood pair list leaves out", () => {
    const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
    const section = readme.slice(readme.indexOf("## Watch public changes"), readme.indexOf("## Market cap at a time"));
    for (const text of [CHANGES_TOOL.description!, section]) {
      for (const kind of KINDS) expect(text, kind).toContain(`\`${kind}\``);
      expect(text).toContain("the pair list Robinhood serves to API clients");
      expect(text).toMatch(/leaves out most price-only pairs/);
      expect(text).not.toMatch(/public list of crypto pairs|new pair on Robinhood|no pair/i);
    }
    expect(CHANGES_TOOL.description).toContain("`maker.pool_queued`, a market maker adding one of a token's pools to its trading contracts' approved list for the first time");
  });

  it("reads BrainChain's own watcher unless BRAINCHAIN_WATCH_URL names another", async () => {
    const asked: string[] = [];
    const answering = (async (url: URL) => (asked.push(String(url)), Response.json({ readAt: "2026-11-19T13:00:00.000Z", events: [], next: 9, more: false }))) as unknown as typeof fetch;
    expect(await readChanges(watchUrl(undefined), { since: "4" }, answering)).toEqual({ watcher: HOSTED_WATCH_URL, readAt: "2026-11-19T13:00:00.000Z", events: [], next: 9, more: false });
    expect(asked).toEqual([`${HOSTED_WATCH_URL}/events?since=4`]);
  });

  it("returns a running watcher's events and the cursor for the next call", async () => {
    const { base } = await serving();
    const answer = (await readChanges(base, { since: "2", kinds: ["pool"], tokens: ["cashcat"] })) as Record<string, unknown>;
    expect(answer).toMatchObject({ watcher: base.origin, next: 4, more: false });
    expect((answer.events as { kind: string }[]).map(({ kind }) => kind)).toEqual(["pool.created"]);
    const result = await callTool(desk, CHANGES_NAME, { since: 3 }, undefined, undefined, undefined, { changes: (query) => readChanges(base, query) });
    expect(JSON.parse(text(result))).toMatchObject({ events: [{ id: 4, kind: "robinhood.pair_added" }], next: 4 });
  });

  it("passes on what the watcher finds wrong with a query, and says when it cannot be reached and how to run one", async () => {
    const { base } = await serving();
    await expect(readChanges(base, { since: "yesterday" })).rejects.toThrow(/^since must be an event id/);
    close?.();
    close = undefined;
    await expect(readChanges(base, {})).rejects.toThrow(`The watcher at ${base.origin} could not be reached just now. Try again in a minute. To run your own, start \`npx -y brainchain-mcp watch --serve 8787\``);
    const notWatcher = (async () => new Response("<html></html>", { status: 200 })) as unknown as typeof fetch;
    await expect(readChanges(base, {}, notWatcher)).rejects.toThrow(/answered 200 without a list of events/);
  });

  it("checks what it is sent before asking the watcher", () => {
    expect(changesQuery({ since: 7, kinds: ["bitgo"], tokens: [" PONS "], limit: 10 })).toEqual({ since: "7", kinds: ["bitgo"], tokens: ["PONS"], limit: 10 });
    expect(() => changesQuery({ kinds: ["listing"] })).toThrow("Unknown kind: listing.");
    expect(() => changesQuery({ limit: 0 })).toThrow("limit must be a whole number from 1 to 1000.");
    expect(() => changesQuery({ tokens: "PONS" })).toThrow("tokens must be a list of strings.");
    expect(() => changesQuery({ since: -1 })).toThrow(/^since must be/);
  });

  it("reads BRAINCHAIN_WATCH_URL as an http or https address, and BrainChain's own watcher without it", () => {
    expect(watchUrl(undefined).href).toBe(`${HOSTED_WATCH_URL}/`);
    expect(watchUrl(" http://127.0.0.1:8787 ").href).toBe("http://127.0.0.1:8787/");
    expect(() => watchUrl("localhost:8787")).toThrow("BRAINCHAIN_WATCH_URL must start with http:// or https://.");
    expect(() => watchUrl("not a url")).toThrow(/^BRAINCHAIN_WATCH_URL must be the address/);
    expect(() => watchUrl("https://user:secret@watch.example")).toThrow("BRAINCHAIN_WATCH_URL must not hold a user name or password.");
  });

  it("is in the README's tools, with the watcher it reads and what an event does not mean", () => {
    const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
    const row = readme.split("\n").find((line) => line.startsWith(`| \`${CHANGES_NAME}\` |`))!;
    expect(row).toContain("Reads the watcher `BRAINCHAIN_WATCH_URL` names, BrainChain's own by default. Free, no key.");
    const section = readme.split("\n## Watch public changes\n")[1]!.split("\n## ")[0]!;
    expect(section).toContain("It does not say why, and most tokens with these traces are never listed.");
    expect(section).toContain("reports none of it as new, so a new watcher starts quiet.");
    expect(section).toContain("`v1=` and the hex HMAC-SHA256, keyed with the watch's `secret`, of the timestamp, a full stop and the body.");
    expect(section).not.toMatch(/\u2014|alpha|front-?run|insider|will list|forecast/i);
  });

  it("describes changes in plain words and makes no forecast", () => {
    const description = CHANGES_TOOL.description!;
    expect(description).toMatch(/^New public changes about Robinhood Chain tokens since your last call/);
    expect(description).toContain("It does not say why, and most tokens with these traces are never listed.");
    for (const word of [/alpha/i, /front-?run/i, /insider/i, /\bleak/i, /signal/i, /score/i, /will list/i, /forecast/i, /\u2014/]) expect(description).not.toMatch(word);
  });
});

describe("the watch command's arguments", () => {
  it("take a state folder, a port or a host and port, and --print", () => {
    expect(watchArgs([])).toEqual({ print: false, trustProxy: false });
    expect(watchArgs(["--state", "/tmp/w", "--serve", "8787", "--print", "--trust-proxy"])).toEqual({ state: "/tmp/w", serve: { host: "127.0.0.1", port: 8787 }, print: true, trustProxy: true });
    expect(watchArgs(["--serve", "0.0.0.0:9000"]).serve).toEqual({ host: "0.0.0.0", port: 9000 });
    expect(watchArgs(["--serve", "[::1]:9000"]).serve).toEqual({ host: "::1", port: 9000 });
    expect(() => watchArgs(["--serve", "99999"])).toThrow(/^--serve needs a port/);
    expect(() => watchArgs(["--state"])).toThrow("--state needs a folder.");
    expect(() => watchArgs(["--follow"])).toThrow("Unknown argument --follow.");
  });

  it("take a Discord relay only with its key, at a public https address", () => {
    const key = "r".repeat(43);
    expect(discordRelay({})).toBeUndefined();
    expect(discordRelay({ BRAINCHAIN_WATCH_DISCORD_RELAY: "https://relay.example.workers.dev/", BRAINCHAIN_WATCH_DISCORD_RELAY_KEY: key })).toEqual({ url: new URL("https://relay.example.workers.dev/"), key });
    expect(() => discordRelay({ BRAINCHAIN_WATCH_DISCORD_RELAY: "https://relay.example.workers.dev/" })).toThrow(/must hold the relay's key/);
    expect(() => discordRelay({ BRAINCHAIN_WATCH_DISCORD_RELAY: "http://127.0.0.1/", BRAINCHAIN_WATCH_DISCORD_RELAY_KEY: key })).toThrow("url must start with https://.");
  });
});

/** Reads a server-sent event stream frame by frame. */
async function stream(url: URL, headers: Record<string, string> = {}) {
  const abort = new AbortController();
  const response = await fetch(url, { headers, signal: abort.signal });
  const reader = response.body!.getReader();
  let buffer = "";
  const frames: string[] = [];
  return {
    response,
    async next(): Promise<string> {
      for (;;) {
        const at = buffer.indexOf("\n\n");
        if (at >= 0) {
          const frame = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          if (frame.startsWith("retry:") || frame.startsWith(":")) continue;
          frames.push(frame);
          return frame;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error("stream ended");
        buffer += new TextDecoder().decode(value);
      }
    },
    close: () => abort.abort(),
  };
}
const idOf = (frame: string) => Number(/^id: (\d+)$/m.exec(frame)?.[1]);

describe("GET /events/stream", () => {
  it("resumes after Last-Event-ID, then sends events as they are published, never the baseline", async () => {
    const { base, log, served } = await serving();
    const events = await stream(new URL("/events/stream", base), { "Last-Event-ID": "1" });
    expect(events.response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect([idOf(await events.next()), idOf(await events.next()), idOf(await events.next())]).toEqual([2, 3, 4]);
    served.publish(settled(log, [{ ...found("kucoin.listed", "kucoin"), observedAt: "2026-11-19T13:00:00.000Z" }]));
    const live = await events.next();
    expect([idOf(live), /^event: (.+)$/m.exec(live)?.[1], JSON.parse(/^data: (.+)$/m.exec(live)![1]!).kind]).toEqual([5, "kucoin.listed", "kucoin.listed"]);
    events.close();
  });

  it("sends an event's finished context as an update frame to a stream that had the event", async () => {
    const { base, log, served } = await serving();
    const events = await stream(new URL("/events/stream", base));
    const { written } = log.append([{ ...found("pool.created", "0xfeed"), observedAt: "2026-11-19T13:00:00.000Z" }]);
    served.publish(log.settle(written[0]!.id, { pending: ["worth"] }));
    expect(idOf(await events.next())).toBe(5);
    served.update(log.update(5, { worth: { marketCapUsd: "1.00" } })!);
    const update = await events.next();
    expect(/^id:/m.test(update)).toBe(false);
    expect([/^event: (.+)$/m.exec(update)?.[1], JSON.parse(/^data: (.+)$/m.exec(update)![1]!)]).toEqual(["update", { id: 5, kind: "pool.created", token: found("pool.created", "x").token, context: { worth: { marketCapUsd: "1.00" } } }]);
    // A read of the events now shows it finished.
    expect(((await get(new URL("/events?since=4", base))).body.events as { context: unknown }[])[0]!.context).toEqual({ worth: { marketCapUsd: "1.00" } });
    events.close();
  });

  it("starts at the newest event without a cursor, and keeps only the kinds and tokens asked for", async () => {
    const { base, log, served } = await serving();
    const pools = await stream(new URL("/events/stream?kinds=pool", base));
    served.publish(settled(log, [{ ...found("kucoin.listed", "kucoin"), observedAt: "2026-11-19T13:00:00.000Z" }, { ...found("pool.created", "0xdef"), observedAt: "2026-11-19T13:00:00.000Z" }]));
    expect(idOf(await pools.next())).toBe(6);
    pools.close();
  });

  it("holds an address to its streams, and refuses a cursor that is not an id", async () => {
    const { base } = await serving({ limits: { ...SERVE_LIMITS, streamsPerAddress: 1 } });
    const first = await stream(new URL("/events/stream", base));
    expect((await get(new URL("/events/stream", base))).status).toBe(429);
    first.close();
    expect((await get(new URL("/events/stream?since=yesterday", base))).body.error).toBe("Last-Event-ID and since take an event id.");
  });
});

const post = (base: URL, body: unknown, headers: Record<string, string> = { "Content-Type": "application/json" }) =>
  fetch(new URL("/watches", base), { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) }).then(async (response) => ({ status: response.status, body: (await response.json()) as Record<string, unknown> }));
const manage = (base: URL, id: string, token: string, method: "GET" | "DELETE") => fetch(new URL(`/watches/${id}`, base), { method, headers: { Authorization: `Bearer ${token}` } });

describe("watches", () => {
  it("are made with a url, give their secret and manage token once, and are read or removed only with that token", async () => {
    const { base } = await serving();
    const made = await post(base, { url: "https://hooks.example.com/brainchain", kinds: ["bitgo"] });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ id: expect.stringMatching(/^[\w-]{22}$/), secret: expect.stringMatching(/^[\w-]{43}$/), manageToken: expect.stringMatching(/^[\w-]{43}$/), format: "webhook", from: 4 });
    expect(made.body.signing).toContain("X-BrainChain-Signature: v1=");
    const { id, manageToken } = made.body as { id: string; manageToken: string };
    const status = await manage(base, id, manageToken, "GET");
    const shown = (await status.json()) as Record<string, unknown>;
    expect([status.status, shown.host, shown.kinds, "url" in shown, "secret" in shown, "manageHash" in shown]).toEqual([200, "hooks.example.com", ["bitgo"], false, false, false]);
    // A wrong token, a made-up id and a missing token all answer the same.
    for (const [watch, token] of [[id, "x".repeat(43)], ["a".repeat(22), manageToken]]) expect((await manage(base, watch!, token!, "DELETE")).status).toBe(404);
    expect((await fetch(new URL(`/watches/${id}`, base), { method: "DELETE" })).status).toBe(404);
    expect((await manage(base, id, manageToken, "DELETE")).status).toBe(204);
    expect((await manage(base, id, manageToken, "GET")).status).toBe(404);
    // Nothing lists them.
    expect((await fetch(new URL("/watches", base))).status).toBe(405);
  });

  it("refuse what they cannot take, as they are sent", async () => {
    // Every try counts against the hourly cap, a refused one too, so none can be used to probe.
    const { base } = await serving({ limits: { ...SERVE_LIMITS, watchesPerHour: 20 } });
    for (const [body, status, error] of [
      [{ url: "http://hooks.example.com/x" }, 400, "url must start with https://."],
      [{ url: "https://10.0.0.8/x" }, 400, "url points at a private, loopback or reserved address."],
      [{ url: "https://localhost/x" }, 400, "url must name a public host."],
      [{ url: "https://hooks.example.com:8080/x" }, 400, "url must use the default https port, 443."],
      [{ url: "https://hooks.example.com/x", secret: "mine" }, 400, "Unknown field: secret. A watch takes url, kinds and tokens."],
      [{ url: "https://hooks.example.com/x", kinds: ["listing"] }, 400, "Unknown kind: listing."],
      [{ url: "https://api.telegram.org/bot123:abc/sendMessage" }, 400, "A Telegram url needs the chat to send to, as ?chat_id= with the chat's id or @name."],
      [[], 400, "Send {url, kinds?, tokens?}."],
      ["{", 400, "The body is not JSON."],
      [{ url: `https://hooks.example.com/${"x".repeat(5000)}` }, 413, "The body can be at most 4096 bytes."],
    ] as const)
      expect(await post(base, body)).toEqual({ status, body: { error } });
    expect(await post(base, "url=x", { "Content-Type": "application/x-www-form-urlencoded" })).toEqual({ status: 415, body: { error: "Send the body as application/json." } });
  });

  it("are held to a number an hour and a number at a time per address", async () => {
    const { base } = await serving({ limits: { ...SERVE_LIMITS, watchesPerHour: 6 } });
    for (let i = 0; i < 5; i++) expect((await post(base, { url: `https://hooks.example.com/${i}` })).status).toBe(201);
    expect(await post(base, { url: "https://hooks.example.com/6" })).toEqual({ status: 400, body: { error: "An address can have 5 watches at a time, switched-off ones included until they are removed. Remove one first." } });
    expect((await post(base, { url: "https://hooks.example.com/7" })).status).toBe(429);
  });
});

describe("GET /robinhood/names", () => {
  it("gives Robinhood's name on each crypto page read, by symbol, to any page, and 404 on a watcher that reads none", async () => {
    const read = { PONS: { name: "Pons", at: "2026-11-21T10:00:00.000Z" }, ORE: { name: "", at: "2026-11-21T10:00:01.000Z" } };
    const { base } = await serving({ names: () => read });
    const answer = await fetch(new URL("/robinhood/names", base));
    expect(answer.headers.get("access-control-allow-origin")).toBe("*");
    expect(await answer.json()).toEqual({ readAt: "2026-11-19T13:00:00.000Z", pages: 2, names: { ORE: read.ORE, PONS: read.PONS } });
    expect((await fetch(new URL("/robinhood/names", base), { method: "POST" })).status).toBe(405);
    close?.();
    const bare = await serving();
    expect(await get(new URL("/robinhood/names", bare.base))).toEqual({ status: 404, body: { error: "This watcher does not read Robinhood's crypto pages." } });
  });
});

describe("GET /pools", () => {
  const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
  const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
  const ZERO = "0x0000000000000000000000000000000000000000";
  const POOLS: IndexedPool[] = [
    { version: 3, pool: "0x4B0c312fFbB068F6a0bEa128759E35d94B94D0E1", currency0: CASHCAT, currency1: USDG, fee: 10_000, tickSpacing: 200, block: 3_000_000 },
    { version: 4, pool: "0xa92a3df27a00a276183ff7265fd8affa11df1fe8bb23ddfaf13f6c879a3f818b", currency0: CASHCAT, currency1: USDG, fee: 2690, tickSpacing: 54, hooks: ZERO, block: 10_435_412 },
    { version: 3, pool: "0x69BfaF19C9f377BB306a89aEd9F6B07e2c1a8d9a", currency0: WETH, currency1: USDG, fee: 500, tickSpacing: 10, block: 50_000 },
    { version: 4, pool: `0x${"15".repeat(32)}`, currency0: ZERO, currency1: USDG, fee: 500, tickSpacing: 10, hooks: ZERO, block: 60_000 },
    { version: 4, pool: `0x${"16".repeat(32)}`, currency0: ZERO, currency1: "0x39dBED3a2bd333467115dE45665cC57F813C4571", fee: 3000, tickSpacing: 60, hooks: ZERO, block: 70_000 },
  ];
  /** The watcher's own index on disk, filled through block 20,000,000 and opened again, as a restart opens it. */
  const index = () => {
    const where = dir();
    const filling = new PoolIndex(where);
    filling.addLive(INDEX_FROM, 20_000_000, POOLS);
    filling.close();
    return new PoolIndex(where);
  };

  it("gives a token's pools from the index, oldest first, with fee, tick spacing, hooks and creation block", async () => {
    const pools = index();
    const { base } = await serving({ pools });
    const answer = await fetch(new URL(`/pools?token=${CASHCAT.toLowerCase()}`, base));
    expect(answer.headers.get("access-control-allow-origin")).toBe("*");
    expect([answer.status, await answer.json()]).toEqual([
      200,
      {
        readAt: "2026-11-19T13:00:00.000Z",
        token: CASHCAT.toLowerCase(),
        through: 20_000_000,
        complete: true,
        pools: [
          { version: 3, pool: POOLS[0]!.pool, currency0: CASHCAT, currency1: USDG, fee: 10_000, tickSpacing: 200, block: 3_000_000 },
          { version: 4, pool: POOLS[1]!.pool, currency0: CASHCAT, currency1: USDG, fee: 2690, tickSpacing: 54, hooks: ZERO, block: 10_435_412 },
        ],
      },
    ]);
    pools.close();
  });

  it("gives ETH, WETH and USDG only their pools with each other, and says so", async () => {
    const pools = index();
    const { base } = await serving({ pools });
    const { status, body } = await get(new URL(`/pools?token=${USDG}`, base));
    expect(status).toBe(200);
    expect(body.only).toBe("pools between ETH, WETH and USDG");
    expect((body.pools as { pool: string }[]).map(({ pool }) => pool)).toEqual([POOLS[2]!.pool, POOLS[3]!.pool]);
    expect(((await get(new URL(`/pools?token=${ZERO}`, base))).body.pools as { pool: string }[]).map(({ pool }) => pool)).toEqual([POOLS[3]!.pool]);
    pools.close();
  });

  it("refuses an address that is not one, answers 503 while the index fills, and 404 on a watcher with no index", async () => {
    const filling: PoolLookup = { ready: false, through: 42_000_000, poolsOf: () => [], basePools: () => [] };
    const { base } = await serving({ pools: filling });
    expect(await get(new URL("/pools?token=CASHCAT", base))).toEqual({ status: 400, body: { error: "token must be a contract address: 0x and 40 hex characters." } });
    expect(await get(new URL(`/pools?token=${CASHCAT}`, base))).toEqual({ status: 503, body: { error: "The pool index is still being filled, through block 42000000. Try again later." } });
    close?.();
    const bare = await serving();
    expect((await get(new URL(`/pools?token=${CASHCAT}`, bare.base))).status).toBe(404);
    expect((await fetch(new URL("/pools", bare.base), { method: "POST" })).status).toBe(405);
  });

  it("gives the whole index a page at a time from a byte, for the dataset, and refuses a byte that starts no line", async () => {
    const pools = index();
    const { base } = await serving({ pools });
    const first = await get(new URL("/pools?after=0&limit=3", base));
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ ready: true, through: 20_000_000, after: 0, bytes: pools.bytes });
    expect((first.body.pools as IndexedPool[]).map(({ pool }) => pool)).toEqual(POOLS.slice(0, 3).map(({ pool }) => pool));
    const rest = await get(new URL(`/pools?after=${first.body.next}`, base));
    expect((rest.body.pools as IndexedPool[]).map(({ pool }) => pool)).toEqual(POOLS.slice(3).map(({ pool }) => pool));
    expect(rest.body.next).toBe(pools.bytes);
    expect((await get(new URL(`/pools?after=${pools.bytes}`, base))).body.pools).toEqual([]);
    expect(await get(new URL("/pools?after=7", base))).toEqual({ status: 400, body: { error: "after must be 0 or the next of an earlier answer." } });
    expect((await get(new URL(`/pools?after=${pools.bytes + 1}`, base))).status).toBe(409);
    expect((await get(new URL("/pools?after=0&limit=0", base))).status).toBe(400);
    pools.close();
  });

  it("gives at most MAX_POOLS pools, and says when a token has more", async () => {
    const many = Array.from({ length: MAX_POOLS + 1 }, (_, i): IndexedPool => ({ ...POOLS[1]!, pool: `0x${i.toString(16).padStart(64, "0")}`, block: i }));
    const { base } = await serving({ pools: { ready: true, through: 1, poolsOf: () => many, basePools: () => [] } });
    const { body } = await get(new URL(`/pools?token=${CASHCAT}`, base));
    expect([body.complete, (body.pools as unknown[]).length]).toEqual([false, MAX_POOLS]);
  });
});

describe("the watcher's HTTP surface", () => {
  it("is not loaded when the MCP server starts: nothing it imports at start reaches the HTTP server", () => {
    const reached = new Set<string>();
    const visit = (file: URL) => {
      if (reached.has(file.pathname)) return;
      reached.add(file.pathname);
      const source = readFileSync(file, "utf8");
      // Static imports only: the watch command's own module is imported when the command runs.
      for (const [, from] of source.matchAll(/^(?:import|export)\s[^;]*?from\s+"([^"]+)";/gms)) {
        if (from!.startsWith(".")) visit(new URL(from!.replace(/\.js$/, ".ts"), file));
        else expect(from, file.pathname).not.toBe("node:http");
      }
    };
    visit(new URL("../index.ts", import.meta.url));
    expect([...reached].some((path) => path.endsWith("/changes.ts"))).toBe(true);
    expect([...reached].filter((path) => path.endsWith("/watch/serve.ts") || path.endsWith("/watch/cli.ts"))).toEqual([]);
  });

  it("holds each address to its requests a minute, telling it when to come back", async () => {
    const { base } = await serving({ limits: { ...SERVE_LIMITS, perMinute: 2 } });
    await fetch(new URL("/health/live", base));
    await fetch(new URL("/health/live", base));
    const refused = await fetch(new URL("/events", base));
    expect([refused.status, refused.headers.get("retry-after")]).toEqual([429, "60"]);
    expect(await refused.json()).toEqual({ error: "Too many requests from your network address: the watcher takes 2 a minute from one address. Wait a minute, then try again." });
  });

  it("takes a client's address from Cloudflare's header, or the hop before Render's, only when told to trust the proxy", async () => {
    for (const [trustProxy, second] of [[true, 200], [false, 429]] as const) {
      const { base } = await serving({ trustProxy, limits: { ...SERVE_LIMITS, perMinute: 1 } });
      // The edge Render appends last is the same for both, as it would be for two clients behind one Cloudflare edge.
      const from = (client: string) => fetch(new URL("/health/live", base), { headers: { "X-Forwarded-For": `6.6.6.6, ${client}, 104.23.1.1` } }).then(({ status }) => status);
      expect([await from("5.6.7.8"), await from("9.9.9.9")]).toEqual([200, second]);
      close?.();
    }
  });

  it("sends its security headers, and opens only the reads to other sites", async () => {
    const { base } = await serving();
    const events = await fetch(new URL("/events", base));
    for (const [name, value] of [["x-content-type-options", "nosniff"], ["cache-control", "no-store"], ["content-security-policy", "default-src 'none'; frame-ancestors 'none'"], ["referrer-policy", "no-referrer"], ["access-control-allow-origin", "*"]])
      expect(events.headers.get(name), name).toBe(value);
    const made = await fetch(new URL("/watches", base), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: "https://hooks.example.com/x" }) });
    expect([made.headers.get("x-content-type-options"), made.headers.get("access-control-allow-origin")]).toEqual(["nosniff", null]);
  });
});

describe("the watch tools", () => {
  it("make a watch on the watcher, hand back its secret and manage token, and remove it with them", async () => {
    const { base } = await serving();
    const readers = { watch: (request: Parameters<typeof createWatch>[1]) => createWatch(base, request), unwatch: (id: string, token: string) => removeWatch(base, id, token) };
    const made = JSON.parse(text(await callTool(desk, WATCH_NAME, { url: "https://discord.com/api/webhooks/123/abc", kinds: ["bitgo"] }, undefined, undefined, undefined, readers))) as Record<string, string>;
    expect(made).toMatchObject({ watcher: base.origin, id: expect.stringMatching(/^[\w-]{22}$/), manageToken: expect.stringMatching(/^[\w-]{43}$/), format: "discord" });
    const wrong = await callTool(desk, UNWATCH_NAME, { id: made.id, manageToken: "x".repeat(43) }, undefined, undefined, undefined, readers);
    expect([wrong.isError, JSON.parse(text(wrong)).error]).toEqual([true, "No watch has that id and manage token on this watcher. It may be removed already."]);
    expect(JSON.parse(text(await callTool(desk, UNWATCH_NAME, { id: made.id, manageToken: made.manageToken }, undefined, undefined, undefined, readers)))).toEqual({ removed: true, id: made.id });
  });

  it("pass on what the watcher refuses, and check what they are sent first", async () => {
    const { base } = await serving();
    const readers = { watch: (request: Parameters<typeof createWatch>[1]) => createWatch(base, request) };
    const refused = await callTool(desk, WATCH_NAME, { url: "https://192.168.1.4/hook" }, undefined, undefined, undefined, readers);
    expect(JSON.parse(text(refused)).error).toBe("url points at a private, loopback or reserved address.");
    for (const [name, args, error] of [
      [WATCH_NAME, { url: "http://hooks.example.com" }, "url must be an https address of at most 2,048 characters."],
      [WATCH_NAME, { url: "https://hooks.example.com", kinds: ["listing"] }, "Unknown kind: listing. The kinds are listed in this tool's description."],
      [UNWATCH_NAME, { id: "short", manageToken: "x".repeat(43) }, "id must be the id brainchain_watch gave: 22 letters, digits, - or _."],
    ] as const)
      expect(JSON.parse(text(await callTool(desk, name, args))).error).toBe(error);
  });

  it("say how to check a delivery and what to keep private, in plain words", () => {
    const description = WATCH_TOOL.description!;
    expect(description).toContain("X-BrainChain-Signature is v1= and the hex HMAC-SHA256, keyed with `secret`, of X-BrainChain-Timestamp, a full stop and the body.");
    expect(description).toContain("Keep all three private");
    for (const word of [/alpha/i, /front-?run/i, /insider/i, /signal/i, /will list/i, /forecast/i, /\u2014/]) expect(description).not.toMatch(word);
  });
});

describe("the changes resource", () => {
  it("reads the newest changes, and while subscribed tells the client of each new one", async () => {
    const { base, log, served } = await serving();
    const server = createServer({ BRAINCHAIN_WATCH_URL: base.origin }, "0.0.0-test", { log: () => {} });
    const [mine, theirs] = InMemoryTransport.createLinkedPair();
    await server.connect(theirs);
    const client = new Client({ name: "test", version: "1" });
    const updated: string[] = [];
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, ({ params }) => void updated.push(params.uri));
    await client.connect(mine);
    expect((await client.listResources()).resources.map(({ uri }) => uri)).toEqual(["brainchain://changes"]);
    const read = JSON.parse((await client.readResource({ uri: "brainchain://changes" })).contents[0]!.text as string) as { events: { id: number }[] };
    expect(read.events.map(({ id }) => id)).toEqual([2, 3, 4]);
    await client.subscribeResource({ uri: "brainchain://changes" });
    for (let waited = 0; waited < 2_000; waited += 20) {
      served.publish(settled(log, [{ ...found("kucoin.listed", `kucoin-${waited}`), observedAt: "2026-11-19T13:00:00.000Z" }]));
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (updated.length) break;
    }
    expect(updated[0]).toBe("brainchain://changes");
    await client.unsubscribeResource({ uri: "brainchain://changes" });
    await expect(client.readResource({ uri: "brainchain://other" })).rejects.toThrow(/Unknown resource brainchain:\/\/other/);
    await client.close();
  });
});

describe("a client's address", () => {
  const request = (headers: Record<string, string>, remote = "10.0.0.1") => ({ headers, socket: { remoteAddress: remote } }) as unknown as Parameters<typeof clientOf>[0];

  it("comes from CF-Connecting-IP behind the proxy, then from the hop before the last, and from the socket otherwise", () => {
    expect(clientOf(request({ "cf-connecting-ip": "5.6.7.8", "x-forwarded-for": "1.1.1.1, 104.23.1.1" }), true)).toBe("5.6.7.8");
    expect(clientOf(request({ "x-forwarded-for": "spoofed, 5.6.7.8, 104.23.1.1" }), true)).toBe("5.6.7.8");
    expect(clientOf(request({ "x-forwarded-for": "5.6.7.8" }), true)).toBe("5.6.7.8");
    expect(clientOf(request({ "cf-connecting-ip": "not an address", "x-forwarded-for": "junk" }), true)).toBe("10.0.0.1");
    expect(clientOf(request({ "cf-connecting-ip": "5.6.7.8" }), false)).toBe("10.0.0.1");
  });

  it("is counted by its /64 for IPv6, which one client usually holds whole", () => {
    expect(keyOf("2001:db8:aa:bb:1::1")).toBe("2001:db8:aa:bb::/64");
    expect(keyOf("2001:db8:aa:bb:ffff:ffff:ffff:ffff")).toBe("2001:db8:aa:bb::/64");
    expect(keyOf("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect([keyOf("::ffff:5.6.7.8"), keyOf("5.6.7.8")]).toEqual(["5.6.7.8", "5.6.7.8"]);
  });
});

describe("the stream and health, read without a body", () => {
  it("answer HEAD at once, and show the full health only to the operator's token", async () => {
    const where = dir();
    const log = new EventLog(where);
    const served = serveEvents({ log, adminToken: "a".repeat(40), health: () => ({ ok: true, version: "x", events: { lastId: 0 }, sources: { chain: { failures: 0, baselined: true, lastError: "secret detail" } } }) });
    await new Promise<void>((resolve) => served.server.listen(0, "127.0.0.1", resolve));
    close = () => served.close();
    const base = new URL(`http://127.0.0.1:${(served.server.address() as AddressInfo).port}`);
    const head = await fetch(new URL("/events/stream", base), { method: "HEAD" });
    expect([head.status, head.headers.get("content-type")]).toEqual([200, "text/event-stream; charset=utf-8"]);
    expect(await (await fetch(new URL("/health", base))).json()).toEqual({ ok: true, events: { lastId: 0 }, sources: { chain: { reading: true, baselined: true } } });
    const full = (await (await fetch(new URL("/health", base), { headers: { Authorization: `Bearer ${"a".repeat(40)}` } })).json()) as Record<string, unknown>;
    expect(full.version).toBe("x");
    expect(await (await fetch(new URL("/health", base), { headers: { Authorization: `Bearer ${"b".repeat(40)}` } })).json()).not.toHaveProperty("version");
  });
});

describe("the watcher's GitHub token", () => {
  it("is read from the file GITHUB_TOKEN_FILE names when it is there, which puts each GitHub source on its one-minute interval", () => {
    const file = join(dir(), "watch-github.token");
    expect(githubToken({ GITHUB_TOKEN_FILE: file })).toEqual({ token: false, note: expect.stringMatching(/^GITHUB_TOKEN_FILE names a file that is not there yet/) });
    expect(githubEvery(false)).toBe(600_000);
    writeFileSync(file, "github_pat_0123456789abcdefghijklmnopqrstuvwxyz\n");
    expect(githubToken({ GITHUB_TOKEN_FILE: file })).toEqual({ token: true });
    expect(githubEvery(true)).toBe(60_000);
    writeFileSync(file, "not a token at all");
    expect(githubToken({ GITHUB_TOKEN_FILE: file })).toEqual({ token: false, note: expect.stringMatching(/^GITHUB_TOKEN is not a GitHub token.*Fix it and restart the watcher\.$/) });
    useGitHubToken(undefined);
  });
});

describe("calls", () => {
  const call = { grade: `0x${"ab".repeat(32)}`, payer: "0xFe4d9d7c5c530c9652A46D0BF6178b041Bc2F858", token: "0x020bfC650A365f8BB26819deAAbF3E21291018b4" } as never as IndexedCall;
  const later = { ...call, grade: `0x${"cd".repeat(32)}`, payer: "0x46e92cF98d3430b39d5de7c15695894590BBfBBe" };
  const all = [call, later];
  const calls = {
    of: (caller: string) => (caller.toLowerCase() === call.payer.toLowerCase() ? [call] : []),
    get: (grade: string) => (grade === call.grade ? call : undefined),
    page: (after: number, limit: number) => ({ calls: all.slice(after, after + limit), next: Math.min(all.length, after + limit), total: all.length }),
  };

  it("are served by the wallet that paid for them, and one by its grade", async () => {
    const { base } = await serving({ calls });
    const listed = await fetch(new URL(`/calls?caller=${call.payer.toLowerCase()}`, base));
    expect([listed.status, await listed.json()]).toEqual([200, { readAt: "2026-11-19T13:00:00.000Z", caller: call.payer.toLowerCase(), calls: [call] }]);
    expect(await (await fetch(new URL(`/calls/${call.grade}`, base))).json()).toEqual(call);
    expect((await fetch(new URL(`/calls/0x${"cd".repeat(32)}`, base))).status).toBe(404);
    expect(await (await fetch(new URL("/calls?caller=me", base))).json()).toEqual({ error: "caller must be the 0x address of the wallet that paid for the calls." });
    expect((await fetch(new URL("/calls", base), { method: "POST" })).status).toBe(405);
  });

  it("are served whole a page at a time, so the dataset reads every call without knowing who made them", async () => {
    const { base } = await serving({ calls });
    const first = await fetch(new URL("/calls?after=0&limit=1", base));
    expect([first.status, first.headers.get("access-control-allow-origin"), await first.json()]).toEqual([200, "*", { readAt: "2026-11-19T13:00:00.000Z", total: 2, after: 0, next: 1, more: true, calls: [call] }]);
    expect(await (await fetch(new URL("/calls?after=1", base))).json()).toMatchObject({ after: 1, next: 2, more: false, calls: [later] });
    expect(await (await fetch(new URL("/calls", base))).json()).toMatchObject({ after: 0, next: 2, more: false, calls: all });
    for (const query of ["after=-1", "after=x", "limit=0", "limit=1001"]) expect((await fetch(new URL(`/calls?${query}`, base))).status, query).toBe(400);
  });

  it("answer 404 on a watcher that does not read them", async () => {
    const { base } = await serving();
    expect((await fetch(new URL(`/calls?caller=${call.payer}`, base))).status).toBe(404);
  });
});
