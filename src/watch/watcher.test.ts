import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EventLog, type Found, type WatchEvent } from "./events.js";
import { Backoff } from "./http.js";
import { lockStateDir, StateFile } from "./state.js";
import { MAX_WAIT_MS, Watcher, type Poller } from "./watcher.js";

const listed = (symbol: string): Found => ({ kind: "kucoin.listed", token: { address: null, symbol, name: null }, source: "KuCoin", ref: "kucoin", at: null, detail: {} });

/** A poller that reports what `lists` holds at each read, or throws what it holds. */
function scripted(lists: (Found[] | Error)[], name = "kucoin", interval = 60_000): Poller {
  let read = 0;
  return {
    name,
    interval,
    async poll(context) {
      const next = lists[Math.min(read++, lists.length - 1)]!;
      if (next instanceof Error) throw next;
      context.state.reads = read;
      await context.record(next);
    },
  };
}

function open(dir: string, pollers: Poller[], now = () => Date.parse("2026-11-19T12:00:00Z")) {
  const log = new EventLog(dir);
  const state = new StateFile(dir);
  const printed: WatchEvent[] = [];
  const said: string[] = [];
  const watcher = new Watcher({ log, state, pollers, context: async (found) => ({ about: found.token.symbol }), onEvent: (event) => printed.push(event), say: (line) => said.push(line), clock: now });
  return { log, state, watcher, printed, said };
}

const dir = () => mkdtempSync(join(tmpdir(), "brainchain-watch-"));

describe("the watcher", () => {
  it("keeps what is public at the first read as the baseline, and reports only what appears after it, with its context", async () => {
    const poller = scripted([[listed("CASHCAT"), listed("PONS")], [listed("CASHCAT"), listed("PONS"), listed("NEW")]]);
    const { log, watcher, printed, state } = open(dir(), [poller]);
    expect(await watcher.runOnce(poller)).toBe(60_000);
    expect(log.all().map(({ token, baseline }) => [token.symbol, baseline])).toEqual([["CASHCAT", true], ["PONS", true]]);
    expect(printed).toEqual([]);
    expect(state.source("kucoin").baselined).toBe(true);
    await watcher.runOnce(poller);
    await watcher.idle();
    expect(printed.map(({ id, token, context, baseline }) => [id, token.symbol, context, baseline])).toEqual([[3, "NEW", { about: "NEW" }, undefined]]);
    expect(log.query().events.map(({ id }) => id)).toEqual([3]);
  });

  it("records a find marked as baseline quietly, even after the baseline", async () => {
    const old = { ...listed("OLD"), baseline: true as const };
    const poller = scripted([[], [old, listed("NEW")]]);
    const { log, watcher, printed } = open(dir(), [poller]);
    await watcher.runOnce(poller);
    await watcher.runOnce(poller);
    await watcher.idle();
    expect(printed.map(({ token }) => token.symbol)).toEqual(["NEW"]);
    expect(log.all().map(({ token, baseline }) => [token.symbol, baseline === true])).toEqual([["OLD", true], ["NEW", false]]);
  });

  it("writes an event whose context failed with what failed, rather than holding it back", async () => {
    const poller = scripted([[], [listed("NEW")]]);
    const where = dir();
    const log = new EventLog(where);
    const watcher = new Watcher({ log, state: new StateFile(where), pollers: [poller], context: async () => Promise.reject(new Error("https://node.example/secret-key timed out")), say: () => {} });
    await watcher.runOnce(poller);
    await watcher.runOnce(poller);
    await watcher.idle();
    // Its own message can carry a node's address, so the event says only that.
    expect(log.all()[0]!.context).toEqual({ unread: ["The context could not be read."] });
  });

  it("never holds a poller on an event's context, and publishes the event once the context is read", async () => {
    let release!: () => void;
    const slow = new Promise<void>((resolve) => (release = resolve));
    const poller = scripted([[], [listed("NEW")]]);
    const where = dir();
    const log = new EventLog(where);
    const printed: WatchEvent[] = [];
    const watcher = new Watcher({ log, state: new StateFile(where), pollers: [poller], context: async () => (await slow, { worth: null }), onEvent: (event) => printed.push(event), say: () => {} });
    await watcher.runOnce(poller);
    expect(await watcher.runOnce(poller)).toBe(60_000);
    expect([log.size, log.publishedThrough, printed.length]).toEqual([1, 0, 0]);
    release();
    await watcher.idle();
    expect(printed.map(({ id, context }) => [id, context])).toEqual([[1, { worth: null }]]);
  });

  it("reads the context of events a restart left unread", async () => {
    const where = dir();
    const first = new EventLog(where);
    first.append([{ ...listed("LEFT"), observedAt: "2026-11-19T12:00:00Z" }]);
    first.close();
    const { watcher, printed, log } = open(where, []);
    watcher.start();
    await watcher.idle();
    await watcher.stop();
    expect([printed.map(({ token }) => token.symbol), log.publishedThrough]).toEqual([["LEFT"], 1]);
  });

  it("keeps a secret address out of what it logs and shows", async () => {
    const poller = scripted([new Error("HTTP request failed. URL: https://node.example/key-123 Details: node.example answered 429")]);
    const where = dir();
    const said: string[] = [];
    const watcher = new Watcher({ log: new EventLog(where), state: new StateFile(where), pollers: [poller], say: (line) => said.push(line), redact: (text) => text.replace(/(?:https:\/\/)?node\.example\S*/g, "the configured RPC") });
    await watcher.runOnce(poller);
    expect(watcher.status.get("kucoin")!.lastError).toBe("HTTP request failed. URL: the configured RPC Details: the configured RPC answered 429");
    expect(said.join(" ")).not.toContain("node.example");
  });

  it("waits until a refusal's time, and longer after each other failure, and keeps the baseline open until a read succeeds", async () => {
    let now = 1_000_000;
    const poller = scripted([new Backoff("GitHub said no", 1_000_000 + 600_000), new Error("bad answer"), new Error("bad answer"), [listed("A")]]);
    const { watcher, state, said, log } = open(dir(), [poller], () => now);
    expect(await watcher.runOnce(poller)).toBe(600_000);
    expect(said.at(-1)).toBe("kucoin: GitHub said no Next try in 600 s.");
    now += 600_000;
    expect(await watcher.runOnce(poller)).toBe(240_000);
    expect(await watcher.runOnce(poller)).toBe(480_000);
    expect(watcher.status.get("kucoin")).toMatchObject({ failures: 3, lastError: "bad answer", baselined: false });
    expect(state.source("kucoin").baselined).toBeUndefined();
    expect(await watcher.runOnce(poller)).toBe(60_000);
    expect(log.all()[0]!.baseline).toBe(true);
    expect(watcher.status.get("kucoin")).toMatchObject({ failures: 0, baselined: true });
  });

  it("never waits more than half an hour between tries", async () => {
    const poller = scripted([new Error("down")], "coingecko", 30 * 60_000);
    const { watcher } = open(dir(), [poller]);
    expect(await watcher.runOnce(poller)).toBe(MAX_WAIT_MS);
  });

  it("runs again at once when a poller has more to read", async () => {
    const poller: Poller = { name: "chain", interval: 15_000, poll: async () => true };
    expect(await open(dir(), [poller]).watcher.runOnce(poller)).toBe(0);
  });

  it("resumes after a restart from its state, and never reports again what it recorded before", async () => {
    const where = dir();
    const first = open(where, [scripted([[listed("A")]])]);
    await first.watcher.runOnce(scripted([[listed("A")]]));
    await first.watcher.runOnce(scripted([[listed("A"), listed("B")]]));
    first.log.close();
    const again = open(where, [scripted([[listed("A"), listed("B"), listed("C")]])]);
    expect(again.state.source("kucoin")).toMatchObject({ baselined: true, reads: 1 });
    await again.watcher.runOnce(scripted([[listed("A"), listed("B"), listed("C")]]));
    expect(again.printed.map(({ id, token }) => [id, token.symbol])).toEqual([[3, "C"]]);
  });

  it("runs every poller on its own interval until stopped, and saves the state on the way out", async () => {
    const where = dir();
    const reads: string[] = [];
    const quick = (name: string): Poller => ({ name, interval: 5, poll: async () => void reads.push(name) });
    const { watcher } = open(where, [quick("a"), quick("b")]);
    watcher.start();
    const runs = (name: string) => reads.filter((read) => read === name).length;
    for (let waited = 0; waited < 2_000 && (runs("a") < 2 || runs("b") < 2); waited += 10) await new Promise((resolve) => setTimeout(resolve, 10));
    await watcher.stop();
    const count = reads.length;
    expect(reads.filter((name) => name === "a").length).toBeGreaterThan(1);
    expect(reads.filter((name) => name === "b").length).toBeGreaterThan(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reads).toHaveLength(count);
    expect(new StateFile(where).source("a").baselined).toBe(true);
  });
});

