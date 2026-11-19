import { mkdtempSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CHANGES_NAME, CHANGES_TOOL, changesQuery, readChanges, watchUrl } from "../changes.js";
import { callTool, type Desk } from "../tools.js";
import { watchArgs } from "./cli.js";
import { EventLog, type Found } from "./events.js";
import { eventsQuery, serveEvents } from "./serve.js";

const CASHCAT = "0x020bfC650A365f8BB26819deAAbF3E21291018b4";
const found = (kind: Found["kind"], ref: string, token: Found["token"] = { address: CASHCAT, symbol: "CASHCAT", name: "Cash Cat" }): Found => ({ kind, token, source: "x", ref, at: null, detail: {} });

let close: (() => void) | undefined;
afterEach(() => close?.());

async function serving(healthy = true) {
  const log = new EventLog(mkdtempSync(join(tmpdir(), "brainchain-watch-")));
  log.append([{ ...found("bitgo.merged", "old"), observedAt: "2026-11-18T00:00:00.000Z", baseline: true }]);
  log.append([{ ...found("bitgo.pr_opened", "pr"), observedAt: "2026-11-19T10:00:00.000Z" }]);
  log.append([{ ...found("pool.created", "0xabc"), observedAt: "2026-11-19T11:00:00.000Z" }]);
  log.append([{ ...found("robinhood.pair_added", "pairs#PONS", { address: null, symbol: "PONS", name: "Pons" }), observedAt: "2026-11-19T12:00:00.000Z" }]);
  const server = serveEvents(log, () => ({ ok: healthy, sources: {} }), () => Date.parse("2026-11-19T13:00:00Z"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  close = () => server.close();
  return new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
}

const get = async (url: URL | string) => {
  const response = await fetch(url);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

describe("GET /events", () => {
  it("serves the events after a cursor, filtered by kind and token, with where to go on from", async () => {
    const base = await serving();
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
    const base = await serving();
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
    expect((await get(new URL("/health", await serving(true)))).status).toBe(200);
    close?.();
    expect((await get(new URL("/health", await serving(false)))).status).toBe(503);
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
  it("says how to run the watcher when none is set", async () => {
    const result = await callTool(desk, CHANGES_NAME, {});
    expect(result.isError).toBe(false);
    expect(JSON.parse(text(result))).toEqual({
      watching: false,
      message: expect.stringContaining("Run `npx -y brainchain-mcp watch --serve 8787` on a machine that stays on, set BRAINCHAIN_WATCH_URL to http://127.0.0.1:8787"),
    });
  });

  it("returns a running watcher's events and the cursor for the next call", async () => {
    const base = await serving();
    const answer = (await readChanges(base, { since: "2", kinds: ["pool"], tokens: ["cashcat"] })) as Record<string, unknown>;
    expect(answer).toMatchObject({ watching: true, watcher: base.origin, next: 4, more: false });
    expect((answer.events as { kind: string }[]).map(({ kind }) => kind)).toEqual(["pool.created"]);
    const result = await callTool(desk, CHANGES_NAME, { since: 3 }, undefined, undefined, undefined, { changes: (query) => readChanges(base, query) });
    expect(JSON.parse(text(result))).toMatchObject({ events: [{ id: 4, kind: "robinhood.pair_added" }], next: 4 });
  });

  it("passes on what the watcher finds wrong with a query, and says when it cannot be reached", async () => {
    const base = await serving();
    await expect(readChanges(base, { since: "yesterday" })).rejects.toThrow(/^since must be an event id/);
    close?.();
    close = undefined;
    await expect(readChanges(base, {})).rejects.toThrow(`The watcher at ${base.origin} could not be reached.`);
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

  it("reads BRAINCHAIN_WATCH_URL as an http or https address", () => {
    expect(watchUrl(undefined)).toBeUndefined();
    expect(watchUrl(" http://127.0.0.1:8787 ")!.href).toBe("http://127.0.0.1:8787/");
    expect(() => watchUrl("localhost:8787")).toThrow("BRAINCHAIN_WATCH_URL must start with http:// or https://.");
    expect(() => watchUrl("not a url")).toThrow(/^BRAINCHAIN_WATCH_URL must be the address/);
    expect(() => watchUrl("https://user:secret@watch.example")).toThrow("BRAINCHAIN_WATCH_URL must not hold a user name or password.");
  });

  it("is in the README's tools, with the watcher it reads and what an event does not mean", () => {
    const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
    const row = readme.split("\n").find((line) => line.startsWith(`| \`${CHANGES_NAME}\` |`))!;
    expect(row).toContain("Reads the watcher `BRAINCHAIN_WATCH_URL` names; without it, the answer says how to start one. Free, no key.");
    const section = readme.split("\n## Watch public changes\n")[1]!.split("\n## ")[0]!;
    expect(section).toContain("none of them means an exchange will list the token: most tokens with these traces are never listed.");
    expect(section).toContain("reports none of it as new, so a new watcher starts quiet.");
    expect(section).not.toMatch(/\u2014|alpha|front-?run|insider/i);
  });

  it("describes changes in plain words and makes no forecast", () => {
    const description = CHANGES_TOOL.description!;
    expect(description).toMatch(/^New public changes about Robinhood Chain tokens since your last call/);
    expect(description).toContain("none of them means an exchange will list the token");
    for (const word of [/alpha/i, /front-?run/i, /insider/i, /\bleak/i, /signal/i, /score/i, /—/]) expect(description).not.toMatch(word);
  });
});

describe("the watch command's arguments", () => {
  it("take a state folder, a port or a host and port, and --print", () => {
    expect(watchArgs([])).toEqual({ print: false });
    expect(watchArgs(["--state", "/tmp/w", "--serve", "8787", "--print"])).toEqual({ state: "/tmp/w", serve: { host: "127.0.0.1", port: 8787 }, print: true });
    expect(watchArgs(["--serve", "0.0.0.0:9000"]).serve).toEqual({ host: "0.0.0.0", port: 9000 });
    expect(watchArgs(["--serve", "[::1]:9000"]).serve).toEqual({ host: "::1", port: 9000 });
    expect(() => watchArgs(["--serve", "99999"])).toThrow(/^--serve needs a port/);
    expect(() => watchArgs(["--state"])).toThrow("--state needs a folder.");
    expect(() => watchArgs(["--follow"])).toThrow("Unknown argument --follow.");
  });
});
