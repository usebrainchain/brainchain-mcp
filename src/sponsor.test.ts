import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";

import { FREE } from "./free.js";
import { canonicalStringify, orderIdOf } from "./payments.js";
import { createSponsor, freeCaps, PAUSE_MS, sponsorConfig, sponsorFrom, type Caps, type Sponsor } from "./sponsor.js";
import { EventLog } from "./watch/events.js";
import { FREE_BODY, SERVE_LIMITS, serveEvents, type ServeLimits } from "./watch/serve.js";

// Anvil's second default account: a public test key that holds nothing anywhere.
const KEY = "59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const signer = privateKeyToAccount(`0x${KEY}`);
const CLIENT = "Ov23liAbCdEfGhIjKlMn";
const TOKEN = "gho_16C7e42F292c6912E7710c838347Ae178B4a";
const NOW = Date.parse("2026-12-09T08:01:00Z");
const MINUTE = 60_000;
const OLD = "2015-03-01T10:00:00Z";
const request = { brief: "Sort 3, 1 and 2.", result: "1, 2, 3" };
const dir = () => mkdtempSync(join(tmpdir(), "brainchain-free-"));
const hashOf = (sent: object) => createHash("sha256").update(canonicalStringify(sent)).digest("hex");

interface User {
  id: number;
  login: string;
  created_at: string;
  /** The OAuth app GitHub names for the token: BrainChain's by default, another's, or none for a personal token. */
  app?: string | null;
}

interface Fakes {
  users?: Record<string, User>;
  paid?: (payment: { payload: unknown }, views: Map<string, Record<string, unknown>>) => Response;
}

/**
 * GitHub's /user for the tokens in `users`, and a desk that offers USDC on Base, answers each paid grade with `paid`,
 * and reads back each grade it keeps in `views`.
 */
function fakes(config: ReturnType<typeof sponsorConfig>, { users = { [TOKEN]: { id: 583231, login: "octocat", created_at: OLD } }, paid }: Fakes = {}) {
  const payments: { payload: unknown }[] = [];
  const github: string[] = [];
  const views = new Map<string, Record<string, unknown>>();
  const grades = `${config.desk}/x402/grades`;
  const accepts = [{ scheme: "exact", network: config.network, amount: "250000", asset: config.asset, payTo: config.payTo, maxTimeoutSeconds: 300, extra: { name: "USDC", version: "2" } }];
  const challenge = Buffer.from(JSON.stringify({ x402Version: 2, error: "Payment required", resource: { url: grades, mimeType: "application/json" }, accepts })).toString("base64");
  const graded = (payment: { payload: unknown }) => {
    const view = { grade: orderIdOf(payment), state: "graded", accepted: true, answer: "accept", passProbability: 0.93, bar: 0.8 };
    views.set(view.grade, view);
    return Response.json(view);
  };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    if (req.url === "https://api.github.com/user") {
      const token = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "")?.[1] ?? "";
      github.push(token);
      const user = users[token];
      if (!user) return Response.json({ message: "Bad credentials" }, { status: 401 });
      const { app = CLIENT, ...profile } = user;
      return Response.json(profile, { headers: app === null ? {} : { "x-oauth-client-id": app } });
    }
    if (req.method === "GET" && req.url.startsWith(`${grades}/`)) {
      const view = views.get(req.url.slice(grades.length + 1));
      return view ? Response.json(view) : Response.json({ error: "Not found." }, { status: 404 });
    }
    if (req.url !== grades) return new Response("{}", { status: 404 });
    const header = req.headers.get("payment-signature");
    if (!header) return new Response("{}", { status: 402, headers: { "payment-required": challenge } });
    const payment = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { payload: unknown };
    payments.push(payment);
    return paid ? paid(payment, views) : graded(payment);
  }) as typeof fetch;
  return { fetchImpl, payments, github, views };
}

function sponsor(options: Fakes & { where?: string; now?: () => number; caps?: Caps } = {}) {
  const where = options.where ?? dir();
  const config = sponsorConfig("mainnet", where, options.caps);
  const fake = fakes(config, options);
  const logged: string[] = [];
  const made = createSponsor({ config, signer, clientId: CLIENT, dir: where, ...(options.caps ? { caps: options.caps } : {}), fetch: fake.fetchImpl, now: options.now ?? (() => NOW), say: (line) => logged.push(line) });
  return { sponsor: made, where, logged, ...fake };
}

