import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { BOARD_MS, claimsFrom, createClaims, leanProblems } from "./claims.js";
import { readBoard } from "./solve.js";
import { EventLog } from "./watch/events.js";
import { SERVE_LIMITS, serveEvents, type ServeLimits } from "./watch/serve.js";

const CLIENT = "Ov23liAbCdEfGhIjKlMn";
const TOKEN = "gho_16C7e42F292c6912E7710c838347Ae178B4a";
const OTHER = "gho_otherotherotherotherotherother0000";
const WATCHER_TOKEN = "ghp_watcherwatcherwatcherwatcherwatch00";
const NOW = Date.parse("2026-12-21T09:00:00Z");
const WALLET = "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed";
const CHECKSUMMED = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const REPO = "GuillaumeBAUD-coder/open-math-agents";
const PR = `https://github.com/${REPO}/pull/57`;
const API = "https://lefttosolve.com/api/problems/Erdos142.erdos_142";
const BOARD = "https://usebrainchain.com/problems.json";
const NEW = "lefttosolve2/open-math-agents";
const REPO_ID = 1471973920;

const lean = {
  problem: "erdos-142",
  kind: "lean",
  version: 1,
  name: "Erdős Problem 142",
  bounty: 100,
  opened: "2026-12-10T00:00:00.000Z",
  source: {
    name: "Left to Solve",
    id: "Erdos142.erdos_142",
    page: "https://lefttosolve.com/p/Erdos142.erdos_142",
    brief: "https://lefttosolve.com/p/Erdos142.erdos_142/agent.txt",
    api: API,
    repo: REPO,
    proofFile: "proofs/Erdos142.erdos_142.lean",
  },
  lean: { decl: "Erdos142.erdos_142", statement: "theorem erdos_142 : ...", upstream: { repo: "google-deepmind/formal-conjectures", commit: "abc123", file: "FormalConjectures/ErdosProblems/142.lean", line: 1 } },
  claim: null,
};
const checker = { problem: "shannon-capacity-c7-5", name: "Shannon capacity", record: { display: "350", holder: "x" }, bounty: null, claim: null, answer: { format: "f", note: "n" }, briefId: "b", request: { title: "t", brief: "b", levels: ["a", "b"], pass: 0 } };

interface World {
  board?: unknown;
  solution?: unknown;
  pull?: Record<string, unknown>;
  files?: unknown;
  down?: "board" | "theirs" | "github";
  /** GitHub answers the old name with a 301 to the repository's id, as for a renamed repository. */
  renamed?: boolean;
  /** Where GitHub's redirect for the old name goes. */
  redirectTo?: string;
}

