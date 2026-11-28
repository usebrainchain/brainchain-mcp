// Bounties for Lean proofs. BrainChain's board lists open problems stated in Lean 4 that are proved on an outside board,
// Left to Solve, where a proof is a pull request merged once the Lean kernel accepts it. A solver claims the bounty with
// the GitHub sign-in from `brainchain-mcp login`: this checks that the signed-in account sent the merged pull request
// that added the problem's proof file, after the bounty opened, and records where the bounty is to be paid. Paying it
// comes later, after BrainChain's own re-check.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getAddress, isAddress } from "viem";

import { gitHubAuth } from "./github.js";
import { firstLine } from "./payments.js";
import { answer, GITHUB_API, signedIn, type Answer } from "./signin.js";
import { BOARD_URL } from "./solve.js";

/** How long a read of the problem board is used before it is read again. */
export const BOARD_MS = 5 * 60_000;
const UPSTREAM_MS = 10_000;
const UNTOUCHED = "nothing was recorded";
const AGAIN = "Nothing was recorded. Try again in a minute.";

/** A Lean problem as the board lists it. */
export interface LeanProblem {
  problem: string;
  version: number;
  name: string;
  bounty: number;
  opened: string;
  /** `repoId` is GitHub's id for `repo`, which stays the same when the repository is renamed. */
  source: { name: string; id: string; page: string; brief: string; api: string; repo: string; repoId?: number; proofFile: string };
}

/** A recorded claim. `githubId` is kept to tell the claimant again and is never shown. */
interface Claim {
  problem: string;
  version: number;
  githubId: string;
  login: string;
  wallet: string;
  pr: string;
  mergedAt: string;
  polarity: string;
  at: string;
  /** "recorded" until BrainChain has re-checked the proof; the wallet can change only until then. */
  state: string;
}

export interface Claims {
  /** Every claim, as anyone may read it: no wallets and no account ids. */
  list(): Answer;
  claim(token: string | undefined, body: unknown): Promise<Answer>;
}

export interface ClaimsOptions {
  /** The client id of BrainChain's GitHub OAuth app, whose sign-ins alone are taken. */
  clientId: string;
  /** Where the claims are kept. */
  dir: string;
  problemsUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
  say?: (line: string) => void;
  /** The watcher's own GitHub token as a header, for GitHub's API only. The signed-in account's token is never sent there. */
  gitHub?: (url: string) => Record<string, string>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/**
 * The Lean problems in problems.json: its top-level `lean` array, apart from `problems`, which versions before 0.26.0
 * read strictly; a `kind: "lean"` entry in `problems` counts too. An entry missing any field a claim reads is left out.
 */
export function leanProblems(body: unknown): LeanProblem[] {
  if (!isRecord(body) || !(Array.isArray(body.lean) || Array.isArray(body.problems))) throw new Error("the problem board is not in the format this version knows");
  const listed = [...(Array.isArray(body.lean) ? body.lean : []), ...(Array.isArray(body.problems) ? body.problems.filter((p) => isRecord(p) && p.kind === "lean") : [])];
  return listed.flatMap((p): LeanProblem[] => {
    if (!isRecord(p) || !isText(p.problem) || !isText(p.name) || typeof p.version !== "number" || typeof p.bounty !== "number") return [];
    const s = p.source;
    if (!isText(p.opened) || Number.isNaN(Date.parse(p.opened)) || !isRecord(s)) return [];
    if (![s.name, s.id, s.page, s.brief, s.api, s.repo, s.proofFile].every(isText)) return [];
    const source = s as LeanProblem["source"];
    const repoId = typeof s.repoId === "number" && Number.isSafeInteger(s.repoId) ? { repoId: s.repoId } : {};
    return [{ problem: p.problem, version: p.version, name: p.name, bounty: p.bounty, opened: p.opened, source: { name: source.name, id: source.id, page: source.page, brief: source.brief, api: source.api, repo: source.repo, ...repoId, proofFile: source.proofFile } }];
  });
}

/**
 * A read of GitHub's API. It follows GitHub's redirects itself, such as the one for a renamed repository, and only to
 * api.github.com, so the watcher's token goes nowhere else. `url` is where the answer came from.
 */
async function readGitHub(fetchImpl: typeof fetch, url: string, gitHub: (url: string) => Record<string, string>): Promise<{ status: number; body: unknown; url: string } | { failed: string }> {
  let at = url;
  for (let hop = 0; hop <= 3; hop += 1) {
    let response: Response;
    try {
      response = await fetchImpl(at, {
        headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "brainchain-watch", ...gitHub(at) },
        redirect: "manual",
        signal: AbortSignal.timeout(UPSTREAM_MS),
      });
    } catch (error) {
      return { failed: firstLine(error) };
    }
    const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
    if (!location) return { status: response.status, body: (await response.json().catch(() => undefined)) as unknown, url: at };
    const next = new URL(location, at);
    if (next.origin !== GITHUB_API) return { failed: `GitHub redirected to ${next.host}` };
    at = next.href;
  }
  return { failed: "GitHub redirected more than three times" };
}