const nth = (n: number) => ({ ...request, result: `${request.result} (${n})` });
const counts = (where: string) => JSON.parse(readFileSync(join(where, "free-checks.json"), "utf8")) as { total: number; grades: Record<string, unknown>[] };
/** What the sponsor's wallet holds against its daily limit, in base units. */
const heldToday = (where: string) => JSON.parse(readFileSync(join(where, `spend-mainnet-${signer.address.toLowerCase()}.json`), "utf8")).units as string;
/** A desk that takes the payment and answers with the grade in `state`, which it then reads back until changed. */
const settling = (state: string) => (payment: { payload: unknown }, views: Map<string, Record<string, unknown>>) => {
  const view = { grade: orderIdOf(payment), state };
  views.set(view.grade, view);
  return Response.json(view);
};

describe("free checks", () => {
  it("pay the grade route the usual price in USDC on Base, twice per GitHub account, then refuse with what to do", async () => {
    const { sponsor: s, payments } = sponsor();
    const first = await s.grade(TOKEN, nth(1), "mainnet");
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ state: "graded", accepted: true, price: "0.25 USDC", free: { used: 1, left: 1 }, done: true });
    expect(first.body.grade).toBe(orderIdOf(payments[0]!));
    expect(first.body.statusUrl).toBe(`https://brain.usebrainchain.com/x402/grades/${first.body.grade}`);
    const authorization = (payments[0]!.payload as { authorization: { from: string; to: string; value: string } }).authorization;
    expect(authorization).toMatchObject({ from: signer.address, to: "0x97D558417c3D61f1074422AD843e1Db1E565b952", value: "250000" });

    expect((await s.grade(TOKEN, nth(2), "mainnet")).body).toMatchObject({ free: { used: 2, left: 0 } });
    const third = await s.grade(TOKEN, nth(3), "mainnet");
    expect(third).toEqual({ status: 403, body: { reason: "used", error: "@octocat has used its 2 free checks." } });
    expect(payments).toHaveLength(2);
  });

  it("keep each account's id, its counts and its grades' ids with a hash of the request, never the sign-in or the request", async () => {
    const { sponsor: s, where, payments } = sponsor();
    await s.grade(TOKEN, nth(1), "mainnet");
    expect(counts(where)).toEqual({ accounts: { "583231": 1 }, days: { "2026-12-09": 1 }, total: 1, grades: [{ account: "583231", hash: hashOf(nth(1)), grade: orderIdOf(payments[0]!), at: NOW, graded: true }] });
    for (const file of readdirSync(where)) {
      const text = readFileSync(join(where, file), "utf8");
      for (const kept of [TOKEN, "octocat", request.brief]) expect(text).not.toContain(kept);
    }
  });

  it("go on from the counts on disk after a restart", async () => {
    const where = dir();
    await sponsor({ where }).sponsor.grade(TOKEN, nth(1), "mainnet");
    await sponsor({ where }).sponsor.grade(TOKEN, nth(2), "mainnet");
    expect((await sponsor({ where }).sponsor.grade(TOKEN, nth(3), "mainnet")).body.reason).toBe("used");
  });

  it("refuse accounts younger than 30 days, and say when the account was made and when it qualifies", async () => {
    const created = new Date(NOW - 29 * 86_400_000).toISOString();
    const { sponsor: s, payments } = sponsor({ users: { [TOKEN]: { id: 9, login: "fresh", created_at: created } } });
    expect(await s.grade(TOKEN, request, "mainnet")).toEqual({ status: 403, body: { reason: "young", error: "Free checks are for GitHub accounts older than 30 days. @fresh was created on 2026-11-10, so it qualifies on 2026-12-10." } });
    expect((await s.me(TOKEN)).body).toMatchObject({ login: "fresh", left: 0, reason: "young" });
    expect(payments).toHaveLength(0);
  });

  it("stop at 60 a day, open again the next UTC day, and pause rather than pass the wallet's own daily limit", async () => {
    const users = Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`gho_${String(i).padStart(36, "0")}`, { id: 1000 + i, login: `u${i}`, created_at: OLD }]));
    let now = NOW;
    const { sponsor: s, payments } = sponsor({ users, now: () => now });
    const tokens = Object.keys(users);
    for (const [i, token] of tokens.slice(0, 30).entries()) for (const n of [1, 2]) expect((await s.grade(token, nth(10 * i + n), "mainnet")).status).toBe(200);
    expect(await s.grade(tokens[30]!, nth(1000), "mainnet")).toEqual({ status: 429, body: { reason: "daily", error: "Today's 60 free checks are all taken. More open at 00:00 UTC." } });
    now += 86_400_000;
    expect((await s.me(tokens[30]!)).body).toEqual({ login: "u30", left: 2 });
    // The wallet's own daily limit, kept on the real clock, still holds 15 USDC for today: a fault in the counts cannot spend more.
    expect(await s.grade(tokens[30]!, nth(1000), "mainnet")).toEqual({ status: 503, body: { reason: "paused", error: "BrainChain's free checks are paused. Try again later." } });
    expect(payments).toHaveLength(FREE.perDay);
    expect((await s.me(tokens[30]!)).body).toMatchObject({ left: 2 });
  });

  it("stop for good once 250 are given out", async () => {
    const where = dir();
    writeFileSync(join(where, "free-checks.json"), JSON.stringify({ accounts: {}, days: {}, total: FREE.total }));
    const { sponsor: s, payments } = sponsor({ where });
    expect(await s.grade(TOKEN, request, "mainnet")).toEqual({ status: 403, body: { reason: "total", error: "All of BrainChain's free checks have been given out." } });
    expect(s.info()).toMatchObject({ open: false });
    expect(payments).toHaveLength(0);
  });

  it("give the last check to one of two requests sent at once", async () => {
    const { sponsor: s, payments } = sponsor();
    await s.grade(TOKEN, nth(1), "mainnet");
    const both = await Promise.all([s.grade(TOKEN, nth(2), "mainnet"), s.grade(TOKEN, nth(3), "mainnet")]);
    expect(both.map(({ status }) => status).sort()).toEqual([200, 403]);
    expect(payments).toHaveLength(2);
  });

  it("count nothing for a payment that did not go through, and answer a repeat from the first grade without paying", async () => {
    let state = "failed";
    const { sponsor: s, payments } = sponsor({ paid: (payment, views) => settling(state)(payment, views) });
    expect((await s.grade(TOKEN, nth(1), "mainnet")).body).toMatchObject({ state: "failed", free: { used: 0, left: 2 } });
    state = "graded";
    expect((await s.grade(TOKEN, nth(2), "mainnet")).body).toMatchObject({ free: { used: 1, left: 1 } });
    expect((await s.grade(TOKEN, nth(2), "mainnet")).body).toMatchObject({ state: "graded", duplicate: true, free: { used: 1, left: 1 } });
    expect(payments).toHaveLength(2);
  });

  it("pause when the wallet cannot pay, give the check back, and open again after the pause", async () => {
    let now = NOW;
    const { sponsor: s, logged, payments } = sponsor({ now: () => now, paid: () => Response.json({ error: "insufficient_funds" }, { status: 402 }) });
    expect(await s.grade(TOKEN, nth(1), "mainnet")).toEqual({ status: 503, body: { reason: "paused", error: "BrainChain's free checks are paused. Try again later." } });
    expect((await s.me(TOKEN)).body).toEqual({ login: "octocat", left: 2, reason: "paused", error: "BrainChain's free checks are paused. Try again later." });
    expect(s.info()).toMatchObject({ open: false, paused: true });
    expect((await s.grade(TOKEN, nth(2), "mainnet")).body.reason).toBe("paused");
    expect(payments).toHaveLength(1);
    expect(logged.join("\n")).toMatch(/a grade was not paid/);
    now += PAUSE_MS;
    expect(s.info()).toMatchObject({ open: true, paused: false });
  });

  it("answer 503 without pausing when the desk turns one grade away", async () => {
    const { sponsor: s } = sponsor({ paid: () => Response.json({ error: "bad request" }, { status: 400 }) });
    expect((await s.grade(TOKEN, request, "mainnet")).body).toEqual({ reason: "unavailable", error: "The free check could not be paid just now, and none was used. Try again in a few minutes." });
    expect(s.info()).toMatchObject({ open: true, paused: false });
  });

  it("ask for a sign-in, a working one, the same network and a grade the desk would take, before anything is paid", async () => {
    const { sponsor: s, payments } = sponsor();
    expect((await s.grade(undefined, request, "mainnet")).body).toEqual({ reason: "login", error: "Sign in with GitHub first: run `npx -y brainchain-mcp login` in a terminal." });
    expect(await s.grade("gho_revokedrevokedrevokedrevoked0000", request, "mainnet")).toEqual({ status: 401, body: { reason: "login", error: "Your GitHub sign-in has expired or was revoked. Run `npx -y brainchain-mcp login` again." } });
    expect((await s.grade(TOKEN, request, "testnet")).status).toBe(409);
    expect((await s.grade(TOKEN, { ...request, extra: 1 }, "mainnet")).body).toMatchObject({ reason: "request", error: expect.stringContaining("extra") });
    expect((await s.grade(TOKEN, { brief: "x" }, "mainnet")).body).toEqual({ reason: "request", error: "result is required." });
    expect(payments).toHaveLength(0);
  });

  it("take only sign-ins made with BrainChain's GitHub app, and refuse personal tokens", async () => {
    const other = "gho_otherappotherappotherappotherapp00";
    const personal = "github_pat_11AAAAAAA0personalpersonal";
    const { sponsor: s, payments } = sponsor({
      users: { [other]: { id: 7, login: "elsewhere", created_at: OLD, app: "Iv1.someoneelse00" }, [personal]: { id: 8, login: "pat", created_at: OLD, app: null } },
    });
    const refused = { status: 401, body: { reason: "login", error: "That GitHub sign-in was not made through brainchain-mcp login. Run `npx -y brainchain-mcp login` to sign in, then try again." } };
    expect(await s.grade(other, request, "mainnet")).toEqual(refused);
    expect(await s.grade(personal, request, "mainnet")).toEqual(refused);
    expect(await s.me(personal)).toEqual(refused);
    expect(payments).toHaveLength(0);
  });

  it("say who is signed in and what is left, using no check", async () => {
    const { sponsor: s, payments } = sponsor();
    expect(await s.me(TOKEN)).toEqual({ status: 200, body: { login: "octocat", left: 2 } });
    expect(s.info()).toEqual({ network: "mainnet", chain: "Base", clientId: CLIENT, ...FREE, open: true, paused: false });
    expect(payments).toHaveLength(0);
  });

  it("pay exactly a grade's price, within a budget and a daily limit no larger than the checks", () => {
    const config = sponsorConfig(undefined, dir());
    expect(config).toMatchObject({ name: "mainnet", payOn: "base", chain: "Base", token: "USDC", maxPrice: 250_000n, budget: 62_500_000n, daily: 15_000_000n });
    expect(sponsorConfig("testnet", dir())).toMatchObject({ name: "testnet", chain: "Base Sepolia", desk: "https://brain.testnet.usebrainchain.com" });
  });
});