/** problems.json, their API and GitHub's, as fetch sees them, recording each request's address and authorization. */
function upstream(world: World) {
  const asked: { url: string; authorization: string | null }[] = [];
  const users: Record<string, Record<string, unknown>> = { [TOKEN]: { id: 7001, login: "prover", created_at: "2015-03-01T10:00:00Z" }, [OTHER]: { id: 7002, login: "late", created_at: "2015-03-01T10:00:00Z" } };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    asked.push({ url: req.url, authorization: req.headers.get("authorization") });
    if (req.url === "https://api.github.com/user") {
      const user = users[(req.headers.get("authorization") ?? "").slice("Bearer ".length)];
      return user ? Response.json(user, { headers: { "x-oauth-client-id": CLIENT } }) : Response.json({ message: "Bad credentials" }, { status: 401 });
    }
    if (req.url === BOARD) {
      if (world.down === "board") throw new TypeError("fetch failed");
      return Response.json(world.board ?? { board: "BrainChain", open: true, windowDays: 7, problems: [checker], lean: [lean] });
    }
    if (req.url === API) {
      if (world.down === "theirs") return new Response("upstream", { status: 500 });
      return Response.json({ id: "Erdos142.erdos_142", solution: "solution" in world ? world.solution : { handle: "prover", polarity: "proof", pr_url: PR, created_at: "2026-12-20T12:00:00Z" } });
    }
    const pulls = /^https:\/\/api\.github\.com\/(repos\/[^/]+\/[^/]+|repositories\/\d+)\/pulls\/57(\/files\?per_page=100)?$/.exec(req.url);
    if (pulls) {
      if (world.down === "github") throw new TypeError("fetch failed");
      const [, at, files] = pulls;
      if (world.renamed && at === `repos/${REPO}`) return new Response(null, { status: 301, headers: { location: world.redirectTo ?? req.url.replace(`/repos/${REPO}/`, `/repositories/${REPO_ID}/`) } });
      const repo = { [`repos/${REPO}`]: { id: REPO_ID, full_name: REPO }, [`repos/${NEW}`]: { id: REPO_ID, full_name: NEW }, [`repositories/${REPO_ID}`]: { id: REPO_ID, full_name: NEW }, "repos/someone/open-math-agents": { id: 999, full_name: "someone/open-math-agents" } }[at!];
      if (!repo) return Response.json({ message: "Not Found" }, { status: 404 });
      if (files) return Response.json(world.files ?? [{ filename: "README.md" }, { filename: "proofs/Erdos142.erdos_142.lean" }]);
      return Response.json({ number: 57, html_url: `https://github.com/${repo.full_name}/pull/57`, merged: true, merged_at: "2026-12-20T11:00:00Z", user: { id: 7001, login: "prover" }, base: { repo }, ...world.pull });
    }
    return Response.json({ message: "Not Found" }, { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, asked };
}

let close: (() => void) | undefined;
afterEach(() => close?.());

async function serving(world: World = {}, options: { limits?: ServeLimits; dir?: string; now?: () => number } = {}) {
  const { fetchImpl, asked } = upstream(world);
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "brainchain-claims-"));
  const logged: string[] = [];
  const claims = createClaims({ clientId: CLIENT, dir, fetch: fetchImpl, now: options.now ?? (() => NOW), say: (line) => logged.push(line), gitHub: (url) => (new URL(url).host === "api.github.com" ? { Authorization: `Bearer ${WATCHER_TOKEN}` } : {}) });
  const served = serveEvents({ log: new EventLog(mkdtempSync(join(tmpdir(), "brainchain-claims-log-"))), health: () => ({ ok: true, sources: {} }), claims, ...(options.limits ? { limits: options.limits } : {}) });
  await new Promise<void>((resolve) => served.server.listen(0, "127.0.0.1", resolve));
  close = () => served.close();
  const base = `http://127.0.0.1:${(served.server.address() as AddressInfo).port}`;
  const post = async (body: unknown, token: string | null = TOKEN) => {
    const response = await fetch(`${base}/claims`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  return { base, post, asked, logged, dir, file: join(dir, "claims.json") };
}

const claim = { problem: "erdos-142", wallet: WALLET };

describe("POST /claims", () => {
  it("records the claim of the account that sent the merged proof, and says when it is paid", async () => {
    const { post, asked, logged, file, base } = await serving();
    const reply = await post(claim);
    expect(reply).toEqual({
      status: 200,
      body: {
        claim: { problem: "erdos-142", version: 1, login: "prover", wallet: CHECKSUMMED, pr: PR, mergedAt: "2026-12-20T11:00:00Z", polarity: "proof", at: "2026-12-21T09:00:00.000Z", state: "recorded" },
        bounty: 100,
        next: `BrainChain re-checks the proof and pays 100 USDC on Base to ${CHECKSUMMED} after the seven-day window.`,
      },
    });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ claims: [{ ...(reply.body.claim as object), githubId: "7001" }] });
    expect(logged).toContain("claim recorded: erdos-142 by @prover, PR 57");
    // GitHub's pull request is read with the watcher's own token; the claimant's goes to /user alone.
    for (const { url, authorization } of asked.filter(({ url }) => url.includes("/pulls/57"))) expect([url, authorization]).toEqual([url, `Bearer ${WATCHER_TOKEN}`]);
    expect(asked.filter(({ authorization }) => authorization === `Bearer ${TOKEN}`).map(({ url }) => url)).toEqual(["https://api.github.com/user"]);
    const list = await (await fetch(`${base}/claims`)).json();
    expect(list).toEqual({ claims: [{ problem: "erdos-142", login: "prover", pr: PR, mergedAt: "2026-12-20T11:00:00Z", at: "2026-12-21T09:00:00.000Z", state: "recorded" }] });
    for (const text of [JSON.stringify(list), logged.join("\n")]) for (const secret of [TOKEN, "7001", WALLET, CHECKSUMMED, WATCHER_TOKEN]) expect(text).not.toContain(secret);
  });

  it("refuses with what to do next, and records nothing", async () => {
    const cases: [World, unknown, string | null, number, string][] = [
      [{}, claim, null, 401, "Sign in with GitHub first: run `npx -y brainchain-mcp login` in a terminal."],
      [{}, claim, "gho_unknownunknownunknownunknown00000", 401, "Your GitHub sign-in has expired or was revoked. Run `npx -y brainchain-mcp login` again."],
      [{}, { ...claim, wallet: "0x1234" }, TOKEN, 400, "wallet must be the EVM address the bounty is paid to: 0x followed by 40 hex characters."],
      [{}, { ...claim, extra: 1 }, TOKEN, 400, "Unknown field: extra. A claim takes problem and wallet."],
      [{}, { ...claim, problem: "erdos-1" }, TOKEN, 404, "BrainChain's board has no Lean problem named erdos-1. The ones you can claim: erdos-142."],
      [{ solution: null }, claim, TOKEN, 409, "Left to Solve lists no accepted proof of Erdős Problem 142 yet. Once it lists your merged proof, send the claim again."],
      [{ solution: { polarity: "proof", pr_url: "https://github.com/someone/else/pull/57" } }, claim, TOKEN, 502, `BrainChain could not read the proof Left to Solve lists for Erdős Problem 142: it does not name a pull request of ${REPO}. Nothing was recorded. Write to hello@usebrainchain.com with the problem's name.`],
      [{ pull: { merged: false, merged_at: null } }, claim, TOKEN, 409, `Pull request 57 of ${REPO} is not merged yet. Send the claim again once it is.`],
      [{}, claim, OTHER, 403, "The merged proof of Erdős Problem 142 was sent by @prover. Sign in as that account with brainchain-mcp login --again, then send the claim again."],
      [{ pull: { merged_at: "2026-12-01T00:00:00Z" } }, claim, TOKEN, 409, "The proof of Erdős Problem 142 was merged on 2026-12-01, before the bounty opened on 2026-12-10, so it does not win the bounty."],
      [{ files: [{ filename: "proofs/Other.lean" }] }, claim, TOKEN, 409, `Pull request 57 of ${REPO} does not add proofs/Erdos142.erdos_142.lean, the proof file for Erdős Problem 142, so it is not the proof the bounty is for.`],
    ];
    for (const [world, body, token, status, error] of cases) {
      const { post, file } = await serving(world);
      const reply = await post(body, token);
      expect([reply.status, reply.body.error]).toEqual([status, error]);
      expect(existsSync(file)).toBe(false);
      close?.();
    }
  });

  it("lets the same account change the wallet, and refuses a second account", async () => {
    const { post, file } = await serving({ pull: { user: { id: 7001, login: "prover" } } });
    await post(claim);
    const changed = await post({ ...claim, wallet: "0x0000000000000000000000000000000000000001" });
    expect(changed.status).toBe(200);
    expect(changed.body.claim).toMatchObject({ wallet: "0x0000000000000000000000000000000000000001", at: "2026-12-21T09:00:00.000Z" });
    expect((JSON.parse(readFileSync(file, "utf8")) as { claims: unknown[] }).claims).toHaveLength(1);
  });

  it("takes one claim per problem: another account that sent the merged proof later is refused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brainchain-claims-"));
    await (await serving({}, { dir })).post(claim);
    close?.();
    const second = await serving({ pull: { user: { id: 7002, login: "late" } } }, { dir });
    expect(await second.post(claim, OTHER)).toEqual({ status: 409, body: { reason: "taken", error: "A claim on Erdős Problem 142 is already recorded for @prover. One claim is taken per problem." } });
  });

  it("answers 503 and records nothing when the board, Left to Solve or GitHub cannot be read", async () => {
    for (const [down, lead] of [
      ["board", "BrainChain's problem board could not be read just now."],
      ["theirs", "Left to Solve could not be read just now."],
      ["github", "GitHub could not be read just now."],
    ] as const) {
      const { post, file } = await serving({ down });
      expect(await post(claim)).toEqual({ status: 503, body: { reason: "unavailable", error: `${lead} Nothing was recorded. Try again in a minute.` } });
      expect(existsSync(file)).toBe(false);
      close?.();
    }
  });

  it("reads the board once in five minutes", async () => {
    let now = NOW;
    const { post, asked } = await serving({}, { now: () => now });
    await post(claim);
    await post(claim);
    expect(asked.filter(({ url }) => url === BOARD)).toHaveLength(1);
    now += BOARD_MS;
    await post(claim);
    expect(asked.filter(({ url }) => url === BOARD)).toHaveLength(2);
  });

  it("holds an address to the free checks' requests a minute", async () => {
    const { post } = await serving({}, { limits: { ...SERVE_LIMITS, freePerMinute: 2 } });
    await post(claim);
    await post(claim);
    expect(await post(claim)).toEqual({ status: 429, body: { error: "Too many claim requests from your network address. BrainChain takes 2 a minute from one address. Wait a minute, then try again." } });
  });

  it("is named on /health and in the watcher's list of routes", async () => {
    const { base } = await serving();
    expect(await (await fetch(`${base}/health`)).json()).toMatchObject({ claims: "/claims" });
    expect(((await (await fetch(`${base}/nothing`)).json()) as { error: string }).error).toContain("GET /health, GET /claims, POST /claims, POST /watches");
    expect((await fetch(`${base}/claims`, { method: "DELETE" })).status).toBe(405);
  });
});