describe("the state folder", () => {
  it("is held by one watcher at a time, and freed by a watcher that is gone", () => {
    const where = dir();
    // This test's process holds the lock, as another watcher would, and a second one on this host is refused.
    const release = lockStateDir(where);
    expect(() => lockStateDir(where, 1)).toThrow(/Another watcher \(process \d+\) is using/);
    release();
    lockStateDir(where)();
    // A lock taken on another host, as a container's disk after a redeploy, is stale.
    lockStateDir(where, process.pid, "old-container")();
    lockStateDir(where, process.pid, "old-container");
    let release2: () => void = () => {};
    expect(() => (release2 = lockStateDir(where, 2))).not.toThrow();
    // Pid 2 is a live process on Linux, so its lock is let go before the next.
    release2();
    // A lock left by a process that no longer runs is taken over, and so is one that names this process, as after a container restart.
    lockStateDir(where, 2 ** 22 + 12_345)();
    lockStateDir(where, 2 ** 22 + 12_345);
    expect(() => lockStateDir(where)).not.toThrow();
    expect(() => lockStateDir(where)).not.toThrow();
  });
});

describe("a refusal wrapped in another error", () => {
  it("still sets the wait", async () => {
    const wrapped = new Error("HTTP request failed.", { cause: new Error("fetch failed", { cause: new Backoff("rpc answered 429", 1_000_000 + 240_000) }) });
    const poller = scripted([wrapped], "chain", 15_000);
    const { watcher } = open(dir(), [poller], () => 1_000_000);
    expect(await watcher.runOnce(poller)).toBe(240_000);
  });
});