describe("a free check the desk has not settled", () => {
  it("stays used while the desk settles it, closes once graded, and comes back with the wallet's hold if the desk fails it", async () => {
    const { sponsor: s, where, views, payments } = sponsor({ paid: settling("unconfirmed") });
    expect((await s.grade(TOKEN, nth(1), "mainnet")).body).toMatchObject({ state: "unconfirmed", free: { used: 1, left: 1 } });
    const first = orderIdOf(payments[0]!);
    expect(counts(where).grades).toEqual([{ account: "583231", hash: hashOf(nth(1)), grade: first, at: NOW }]);
    expect(heldToday(where)).toBe("250000");
    expect((await s.me(TOKEN)).body).toEqual({ login: "octocat", left: 1 });

    views.set(first, { grade: first, state: "failed" });
    expect((await s.me(TOKEN)).body).toEqual({ login: "octocat", left: 2 });
    expect(counts(where)).toMatchObject({ total: 0, grades: [] });
    expect(heldToday(where)).toBe("0");

    await s.grade(TOKEN, nth(2), "mainnet");
    const second = orderIdOf(payments[1]!);
    views.set(second, { grade: second, state: "graded", accepted: true });
    expect((await s.me(TOKEN)).body).toEqual({ login: "octocat", left: 1 });
    expect(counts(where).grades).toEqual([{ account: "583231", hash: hashOf(nth(2)), grade: second, at: NOW, graded: true }]);
    expect(heldToday(where)).toBe("250000");
  });

  it("comes back when the desk still has no record of it 15 minutes after it was taken", async () => {
    const where = dir();
    const { sponsor: s } = sponsor({ where, paid: () => new Response("upstream", { status: 500 }) });
    expect((await s.grade(TOKEN, request, "mainnet")).body).toMatchObject({ possiblyCharged: true, free: { used: 1, left: 1 } });
    expect((await sponsor({ where, now: () => NOW + 14 * MINUTE }).sponsor.me(TOKEN)).body).toMatchObject({ left: 1 });
    expect((await sponsor({ where, now: () => NOW + 15 * MINUTE }).sponsor.me(TOKEN)).body).toMatchObject({ left: 2 });
    expect(counts(where)).toMatchObject({ total: 0, grades: [] });
  });

  it("comes back 15 minutes on when the watcher stopped between taking it and signing", async () => {
    const where = dir();
    const grades = [
      { account: "583231", hash: "a".repeat(64), at: NOW - 16 * MINUTE },
      { account: "583231", hash: "b".repeat(64), at: NOW - 5 * MINUTE },
    ];
    writeFileSync(join(where, "free-checks.json"), JSON.stringify({ accounts: { "583231": 2 }, days: { "2026-12-09": 2 }, total: 2, grades }));
    const { sponsor: s } = sponsor({ where });
    expect((await s.me(TOKEN)).body).toEqual({ login: "octocat", left: 1 });
    expect(counts(where)).toEqual({ accounts: { "583231": 1 }, days: { "2026-12-09": 1 }, total: 1, grades: [grades[1]] });
  });

  it("answers a repeat from its entry without signing again, while it settles, once graded and after a restart", async () => {
    const where = dir();
    const { sponsor: s, views, payments } = sponsor({ where, paid: settling("unconfirmed") });
    const first = await s.grade(TOKEN, request, "mainnet");
    const again = await s.grade(TOKEN, request, "mainnet");
    expect(again).toEqual({ status: 200, body: expect.objectContaining({ grade: first.body.grade, state: "unconfirmed", duplicate: true, free: { used: 1, left: 1 } }) });
    views.set(String(first.body.grade), { grade: first.body.grade, state: "graded", accepted: true });
    expect((await s.grade(TOKEN, request, "mainnet")).body).toMatchObject({ grade: first.body.grade, state: "graded", accepted: true, duplicate: true, done: true });
    const restarted = sponsor({ where });
    restarted.views.set(String(first.body.grade), { grade: first.body.grade, state: "graded", accepted: true });
    expect((await restarted.sponsor.grade(TOKEN, request, "mainnet")).body).toMatchObject({ grade: first.body.grade, state: "graded", duplicate: true, free: { used: 1, left: 1 } });
    expect([...payments, ...restarted.payments]).toHaveLength(1);
  });

  it("answers another account's exact work with that grade, using none of this account's checks, whether it has any left or not", async () => {
    const OTHER = "gho_secondsecondsecondsecondsecond0000";
    const { sponsor: s, payments } = sponsor({ users: { [TOKEN]: { id: 583231, login: "octocat", created_at: OLD }, [OTHER]: { id: 9, login: "hubot", created_at: OLD } } });
    const first = await s.grade(TOKEN, request, "mainnet");
    const theirs = { grade: first.body.grade, state: "graded", duplicate: true };
    expect((await s.grade(OTHER, request, "mainnet")).body).toMatchObject({ ...theirs, free: { used: 0, left: 2, alreadyGraded: true } });
    await s.grade(OTHER, nth(1), "mainnet");
    await s.grade(OTHER, nth(2), "mainnet");
    expect(await s.grade(OTHER, request, "mainnet")).toEqual({ status: 200, body: expect.objectContaining({ ...theirs, free: { used: 2, left: 0, alreadyGraded: true } }) });
    expect((await s.grade(TOKEN, request, "mainnet")).body.free).toEqual({ used: 1, left: 1 });
    expect(payments).toHaveLength(3);
  });

  it("pays once when two accounts send the same work at once, and gives the second its check back", async () => {
    const OTHER = "gho_secondsecondsecondsecondsecond0000";
    const { sponsor: s, where, payments } = sponsor({ users: { [TOKEN]: { id: 583231, login: "octocat", created_at: OLD }, [OTHER]: { id: 9, login: "hubot", created_at: OLD } } });
    const both = await Promise.all([s.grade(TOKEN, request, "mainnet"), s.grade(OTHER, request, "mainnet")]);
    expect(both.map(({ body }) => body.grade)).toEqual([both[0]!.body.grade, both[0]!.body.grade]);
    expect(both.map(({ body }) => body.free).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))).toEqual([{ used: 0, left: 2, alreadyGraded: true }, { used: 1, left: 1 }]);
    expect(counts(where)).toMatchObject({ total: 1 });
    expect(payments).toHaveLength(1);
  });

  it("refuses a grade that carries a credential before anything is counted or paid", async () => {
    const { sponsor: s, where, payments } = sponsor();
    const key = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
    expect((await s.grade(TOKEN, { ...request, result: `key ${key}` }, "mainnet")).body).toMatchObject({ reason: "request", error: expect.stringContaining("result contains an AWS access key id") });
    expect(payments).toHaveLength(0);
    expect((await s.me(TOKEN)).body).toEqual({ login: "octocat", left: 2 });
    expect(readdirSync(where)).not.toContain("free-checks.json");
  });

  it("pays once for the same grade sent twice at once, and tells the second what to do", async () => {
    const { sponsor: s, payments } = sponsor();
    const both = await Promise.all([s.grade(TOKEN, request, "mainnet"), s.grade(TOKEN, request, "mainnet")]);
    expect(both.map(({ status }) => status).sort()).toEqual([200, 409]);
    expect(both.find(({ status }) => status === 409)!.body).toEqual({ reason: "pending", error: "This grade is already being paid for. Send it again in a few minutes to read it; that does not use another free check." });
    expect(payments).toHaveLength(1);
  });
});

