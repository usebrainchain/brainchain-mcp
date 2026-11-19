import { mkdtempSync, readFileSync } from "node:fs";
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
import { watchArgs } from "./cli.js";
import { Deliveries } from "./deliver.js";
import { EventLog, type Found } from "./events.js";
import type { Post } from "./net.js";
import { eventsQuery, SERVE_LIMITS, serveEvents } from "./serve.js";

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

async function serving({ healthy = true, trustProxy = false, limits = SERVE_LIMITS, post = poster().post } = {}) {
  const where = dir();
  const log = new EventLog(where);
  settled(log, [{ ...found("bitgo.merged", "old"), observedAt: "2026-11-18T00:00:00.000Z", baseline: true }]);
  settled(log, [{ ...found("bitgo.pr_opened", "pr"), observedAt: "2026-11-19T10:00:00.000Z" }]);
  settled(log, [{ ...found("pool.created", "0xabc"), observedAt: "2026-11-19T11:00:00.000Z" }]);
  settled(log, [{ ...found("robinhood.pair_added", "pairs#PONS", { address: null, symbol: "PONS", name: "Pons" }), observedAt: "2026-11-19T12:00:00.000Z" }]);
  const deliveries = new Deliveries({ dir: where, log, post, check: async () => {} });
  const served = serveEvents({ log, health: () => ({ ok: healthy, sources: {} }), deliveries, trustProxy, limits, clock: () => Date.parse("2026-11-19T13:00:00Z") });
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
    expect(await post(base, { url: "https://hooks.example.com/6" })).toEqual({ status: 400, body: { error: "An address can have 5 watches at a time. Remove one first." } });
    expect((await post(base, { url: "https://hooks.example.com/7" })).status).toBe(429);
  });
});

describe("the watcher's HTTP surface", () => {
  it("holds each address to its requests a minute, telling it when to come back", async () => {
    const { base } = await serving({ limits: { ...SERVE_LIMITS, perMinute: 2 } });
    await fetch(new URL("/health/live", base));
    await fetch(new URL("/health/live", base));
    const refused = await fetch(new URL("/events", base));
    expect([refused.status, refused.headers.get("retry-after")]).toEqual([429, "60"]);
  });

  it("takes a client's address from the proxy's last X-Forwarded-For entry only when told to trust it", async () => {
    for (const [trustProxy, second] of [[true, 200], [false, 429]] as const) {
      const { base } = await serving({ trustProxy, limits: { ...SERVE_LIMITS, perMinute: 1 } });
      const from = (address: string) => fetch(new URL("/health/live", base), { headers: { "X-Forwarded-For": `1.2.3.4, ${address}` } }).then(({ status }) => status);
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