describe("a bounty whose entry names the repository's id", () => {
  const board = { board: "BrainChain", open: true, windowDays: 7, problems: [checker], lean: [{ ...lean, source: { ...lean.source, repoId: REPO_ID } }] };
  const solved = (pr_url: string) => ({ handle: "prover", polarity: "proof", pr_url, created_at: "2026-12-20T12:00:00Z" });

  it("follows GitHub from the old name of a renamed repository, sending the watcher's token to api.github.com alone", async () => {
    const { post, asked } = await serving({ board, renamed: true });
    const reply = await post(claim);
    expect(reply.status).toBe(200);
    expect(reply.body.claim).toMatchObject({ pr: `https://github.com/${NEW}/pull/57` });
    const read = asked.filter(({ url }) => url.includes("/pulls/57"));
    expect(read.map(({ url }) => url)).toEqual([
      `https://api.github.com/repos/${REPO}/pulls/57`,
      `https://api.github.com/repositories/${REPO_ID}/pulls/57`,
      `https://api.github.com/repositories/${REPO_ID}/pulls/57/files?per_page=100`,
    ]);
    for (const { authorization } of read) expect(authorization).toBe(`Bearer ${WATCHER_TOKEN}`);
  });

  it("takes the new name too", async () => {
    const { post } = await serving({ board, solution: solved(`https://github.com/${NEW}/pull/57`) });
    expect((await post(claim)).body.claim).toMatchObject({ pr: `https://github.com/${NEW}/pull/57` });
  });

  it("refuses a pull request of another repository, and records nothing", async () => {
    const { post, file } = await serving({ board, solution: solved("https://github.com/someone/open-math-agents/pull/57") });
    expect(await post(claim)).toEqual({
      status: 502,
      body: { reason: "unreadable", error: "BrainChain could not read the proof Left to Solve lists for Erdős Problem 142: pull request 57 is in someone/open-math-agents, not in the repository the bounty is for. Nothing was recorded. Write to hello@usebrainchain.com with the problem's name." },
    });
    expect(existsSync(file)).toBe(false);
  });

  it("follows no redirect away from api.github.com", async () => {
    const { post, asked } = await serving({ board, renamed: true, redirectTo: "https://elsewhere.example/pulls/57" });
    expect((await post(claim)).body).toEqual({ reason: "unavailable", error: "GitHub could not be read just now. Nothing was recorded. Try again in a minute." });
    expect(asked.some(({ url }) => url.startsWith("https://elsewhere.example"))).toBe(false);
  });

  it("without the id, matches the repository by name as before", async () => {
    const { post } = await serving({ solution: solved(`https://github.com/${NEW}/pull/57`) });
    expect((await post(claim)).body).toMatchObject({ reason: "unreadable", error: expect.stringContaining(`it does not name a pull request of ${REPO}`) });
    close?.();
    const renamed = await serving({ renamed: true });
    expect((await renamed.post(claim)).body.claim).toMatchObject({ pr: `https://github.com/${NEW}/pull/57` });
  });
});