describe("launch-day caps", () => {
  const users = Object.fromEntries(Array.from({ length: 3 }, (_, i) => [`gho_${String(i).padStart(36, "0")}`, { id: 2000 + i, login: `l${i}`, created_at: OLD }]));
  const tokens = Object.keys(users);
  const fill = async (s: Sponsor, n: number) => {
    for (let i = 0; i < n; i += 1) expect((await s.grade(tokens[Math.floor(i / 2)]!, nth(100 + i), "mainnet")).status).toBe(200);
  };

  it("hold a listed day to its own cap, and every other day, a past listed one too, to the default", async () => {
    const listed = sponsor({ users, caps: { days: { "2026-12-09": 3 }, total: FREE.total } });
    expect(listed.sponsor.info()).toMatchObject({ perDay: 3, total: FREE.total });
    await fill(listed.sponsor, 3);
    expect((await listed.sponsor.grade(tokens[1]!, nth(1), "mainnet")).body).toEqual({ reason: "daily", error: "Today's 3 free checks are all taken. More open at 00:00 UTC." });
    for (const day of ["2026-12-10", "2026-12-08"]) {
      const other = sponsor({ users, caps: { days: { [day]: 3 }, total: FREE.total } });
      expect(other.sponsor.info()).toMatchObject({ perDay: FREE.perDay });
      await fill(other.sponsor, 4);
    }
  });

  it("stop at the configured total in place of 250", async () => {
    const { sponsor: s, payments } = sponsor({ users, caps: { days: {}, total: 2 } });
    expect(s.info()).toMatchObject({ total: 2, open: true });
    await fill(s, 2);
    expect((await s.grade(tokens[1]!, nth(1), "mainnet")).body.reason).toBe("total");
    expect(s.info()).toMatchObject({ open: false });
    expect(payments).toHaveLength(2);
  });

  it("let the sponsor's own wallet limits follow: the highest day's cap a day, and the total in all", () => {
    expect(sponsorConfig(undefined, dir(), { days: { "2026-11-30": 200, "2026-12-01": 120 }, total: 600 })).toMatchObject({ daily: 50_000_000n, budget: 150_000_000n });
    expect(sponsorConfig(undefined, dir(), { days: { "2026-11-30": 10 }, total: 250 })).toMatchObject({ daily: 15_000_000n, budget: 62_500_000n });
  });

  it("are read from the watcher's settings, and a bad one stops the free checks with what is wrong", () => {
    expect(freeCaps({})).toEqual({ days: {}, total: FREE.total });
    expect(freeCaps({ BRAINCHAIN_FREE_DAY_CAPS: " 2026-11-30=200, 2026-12-01=150 ", BRAINCHAIN_FREE_TOTAL: "600" })).toEqual({ days: { "2026-11-30": 200, "2026-12-01": 150 }, total: 600 });
    for (const [setting, value, error] of [
      ["BRAINCHAIN_FREE_DAY_CAPS", "2026-11-30:200", 'BRAINCHAIN_FREE_DAY_CAPS takes comma-separated YYYY-MM-DD=N pairs, such as 2026-11-30=200, and "2026-11-30:200" is not one.'],
      ["BRAINCHAIN_FREE_DAY_CAPS", "30-11-2026=200", 'BRAINCHAIN_FREE_DAY_CAPS takes comma-separated YYYY-MM-DD=N pairs, such as 2026-11-30=200, and "30-11-2026=200" is not one.'],
      ["BRAINCHAIN_FREE_DAY_CAPS", "2026-02-30=200", "BRAINCHAIN_FREE_DAY_CAPS names 2026-02-30, which is not a calendar day."],
      ["BRAINCHAIN_FREE_DAY_CAPS", "2026-11-30=0", "BRAINCHAIN_FREE_DAY_CAPS gives 2026-11-30 a cap of 0; a cap must be a whole number above zero."],
      ["BRAINCHAIN_FREE_DAY_CAPS", "2026-11-30=1.5", "BRAINCHAIN_FREE_DAY_CAPS gives 2026-11-30 a cap of 1.5; a cap must be a whole number above zero."],
      ["BRAINCHAIN_FREE_DAY_CAPS", "2026-11-30=200,2026-11-30=100", "BRAINCHAIN_FREE_DAY_CAPS lists 2026-11-30 twice."],
      ["BRAINCHAIN_FREE_TOTAL", "-5", "BRAINCHAIN_FREE_TOTAL must be a whole number above zero."],
      ["BRAINCHAIN_FREE_TOTAL", "lots", "BRAINCHAIN_FREE_TOTAL must be a whole number above zero."],
    ] as const) {
      expect(() => freeCaps({ [setting]: value })).toThrow(error);
    }
    const where = dir();
    const file = join(where, "sponsor.key");
    writeFileSync(file, `0x${KEY}\n`);
    const env = { BRAINCHAIN_SPONSOR_KEY_FILE: file, GITHUB_CLIENT_ID: CLIENT };
    expect(() => sponsorFrom({ ...env, BRAINCHAIN_FREE_TOTAL: "0" }, where)).toThrow("BRAINCHAIN_FREE_TOTAL must be a whole number above zero.");
    const said: string[] = [];
    const made = sponsorFrom({ ...env, BRAINCHAIN_FREE_DAY_CAPS: "2026-12-08=500,2026-12-10=200", BRAINCHAIN_FREE_TOTAL: "600" }, where, { now: () => NOW, say: (line) => said.push(line) });
    expect(made?.info()).toMatchObject({ perDay: FREE.perDay, total: 600 });
    expect(said.join("\n")).toContain("at most 60 a day (200 on 2026-12-10) and 600 in all.");
  });
});

