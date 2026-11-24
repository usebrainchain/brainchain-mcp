import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";

import { FREE } from "./free.js";
import { orderIdOf } from "./payments.js";
import { createSponsor, sponsorConfig, sponsorFrom, type Sponsor } from "./sponsor.js";
import { EventLog } from "./watch/events.js";
import { FREE_BODY, serveEvents } from "./watch/serve.js";

// Anvil's second default account: a public test key that holds nothing anywhere.
const KEY = "59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const signer = privateKeyToAccount(`0x${KEY}`);
const TOKEN = "gho_16C7e42F292c6912E7710c838347Ae178B4a";
const NOW = Date.parse("2026-12-09T08:01:00Z");
const OLD = "2015-03-01T10:00:00Z";
const request = { brief: "Sort 3, 1 and 2.", result: "1, 2, 3" };
const dir = () => mkdtempSync(join(tmpdir(), "brainchain-free-"));

interface Fakes {
  users?: Record<string, { id: number; login: string; created_at: string }>;
  paid?: (payment: { payload: unknown }) => Response;
}

/** GitHub's /user for the tokens in `users`, and a desk that offers USDC on Base and answers each paid grade with `paid`. */
function fakes(config: ReturnType<typeof sponsorConfig>, { users = { [TOKEN]: { id: 583231, login: "octocat", created_at: OLD } }, paid }: Fakes = {}) {
  const payments: { payload: unknown }[] = [];
  const github: string[] = [];
  const grades = `${config.desk}/x402/grades`;
  const accepts = [{ scheme: "exact", network: config.network, amount: "250000", asset: config.asset, payTo: config.payTo, maxTimeoutSeconds: 300, extra: { name: "USDC", version: "2" } }];
  const challenge = Buffer.from(JSON.stringify({ x402Version: 2, error: "Payment required", resource: { url: grades, mimeType: "application/json" }, accepts })).toString("base64");
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    if (req.url === "https://api.github.com/user") {
      const token = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "")?.[1] ?? "";
      github.push(token);
      const user = users[token];
      return user ? Response.json(user) : Response.json({ message: "Bad credentials" }, { status: 401 });
    }
    if (req.url !== grades) return new Response("{}", { status: 404 });
    const header = req.headers.get("payment-signature");
    if (!header) return new Response("{}", { status: 402, headers: { "payment-required": challenge } });
    const payment = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { payload: unknown };
    payments.push(payment);
    return paid ? paid(payment) : Response.json({ grade: orderIdOf(payment), state: "graded", accepted: true, answer: "accept", passProbability: 0.93, bar: 0.8 });
  }) as typeof fetch;
  return { fetchImpl, payments, github };
}

function sponsor(options: Fakes & { where?: string; now?: () => number } = {}) {
  const where = options.where ?? dir();
  const config = sponsorConfig("mainnet", where);
  const fake = fakes(config, options);
  const logged: string[] = [];
  const made = createSponsor({ config, signer, clientId: "Ov23liAbCdEfGhIjKlMn", dir: where, fetch: fake.fetchImpl, now: options.now ?? (() => NOW), say: (line) => logged.push(line) });
  return { sponsor: made, where, logged, ...fake };
}

