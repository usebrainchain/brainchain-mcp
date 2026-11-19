import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { compact, Deliveries, formatOf, line, MAX_FAILURES, message, RETRY_MS } from "./deliver.js";
import { EventLog, KINDS, type Found, type WatchEvent } from "./events.js";
import { DeliveryError, type Post } from "./net.js";

const CASHCAT = "0x020bfC650A365f8BB26819deAAbF3E21291018b4";
const TX = `0x${"ab".repeat(32)}`;
const dir = () => mkdtempSync(join(tmpdir(), "brainchain-watch-"));

const event = (more: Partial<WatchEvent> = {}): WatchEvent => ({
  id: 7,
  kind: "bitgo.pr_opened",
  token: { address: CASHCAT, symbol: "CASHCAT", name: "Cash Cat" },
  source: "BitGo",
  ref: "https://github.com/BitGo/BitGoJS/pull/9357",
  at: "2026-07-27T09:28:36.000Z",
  observedAt: "2026-07-27T09:29:10.000Z",
  detail: { id: "hoodeth:cashcat", pr: 9357 },
  context: { worth: { marketCapUsd: "38251409.00", liquidityUsd: "1250000.00" } },
  ...more,
});

describe("a watch's format", () => {
  it("is the chat service its URL belongs to, or a plain webhook", () => {
    const of = (url: string) => formatOf(new URL(url));
    expect(of("https://discord.com/api/webhooks/123/abc-DEF_9")).toBe("discord");
    expect(of("https://discordapp.com/api/v10/webhooks/123/abc")).toBe("discord");
    expect(of("https://hooks.slack.com/services/T000/B000/XXXX")).toBe("slack");
    expect(of("https://api.telegram.org/bot123:AA-b_c/sendMessage?chat_id=-100123")).toBe("telegram");
    expect(of("https://api.telegram.org/bot123:AA/sendMessage?chat_id=@brainchain_ops")).toBe("telegram");
    expect(() => of("https://api.telegram.org/bot123:AA/sendMessage")).toThrow(DeliveryError);
    expect(of("https://discord.com/channels/1/2")).toBe("webhook");
    expect(of("https://hooks.example.com/brainchain")).toBe("webhook");
  });
});