/** A JSON answer read within the time limit, or why it could not be read. */
async function read(fetchImpl: typeof fetch, url: string, headers: Record<string, string>): Promise<{ status: number; body: unknown } | { failed: string }> {
  try {
    const response = await fetchImpl(url, { headers: { accept: "application/json", ...headers }, signal: AbortSignal.timeout(UPSTREAM_MS) });
    const body = (await response.json().catch(() => undefined)) as unknown;
    return { status: response.status, body };
  } catch (error) {
    return { failed: firstLine(error) };
  }
}

const day = (iso: string) => new Date(iso).toISOString().slice(0, 10);

export function createClaims({ clientId, dir, problemsUrl = BOARD_URL, fetch: fetchImpl = fetch, now = Date.now, say = () => {}, gitHub = gitHubAuth }: ClaimsOptions): Claims {
  const file = join(dir, "claims.json");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const kept: { claims: Claim[] } = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { claims: Claim[] }) : { claims: [] };
  let board: { at: number; problems: LeanProblem[] } | undefined;

  function save(): void {
    writeFileSync(`${file}.next`, `${JSON.stringify(kept)}\n`);
    renameSync(`${file}.next`, file);
  }

  async function problems(): Promise<LeanProblem[] | Answer> {
    if (board && now() - board.at < BOARD_MS) return board.problems;
    const got = await read(fetchImpl, problemsUrl, {});
    if ("failed" in got || got.status !== 200) {
      say(`claims: the problem board could not be read (${"failed" in got ? got.failed : `answered ${got.status}`})`);
      return answer(503, "unavailable", `BrainChain's problem board could not be read just now. ${AGAIN}`);
    }
    try {
      board = { at: now(), problems: leanProblems(got.body) };
    } catch (error) {
      say(`claims: ${firstLine(error)}`);
      return answer(503, "unavailable", `BrainChain's problem board could not be read just now. ${AGAIN}`);
    }
    return board.problems;
  }

  return {
    list: () => ({ status: 200, body: { claims: kept.claims.map(({ problem, login, pr, mergedAt, at, state }) => ({ problem, login, pr, mergedAt, at, state })) } }),

    async claim(token, body) {
      const user = await signedIn(token, { clientId, fetch: fetchImpl, untouched: UNTOUCHED, label: "claims", say });
      if ("status" in user) return user;
      if (!isRecord(body)) return answer(400, "request", "Send the claim as a JSON object: problem and wallet.");
      const { problem: slug, wallet: given, ...rest } = body;
      const extra = Object.keys(rest);
      if (extra.length) return answer(400, "request", `Unknown field${extra.length === 1 ? "" : "s"}: ${extra.slice(0, 5).join(", ")}. A claim takes problem and wallet.`);
      if (!isText(slug)) return answer(400, "request", "problem must be the slug of a Lean problem on BrainChain's board, such as brainchain-mcp claim lists.");
      if (typeof given !== "string" || !isAddress(given, { strict: false })) return answer(400, "wallet", "wallet must be the EVM address the bounty is paid to: 0x followed by 40 hex characters.");
      const wallet = getAddress(given);

      const listed = await problems();
      if ("status" in listed) return listed;
      const entry = listed.find((p) => p.problem === slug);
      if (!entry) {
        const open = listed.map((p) => p.problem);
        return answer(404, "problem", open.length ? `BrainChain's board has no Lean problem named ${slug}. The ones you can claim: ${open.join(", ")}.` : `BrainChain's board has no Lean problem named ${slug}, and none to claim right now.`);
      }
      const { name, source } = entry;

      const theirs = await read(fetchImpl, source.api, {});
      if ("failed" in theirs || theirs.status !== 200 || !isRecord(theirs.body)) {
        say(`claims: ${source.name} could not be read for ${slug} (${"failed" in theirs ? theirs.failed : `answered ${theirs.status}`})`);
        return answer(503, "unavailable", `${source.name} could not be read just now. ${AGAIN}`);
      }
      const solution = theirs.body.solution;
      if (solution === null || solution === undefined) return answer(409, "unproved", `${source.name} lists no accepted proof of ${name} yet. Once it lists your merged proof, send the claim again.`);
      // Any owner and name: a renamed repository keeps its id, and GitHub redirects its old name to it.
      const pull = isRecord(solution) && isText(solution.pr_url) ? /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)\/?$/i.exec(solution.pr_url) : null;
      const polarity = isRecord(solution) && (solution.polarity === "proof" || solution.polarity === "refutation") ? solution.polarity : undefined;
      const named = pull ? `${pull[1]}/${pull[2]}` : undefined;
      if (!pull || !named || !polarity || (source.repoId === undefined && named.toLowerCase() !== source.repo.toLowerCase())) {
        say(`claims: ${source.name} lists a solution of ${slug} that does not name a pull request of ${source.repo}`);
        return answer(502, "unreadable", `BrainChain could not read the proof ${source.name} lists for ${name}: it does not name a pull request of ${source.repo}. Nothing was recorded. Write to hello@usebrainchain.com with the problem's name.`);
      }
      const number = pull[3]!;

      const pr = await readGitHub(fetchImpl, `${GITHUB_API}/repos/${named}/pulls/${number}`, gitHub);
      if ("failed" in pr || pr.status >= 500 || pr.status === 403 || pr.status === 429) {
        say(`claims: GitHub could not be read for pull request ${number} (${"failed" in pr ? pr.failed : `answered ${pr.status}`})`);
        return answer(503, "unavailable", `GitHub could not be read just now. ${AGAIN}`);
      }
      const p = pr.body;
      if (pr.status !== 200 || !isRecord(p) || !isRecord(p.user) || typeof p.user.id !== "number" || !isText(p.user.login)) {
        return answer(502, "unreadable", `BrainChain could not read pull request ${number} of ${named} on GitHub. Nothing was recorded. Write to hello@usebrainchain.com with the problem's name.`);
      }
      const base = isRecord(p.base) && isRecord(p.base.repo) ? p.base.repo : {};
      const repo = isText(base.full_name) ? base.full_name : named;
      if (source.repoId !== undefined && base.id !== source.repoId) {
        say(`claims: ${source.name} lists pull request ${number} of ${repo} for ${slug}, not one of repository ${source.repoId}`);
        return answer(502, "unreadable", `BrainChain could not read the proof ${source.name} lists for ${name}: pull request ${number} is in ${repo}, not in the repository the bounty is for. Nothing was recorded. Write to hello@usebrainchain.com with the problem's name.`);
      }
      if (p.merged !== true || !isText(p.merged_at)) return answer(409, "unmerged", `Pull request ${number} of ${repo} is not merged yet. Send the claim again once it is.`);
      if (String(p.user.id) !== user.id) return answer(403, "author", `The merged proof of ${name} was sent by @${p.user.login}. Sign in as that account with brainchain-mcp login --again, then send the claim again.`);
      if (Date.parse(p.merged_at) < Date.parse(entry.opened)) {
        return answer(409, "early", `The proof of ${name} was merged on ${day(p.merged_at)}, before the bounty opened on ${day(entry.opened)}, so it does not win the bounty.`);
      }
      const files = await readGitHub(fetchImpl, `${pr.url}/files?per_page=100`, gitHub);
      if ("failed" in files || files.status !== 200 || !Array.isArray(files.body)) {
        say(`claims: GitHub could not be read for the files of pull request ${number} (${"failed" in files ? files.failed : `answered ${files.status}`})`);
        return answer(503, "unavailable", `GitHub could not be read just now. ${AGAIN}`);
      }
      if (!files.body.some((f) => isRecord(f) && f.filename === source.proofFile)) {
        return answer(409, "file", `Pull request ${number} of ${repo} does not add ${source.proofFile}, the proof file for ${name}, so it is not the proof the bounty is for.`);
      }

      // Checked and written in one turn, so two claims sent at once cannot both be recorded.
      const earlier = kept.claims.find((c) => c.problem === slug);
      if (earlier && earlier.githubId !== user.id) return answer(409, "taken", `A claim on ${name} is already recorded for @${earlier.login}. One claim is taken per problem.`);
      if (earlier && earlier.state !== "recorded") return answer(409, "settled", `Your claim on ${name} is already ${earlier.state}, so its wallet can no longer change.`);
      const claim: Claim = earlier
        ? { ...earlier, wallet }
        : { problem: slug, version: entry.version, githubId: user.id, login: user.login, wallet, pr: isText(p.html_url) && p.html_url.startsWith("https://github.com/") ? p.html_url : `https://github.com/${repo}/pull/${number}`, mergedAt: p.merged_at, polarity, at: new Date(now()).toISOString(), state: "recorded" };
      const before = kept.claims;
      kept.claims = [...kept.claims.filter((c) => c !== earlier), claim];
      try {
        save();
      } catch (error) {
        kept.claims = before;
        say(`claims: the claims could not be written (${firstLine(error)})`);
        return answer(503, "unavailable", `The claim could not be saved just now. ${AGAIN}`);
      }
      say(`claim ${earlier ? "wallet changed" : "recorded"}: ${slug} by @${user.login}, PR ${number}`);
      const { githubId: _id, ...shown } = claim;
      return { status: 200, body: { claim: shown, bounty: entry.bounty, next: `BrainChain re-checks the proof and pays ${entry.bounty} USDC on Base to ${wallet} after the seven-day window.` } };
    },
  };
}