const nth = (n: number) => ({ ...request, result: `${request.result} (${n})` });

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

  it("keep only each account's id and counts, never the sign-in", async () => {
    const { sponsor: s, where } = sponsor();
    await s.grade(TOKEN, nth(1), "mainnet");
    expect(JSON.parse(readFileSync(join(where, "free-checks.json"), "utf8"))).toEqual({ accounts: { "583231": 1 }, days: { "2026-12-09": 1 }, total: 1 });
    for (const file of readdirSync(where)) {
      const text = readFileSync(join(where, file), "utf8");
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain("octocat");
    }
  });

  it("go on from the counts on disk after a restart", async () => {
    const where = dir();
    await sponsor({ where }).sponsor.grade(TOKEN, nth(1), "mainnet");
    await sponsor({ where }).sponsor.grade(TOKEN, nth(2), "mainnet");
    expect((await sponsor({ where }).sponsor.grade(TOKEN, nth(3), "mainnet")).body.reason).toBe("used");
  });

  it("refuse accounts younger than 30 days, and say when the account was made", async () => {
    const created = new Date(NOW - 29 * 86_400_000).toISOString();
    const { sponsor: s, payments } = sponsor({ users: { [TOKEN]: { id: 9, login: "fresh", created_at: created } } });
    expect(await s.grade(TOKEN, request, "mainnet")).toEqual({ status: 403, body: { reason: "young", error: "Free checks are for GitHub accounts older than 30 days, and @fresh was created on 2026-11-10." } });
    expect((await s.me(TOKEN)).body).toMatchObject({ login: "fresh", left: 0, reason: "young" });
    expect(payments).toHaveLength(0);
  });

  it("stop at 60 a day, open again the next UTC day, and never pass the wallet's own daily limit", async () => {
    const users = Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`gho_${String(i).padStart(36, "0")}`, { id: 1000 + i, login: `u${i}`, created_at: OLD }]));
    let now = NOW;
    const { sponsor: s, payments } = sponsor({ users, now: () => now });
    const tokens = Object.keys(users);
    for (const [i, token] of tokens.slice(0, 30).entries()) for (const n of [1, 2]) expect((await s.grade(token, nth(10 * i + n), "mainnet")).status).toBe(200);
    expect(await s.grade(tokens[30]!, nth(1000), "mainnet")).toEqual({ status: 429, body: { reason: "daily", error: "Today's free checks are all taken. More open at 00:00 UTC." } });
    now += 86_400_000;
    expect((await s.me(tokens[30]!)).body).toEqual({ login: "u30", left: 2 });
    // The wallet's own daily limit, kept on the real clock, still holds 15 USDC for today: a fault in the counts cannot spend more.
    expect((await s.grade(tokens[30]!, nth(1000), "mainnet")).status).toBe(503);
    expect(payments).toHaveLength(FREE.perDay);
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

  it("count nothing for a payment that did not go through, or for a repeat answered from the first grade", async () => {
    let state = "failed";
    const { sponsor: s } = sponsor({ paid: (payment) => Response.json({ grade: orderIdOf(payment), state }) });
    expect((await s.grade(TOKEN, nth(1), "mainnet")).body).toMatchObject({ state: "failed", free: { used: 0, left: 2 } });
    state = "graded";
    expect((await s.grade(TOKEN, nth(2), "mainnet")).body).toMatchObject({ free: { used: 1, left: 1 } });
    expect((await s.grade(TOKEN, nth(2), "mainnet")).body).toMatchObject({ duplicate: true, free: { used: 1, left: 1 } });
  });

  it("count nothing when the desk refuses the payment, and keep the sponsor's details in the log", async () => {
    const { sponsor: s, logged } = sponsor({ paid: () => Response.json({ error: "insufficient_funds" }, { status: 402 }) });
    expect(await s.grade(TOKEN, request, "mainnet")).toEqual({ status: 503, body: { reason: "unavailable", error: "The free check could not be paid just now, and none was used. Try again in a few minutes." } });
    expect((await s.me(TOKEN)).body).toMatchObject({ left: 2 });
    expect(logged.join("\n")).toMatch(/a grade was not paid/);
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

  it("say who is signed in and what is left, using nothing", async () => {
    const { sponsor: s, payments } = sponsor();
    expect(await s.me(TOKEN)).toEqual({ status: 200, body: { login: "octocat", left: 2 } });
    expect(s.info()).toEqual({ network: "mainnet", chain: "Base", clientId: "Ov23liAbCdEfGhIjKlMn", ...FREE, open: true });
    expect(payments).toHaveLength(0);
  });

  it("pay exactly a grade's price, within a budget and a daily limit no larger than the checks", () => {
    const config = sponsorConfig(undefined, dir());
    expect(config).toMatchObject({ name: "mainnet", payOn: "base", chain: "Base", token: "USDC", maxPrice: 250_000n, budget: 62_500_000n, daily: 15_000_000n });
    expect(sponsorConfig("testnet", dir())).toMatchObject({ name: "testnet", chain: "Base Sepolia", desk: "https://brain.testnet.usebrainchain.com" });
  });
});