describe("the sponsor's settings", () => {
  it("are both set or neither, and say what is wrong without the key", () => {
    const where = dir();
    const file = join(where, "sponsor.key");
    writeFileSync(file, `0x${KEY}\n`);
    expect(sponsorFrom({}, where)).toBeUndefined();
    expect(() => sponsorFrom({ GITHUB_CLIENT_ID: CLIENT }, where)).toThrow("Set both, or neither.");
    expect(() => sponsorFrom({ BRAINCHAIN_SPONSOR_KEY_FILE: file, GITHUB_CLIENT_ID: "no spaces" }, where)).toThrow("GITHUB_CLIENT_ID is not a GitHub client id.");
    const bad = join(where, "bad.key");
    writeFileSync(bad, "not a key");
    expect(() => sponsorFrom({ BRAINCHAIN_SPONSOR_KEY_FILE: bad, GITHUB_CLIENT_ID: CLIENT }, where)).toThrow(/^BRAINCHAIN_SPONSOR_KEY_FILE must hold only a private key/);
    const said: string[] = [];
    const made = sponsorFrom({ BRAINCHAIN_SPONSOR_KEY_FILE: file, GITHUB_CLIENT_ID: CLIENT, BRAINCHAIN_NETWORK: "testnet" }, where, { say: (line) => said.push(line) });
    expect(made?.info()).toMatchObject({ network: "testnet", chain: "Base Sepolia" });
    expect(said.join("\n")).toContain(`from ${signer.address}`);
    expect(said.join("\n")).not.toContain(KEY);
  });
});