/** The board BRAINCHAIN_PROBLEMS_URL names, BrainChain's own by default; throws when it is not https, or http on loopback. */
export function boardUrlFrom(env: Record<string, string | undefined>): URL {
  const given = env.BRAINCHAIN_PROBLEMS_URL?.trim() || BOARD_URL;
  const url = URL.canParse(given) ? new URL(given) : undefined;
  const local = url !== undefined && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!url || (url.protocol !== "https:" && !(url.protocol === "http:" && local))) throw new Error("BRAINCHAIN_PROBLEMS_URL must be an https URL, or http on localhost or 127.0.0.1.");
  return url;
}

/**
 * The claims a watcher takes, on whenever GITHUB_CLIENT_ID is set, from the board BRAINCHAIN_PROBLEMS_URL names
 * (BrainChain's own by default). Neither needs the sponsor's key. Throws what is wrong with either setting.
 */
export function claimsFrom(env: Record<string, string | undefined>, dir: string, options: Pick<ClaimsOptions, "fetch" | "now" | "say" | "gitHub"> = {}): Claims | undefined {
  const clientId = env.GITHUB_CLIENT_ID?.trim();
  if (!clientId) return undefined;
  if (!/^[\w.-]{8,64}$/.test(clientId)) throw new Error("GITHUB_CLIENT_ID is not a GitHub client id.");
  const url = boardUrlFrom(env);
  options.say?.(`Claims are on: Lean bounties from ${url.href}, for sign-ins made through GitHub app ${clientId}.`);
  return createClaims({ clientId, dir, problemsUrl: url.href, ...options });
}