describe("the sponsor's settings", () => {
  it("are both set or neither, and say what is wrong without the key", () => {
    const where = dir();
    const file = join(where, "sponsor.key");
    writeFileSync(file, `0x${KEY}\n`);
    expect(sponsorFrom({}, where)).toBeUndefined();
    expect(() => sponsorFrom({ GITHUB_CLIENT_ID: "Ov23liAbCdEfGhIjKlMn" }, where)).toThrow("Set both, or neither.");
    expect(() => sponsorFrom({ BRAINCHAIN_SPONSOR_KEY_FILE: file, GITHUB_CLIENT_ID: "no spaces" }, where)).toThrow("GITHUB_CLIENT_ID is not a GitHub client id.");
    const bad = join(where, "bad.key");
    writeFileSync(bad, "not a key");
    expect(() => sponsorFrom({ BRAINCHAIN_SPONSOR_KEY_FILE: bad, GITHUB_CLIENT_ID: "Ov23liAbCdEfGhIjKlMn" }, where)).toThrow(/^BRAINCHAIN_SPONSOR_KEY_FILE must hold only a private key/);
    const said: string[] = [];
    const made = sponsorFrom({ BRAINCHAIN_SPONSOR_KEY_FILE: file, GITHUB_CLIENT_ID: "Ov23liAbCdEfGhIjKlMn", BRAINCHAIN_NETWORK: "testnet" }, where, { say: (line) => said.push(line) });
    expect(made?.info()).toMatchObject({ network: "testnet", chain: "Base Sepolia" });
    expect(said.join("\n")).toContain(`from ${signer.address}`);
    expect(said.join("\n")).not.toContain(KEY);
  });
});

describe("the watcher's free routes", () => {
  let close: (() => void) | undefined;
  afterEach(() => close?.());

  async function serving(sponsor?: Sponsor) {
    const log = new EventLog(dir());
    const served = serveEvents({ log, health: () => ({ ok: true, sources: {} }), ...(sponsor ? { sponsor } : {}) });
    await new Promise<void>((resolve) => served.server.listen(0, "127.0.0.1", resolve));
    close = () => served.close();
    return `http://127.0.0.1:${(served.server.address() as AddressInfo).port}`;
  }

  it("serve the sign-in details, the account's status and a grade, passing the sign-in and the network on", async () => {
    const { sponsor: s } = sponsor();
    const base = await serving(s);
    expect(await (await fetch(`${base}/free`)).json()).toMatchObject({ network: "mainnet", clientId: "Ov23liAbCdEfGhIjKlMn", perAccount: 2 });
    expect(await (await fetch(`${base}/free/me`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()).toEqual({ login: "octocat", left: 2 });
    const graded = await fetch(`${base}/free/grade?network=mainnet`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(request) });
    expect(graded.status).toBe(200);
    expect(await graded.json()).toMatchObject({ state: "graded", free: { used: 1, left: 1 } });
    const wrong = await fetch(`${base}/free/grade?network=testnet`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(request) });
    expect(wrong.status).toBe(409);
    expect((await fetch(`${base}/free/grade`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(405);
  });

  it("take a grade up to the desk's own limits, and nothing larger", async () => {
    const { sponsor: s } = sponsor();
    const base = await serving(s);
    const big = await fetch(`${base}/free/grade`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ ...request, result: "x".repeat(FREE_BODY) }) });
    expect(big.status).toBe(413);
    const most = await fetch(`${base}/free/grade`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ brief: "é".repeat(32_000), result: "é".repeat(50_000) }) });
    expect(most.status).toBe(200);
  });

  it("answer 404 on a watcher that gives no free checks", async () => {
    const base = await serving();
    const response = await fetch(`${base}/free`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "This watcher gives no free checks." });
  });
});