describe("the claims' settings", () => {
  it("are on with GITHUB_CLIENT_ID alone, and say what is wrong", () => {
    const dir = mkdtempSync(join(tmpdir(), "brainchain-claims-"));
    expect(claimsFrom({}, dir)).toBeUndefined();
    const said: string[] = [];
    expect(claimsFrom({ GITHUB_CLIENT_ID: CLIENT }, dir, { say: (line) => said.push(line) })).toBeDefined();
    expect(said).toEqual([`Claims are on: Lean bounties from ${BOARD}, for sign-ins made through GitHub app ${CLIENT}.`]);
    expect(() => claimsFrom({ GITHUB_CLIENT_ID: "no spaces" }, dir)).toThrow("GITHUB_CLIENT_ID is not a GitHub client id.");
    expect(() => claimsFrom({ GITHUB_CLIENT_ID: CLIENT, BRAINCHAIN_PROBLEMS_URL: "http://example.com/p.json" }, dir)).toThrow("BRAINCHAIN_PROBLEMS_URL must be an https URL");
    expect(claimsFrom({ GITHUB_CLIENT_ID: CLIENT, BRAINCHAIN_PROBLEMS_URL: "http://127.0.0.1:8080/problems.json" }, dir)).toBeDefined();
  });
});

describe("the board's Lean problems", () => {
  it("are read from its lean array, and from a kind lean entry in problems too", () => {
    const board = { board: "BrainChain", open: true, windowDays: 7, problems: [checker], lean: [lean] };
    expect(leanProblems(board).map((p) => p.problem)).toEqual(["erdos-142"]);
    expect(leanProblems({ ...board, lean: [], problems: [checker, { ...lean, problem: "erdos-143" }] }).map((p) => p.problem)).toEqual(["erdos-143"]);
    expect(leanProblems({ ...board, lean: [{ ...lean, source: { ...lean.source, api: undefined } }] })).toEqual([]);
    expect(() => leanProblems({ board: "BrainChain" })).toThrow("not in the format");
  });

  it("leave solve reading the board, wherever they are listed", () => {
    for (const board of [
      { board: "BrainChain", open: true, windowDays: 7, problems: [checker], lean: [lean] },
      { board: "BrainChain", open: true, windowDays: 7, problems: [checker, lean] },
    ]) {
      expect(readBoard(board).problems.map((p) => p.problem)).toEqual(["shannon-capacity-c7-5"]);
    }
  });
});