describe("the watcher's free routes", () => {
  let close: (() => void) | undefined;
  afterEach(() => close?.());

  async function serving(sponsor?: Sponsor, limits: ServeLimits = SERVE_LIMITS) {
    const log = new EventLog(dir());
    const served = serveEvents({ log, health: () => ({ ok: true, sources: {} }), limits, ...(sponsor ? { sponsor } : {}) });
    await new Promise<void>((resolve) => served.server.listen(0, "127.0.0.1", resolve));
    close = () => served.close();
    return `http://127.0.0.1:${(served.server.address() as AddressInfo).port}`;
  }

  const post = (base: string, path: string, body: unknown, authorization?: string) =>
    fetch(`${base}${path}`, { method: "POST", headers: { ...(authorization ? { authorization } : {}), "content-type": "application/json" }, body: JSON.stringify(body) });

  it("serve the sign-in details, the account's status and a grade, passing the sign-in and the network on", async () => {
    const { sponsor: s } = sponsor();
    const base = await serving(s);
    expect(await (await fetch(`${base}/free`)).json()).toMatchObject({ network: "mainnet", clientId: CLIENT, perAccount: 2, open: true, paused: false });
    expect(await (await fetch(`${base}/free/me`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()).toEqual({ login: "octocat", left: 2 });
    const graded = await post(base, "/free/grade?network=mainnet", request, `Bearer ${TOKEN}`);
    expect(graded.status).toBe(200);
    expect(await graded.json()).toMatchObject({ state: "graded", free: { used: 1, left: 1 } });
    expect((await post(base, "/free/grade?network=testnet", nth(2), `Bearer ${TOKEN}`)).status).toBe(409);
    expect((await fetch(`${base}/free/grade`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(405);
    expect(((await (await fetch(`${base}/nothing`)).json()) as { error: string }).error).toContain("GET /health, GET /free, GET /free/me, POST /free/grade, POST /watches");
  });

  it("take a grade up to the desk's own limits, and nothing larger", async () => {
    const { sponsor: s } = sponsor();
    const base = await serving(s);
    expect((await post(base, "/free/grade", { ...request, result: "x".repeat(FREE_BODY) }, `Bearer ${TOKEN}`)).status).toBe(413);
    expect((await post(base, "/free/grade", { brief: "é".repeat(32_000), result: "é".repeat(50_000) }, `Bearer ${TOKEN}`)).status).toBe(200);
  });

  it("turn away a missing or malformed sign-in before reading the body", async () => {
    const { sponsor: s, github } = sponsor();
    const base = await serving(s);
    const signIn = { reason: "login", error: "Sign in with GitHub first: run `npx -y brainchain-mcp login` in a terminal." };
    for (const authorization of [undefined, "Bearer short", `Basic ${TOKEN}`]) {
      const refused = await post(base, "/free/grade", { ...request, result: "x".repeat(FREE_BODY) }, authorization);
      expect([refused.status, await refused.json()]).toEqual([401, signIn]);
    }
    expect(await (await fetch(`${base}/free/me`)).json()).toEqual(signIn);
    expect(github).toEqual([]);
  });

  it("take a sign-in of up to 255 characters, as login keeps", async () => {
    const longest = `gho_${"a".repeat(251)}`;
    const { sponsor: s, github } = sponsor({ users: { [longest]: { id: 583231, login: "octocat", created_at: OLD } } });
    const base = await serving(s);
    expect(await (await fetch(`${base}/free/me`, { headers: { authorization: `Bearer ${longest}` } })).json()).toEqual({ login: "octocat", left: 2 });
    expect((await fetch(`${base}/free/me`, { headers: { authorization: `Bearer ${longest}a` } })).status).toBe(401);
    expect(github).toEqual([longest]);
  });

  it("hold each address to its own limit on free-check requests, apart from the shared limit", async () => {
    const { sponsor: s } = sponsor();
    const base = await serving(s, { ...SERVE_LIMITS, freePerMinute: 2 });
    const me = () => fetch(`${base}/free/me`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect([(await me()).status, (await me()).status]).toEqual([200, 200]);
    const refused = await me();
    expect([refused.status, refused.headers.get("retry-after")]).toEqual([429, "60"]);
    expect(await refused.json()).toEqual({
      error: "Too many free-check requests from your network address. BrainChain takes 2 a minute from one address, and people on the same network, such as an office, share one. Wait a minute, then try again.",
    });
    expect((await post(base, "/free/grade", request, `Bearer ${TOKEN}`)).status).toBe(429);
    expect([(await fetch(`${base}/free`)).status, (await fetch(`${base}/health/live`)).status]).toEqual([200, 200]);
  });

  it("take 20 free-check requests a minute from one address by default, enough for login and grading from a shared office", async () => {
    const { sponsor: s } = sponsor();
    const base = await serving(s);
    const me = () => fetch(`${base}/free/me`, { headers: { authorization: `Bearer ${TOKEN}` } });
    const statuses = [];
    for (let i = 0; i < 21; i++) statuses.push((await me()).status);
    expect(statuses).toEqual([...Array(20).fill(200), 429]);
  });

  it("say on /health whether the free checks are open or paused", async () => {
    const { sponsor: s } = sponsor({ paid: () => Response.json({ error: "insufficient_funds" }, { status: 402 }) });
    const base = await serving(s);
    expect(await (await fetch(`${base}/health`)).json()).toMatchObject({ ok: true, free: { open: true, paused: false } });
    await s.grade(TOKEN, request, "mainnet");
    expect(await (await fetch(`${base}/health`)).json()).toMatchObject({ ok: true, free: { open: false, paused: true } });
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  it("tell a grade the watcher failed on to be sent again, and anything else to try again", async () => {
    const broken: Sponsor = {
      info: () => ({ open: true, paused: false }),
      me: async () => {
        throw new Error("disk full");
      },
      grade: async () => {
        throw new Error("disk full");
      },
    };
    const base = await serving(broken);
    const grade = await post(base, "/free/grade", request, `Bearer ${TOKEN}`);
    expect([grade.status, await grade.json()]).toEqual([500, { error: "The free check failed on BrainChain's side. Send the same grade again in a minute: if it went through, you get it back without using another free check." }]);
    expect(await (await fetch(`${base}/free/me`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()).toEqual({ error: "The watcher hit an error answering that. Try again in a minute." });
  });

  it("answer 404 on a watcher that gives no free checks", async () => {
    const base = await serving();
    const response = await fetch(`${base}/free`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "This watcher gives no free checks." });
    expect(((await (await fetch(`${base}/nothing`)).json()) as { error: string }).error).not.toContain("/free");
  });
});