describe("a chat message", () => {
  it("is one line: what changed, the token, its worth now and the link", () => {
    expect(line(event())).toBe("A pull request in BitGo's code adds Cash Cat CASHCAT (0x020b…18b4) to its Robinhood Chain tokens. Worth $38.3M now, $1.3M in its deepest pool. https://github.com/BitGo/BitGoJS/pull/9357");
    expect(line(event({ kind: "pool.created", source: "Uniswap v4", ref: TX, detail: { pairedWith: "ETH" }, context: {} }))).toBe(`New Uniswap v4 pool for Cash Cat CASHCAT (0x020b…18b4), paired with ETH. https://robinhoodchain.blockscout.com/tx/${TX}`);
    expect(line(event({ kind: "robinhood.tradability_changed", token: { address: null, symbol: "PONS", name: "Pons" }, ref: "https://nummus.robinhood.com/currency_pairs/#PONS@2026-11-19T12:00:00Z", detail: { tradable: true }, context: { worth: null } }))).toBe(
      "Robinhood's Pons PONS pair is tradable now. https://nummus.robinhood.com/currency_pairs/#PONS",
    );
  });

  it("names the pair's other side when it is ETH, WETH or USDG", () => {
    expect(line(event({ kind: "pool.created", source: "Uniswap v4", ref: TX, detail: { pairedWith: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" }, context: {} }))).toContain("paired with USDG.");
    expect(line(event({ kind: "pool.created", source: "Uniswap v3", ref: TX, detail: { pairedWith: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" }, context: {} }))).toContain("paired with WETH.");
  });

  it("has words for every kind, none of them banned", () => {
    for (const kind of KINDS) {
      const text = line(event({ kind, detail: { pairedWith: "ETH", maker: { name: "Wintermute" }, version: "59.1.0", tradable: true, confirmed: true } }));
      expect(text, kind).not.toMatch(/alpha|front-?run|insider|will list|forecast|signal|—/i);
    }
  });

  it("writes a dollar figure short", () => {
    expect([compact("38251409.00"), compact("1250000"), compact("950.5"), compact("1200000000"), compact("0.5")]).toEqual(["$38.3M", "$1.3M", "$951", "$1.2B", "$0.5000"]);
  });
});

describe("a delivery", () => {
  const watch = { id: "w".repeat(22), secret: "s".repeat(43), url: "https://hooks.example.com/x" };

  it("to a plain webhook is the event, signed over the timestamp and the body", () => {
    const { body, headers } = message({ ...watch, format: "webhook" }, event(), 1_795_000_000_000);
    expect(JSON.parse(body)).toEqual(event());
    expect(headers["X-BrainChain-Timestamp"]).toBe("1795000000");
    expect(headers["X-BrainChain-Signature"]).toBe(`v1=${createHmac("sha256", watch.secret).update(`1795000000.${body}`).digest("hex")}`);
    expect([headers["X-BrainChain-Watch"], headers["X-BrainChain-Event"]]).toEqual([watch.id, "7"]);
  });

  it("to a chat service is its own message shape, with no pings and no previews, and no signature", () => {
    const discord = message({ ...watch, format: "discord" }, event(), 0);
    expect(JSON.parse(discord.body)).toEqual({ content: line(event()), allowed_mentions: { parse: [] }, flags: 4 });
    expect(discord.headers["X-BrainChain-Signature"]).toBeUndefined();
    expect(JSON.parse(message({ ...watch, format: "slack" }, event({ token: { address: null, symbol: "A<B", name: null } }), 0).body).text).toContain("A&lt;B");
    expect(JSON.parse(message({ ...watch, format: "telegram", url: "https://api.telegram.org/bot1:a/sendMessage?chat_id=-1001" }, event(), 0).body)).toEqual({ chat_id: "-1001", text: line(event()), link_preview_options: { is_disabled: true } });
  });
});

const found = (kind: Found["kind"], ref: string): Found => ({ kind, token: { address: CASHCAT, symbol: "CASHCAT", name: "Cash Cat" }, source: "x", ref, at: null, detail: {} });

function harness(post: Post, now = { at: 1_000_000 }) {
  const where = dir();
  const log = new EventLog(where);
  const said: string[] = [];
  const deliveries = new Deliveries({ dir: where, log, post, clock: () => now.at, say: (text) => said.push(text), limits: { perOwner: 2, total: 3 } });
  const publish = (...rows: Found[]) => {
    const { written } = log.append(rows.map((row) => ({ ...row, observedAt: "2026-11-19T12:00:00Z" })));
    for (const one of written) log.settle(one.id, {});
  };
  return { where, log, deliveries, publish, said, now };
}

describe("deliveries", () => {
  it("send each matching event once, in order, from the one after the watch was made", async () => {
    const sent: number[] = [];
    const { deliveries, publish } = harness(async (_url, body) => (sent.push(JSON.parse(body).id), { status: 200, body: "" }));
    publish(found("bitgo.merged", "before"));
    const { from } = await deliveries.create({ url: "https://hooks.example.com/x", kinds: ["bitgo"] }, "1.2.3.4");
    expect(from).toBe(1);
    publish(found("pool.created", "p1"), found("bitgo.pr_opened", "pr"), found("bitgo.merged", "m"));
    await deliveries.tick();
    await deliveries.tick();
    expect(sent).toEqual([3, 4]);
  });

  it("try a failing endpoint again after each wait, then switch the watch off and say why", async () => {
    let status = 500;
    const { deliveries, publish, now, said } = harness(async () => ({ status, body: "upstream says: the admin password is hunter2" }));
    const { id, manageToken } = await deliveries.create({ url: "https://hooks.example.com/x" }, "1.2.3.4");
    publish(found("bitgo.merged", "m"));
    await deliveries.tick();
    // Only the status: what the endpoint answered is never shown, so a watch cannot be used to read it.
    expect(deliveries.status(id, manageToken)).toMatchObject({ failures: 1, lastError: "The endpoint answered 500.", retryAt: new Date(1_000_000 + RETRY_MS[0]!).toISOString() });
    // Nothing is sent before the wait is over.
    await deliveries.tick();
    expect(deliveries.status(id, manageToken)).toMatchObject({ failures: 1 });
    for (let tries = 2; tries <= MAX_FAILURES; tries++) {
      now.at += 2 * 60 * 60_000;
      await deliveries.tick();
    }
    const off = deliveries.status(id, manageToken)!;
    expect(off.off).toEqual({ at: expect.any(String), reason: `Switched off after ${MAX_FAILURES} failed tries in a row on event 1; the last: The endpoint answered 500. Make a new watch to start again.` });
    expect(said).toEqual([`watch ${id} switched off after ${MAX_FAILURES} failed tries.`]);
    status = 200;
    now.at += 2 * 60 * 60_000;
    await deliveries.tick();
    expect(deliveries.status(id, manageToken)).toMatchObject({ delivered: 0 });
  });

  it("recover from a failure, and keep their place across a restart", async () => {
    let fail = true;
    const sent: number[] = [];
    const first = harness(async (_url, body) => {
      if (fail) throw new DeliveryError("hooks.example.com could not be reached.");
      sent.push(JSON.parse(body).id);
      return { status: 204, body: "" };
    });
    const { id, manageToken } = await first.deliveries.create({ url: "https://hooks.example.com/x" }, "1.2.3.4");
    first.publish(found("bitgo.merged", "a"), found("bitgo.merged", "b"));
    await first.deliveries.tick();
    expect(first.deliveries.status(id, manageToken)).toMatchObject({ failures: 1, lastError: "hooks.example.com could not be reached.", cursor: 0 });
    fail = false;
    first.now.at += RETRY_MS[0]!;
    await first.deliveries.tick();
    expect([sent, first.deliveries.status(id, manageToken)]).toEqual([[1, 2], expect.objectContaining({ failures: 0, delivered: 2, cursor: 2 })]);
    first.log.close();
    const again = new Deliveries({ dir: first.where, log: new EventLog(first.where), post: async () => ({ status: 204, body: "" }) });
    expect(again.status(id, manageToken)).toMatchObject({ cursor: 2, delivered: 2 });
    expect(readFileSync(join(first.where, "watches.json"), "utf8")).not.toContain(manageToken);
  });

  it("hold each address and the watcher to their caps, and answer the same for a wrong token and no watch", async () => {
    const { deliveries } = harness(async () => ({ status: 200, body: "" }));
    const one = await deliveries.create({ url: "https://hooks.example.com/1" }, "1.2.3.4");
    await deliveries.create({ url: "https://hooks.example.com/2" }, "1.2.3.4");
    await expect(deliveries.create({ url: "https://hooks.example.com/3" }, "1.2.3.4")).rejects.toThrow("An address can have 2 watches at a time, switched-off ones included until they are removed. Remove one first.");
    await deliveries.create({ url: "https://hooks.example.com/3" }, "5.6.7.8");
    await expect(deliveries.create({ url: "https://hooks.example.com/4" }, "9.9.9.9")).rejects.toThrow("The watcher holds as many watches as it takes. Try again later.");
    expect([deliveries.status(one.id, "wrong"), deliveries.remove("nope", one.manageToken), deliveries.remove(one.id, "wrong")]).toEqual([undefined, false, false]);
    expect(deliveries.remove(one.id, one.manageToken)).toBe(true);
  });

  it("count a switched-off watch toward its owner's cap until it is removed or a week has passed", async () => {
    const { deliveries, publish, now } = harness(async () => ({ status: 500, body: "" }));
    const failing = await deliveries.create({ url: "https://hooks.example.com/1" }, "1.2.3.4");
    await deliveries.create({ url: "https://hooks.example.com/2" }, "1.2.3.4");
    publish(found("bitgo.merged", "m"));
    for (let tries = 0; tries < MAX_FAILURES; tries++) {
      await deliveries.tick();
      now.at += 2 * 60 * 60_000;
    }
    expect(deliveries.status(failing.id, failing.manageToken)!.off).toBeDefined();
    await expect(deliveries.create({ url: "https://hooks.example.com/3" }, "1.2.3.4")).rejects.toThrow(/switched-off ones included/);
    now.at += 8 * 24 * 60 * 60_000;
    await deliveries.tick();
    expect(deliveries.status(failing.id, failing.manageToken)).toBeUndefined();
    expect((await deliveries.create({ url: "https://hooks.example.com/3" }, "1.2.3.4")).format).toBe("webhook");
  });
});

describe("a token's name in a chat", () => {
  it("is left out when it reads as a link or a handle, so nobody can post one through our bot", () => {
    for (const name of ["claim at evil.xyz", "https://evil", "www.claim", "join t.me/x", "@everyone", "discord.gg/abc"]) {
      const text = line(event({ token: { address: CASHCAT, symbol: "EVIL", name }, context: {} }));
      expect(text, name).not.toContain(name);
      expect(text).toContain("EVIL (0x020b…18b4)");
    }
    expect(line(event({ token: { address: null, symbol: "free.money", name: null }, context: {} }))).toContain("a token named like a link");
  });
});
