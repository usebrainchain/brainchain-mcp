// brainchain-mcp claim: claim BrainChain's bounty for a Lean proof merged on Left to Solve, with the GitHub sign-in
// that `login` keeps.
import { existsSync } from "node:fs";

import { isAddress } from "viem";

import { leanProblems } from "./claims.js";
import { expandHome, KEY_FILE, resolveConfig } from "./config.js";
import { freeSetting, freeUrl, readLogin, type Login } from "./free.js";
import { cliCommand, payerAccount } from "./server.js";
import { BOARD_URL } from "./solve.js";

export const CLAIM_USAGE = `brainchain-mcp claim

Claim BrainChain's bounty for a proof of an open problem stated in Lean, proved on Left to Solve
(https://lefttosolve.com), an outside board where a proof is a pull request merged once the Lean kernel accepts it.

Usage:
  brainchain-mcp claim                           List the Lean problems with a bounty.
  brainchain-mcp claim <problem> --wallet 0x...  Claim the bounty for your merged proof of <problem>, paid to that
                                                 wallet. Without --wallet it goes to the wallet in ${KEY_FILE}, when
                                                 there is one.

Sign in first with brainchain-mcp login, as the GitHub account that sent the merged pull request. The bounty goes to
the first proof merged after it opened. BrainChain re-checks the proof and pays in USDC on Base after seven days.

Exits 0 when the claim is recorded, 1 when it is refused, and 2 when it could not be sent.

Environment:
  BRAINCHAIN_PROBLEMS_URL   Where the board is read from (default ${BOARD_URL}).
  BRAINCHAIN_FREE_URL       Where the claim is sent, the same address login signed in for (default BrainChain's own).
`;

export class ClaimUsageError extends Error {}

export interface ClaimOptions {
  env: Record<string, string | undefined>;
  version: string;
  fetch: typeof fetch;
  log: (line: string) => void;
  login?: () => Login | undefined;
  /** The address of the wallet in KEY_FILE, when there is one. */
  payer?: () => string | undefined;
  platform?: NodeJS.Platform;
}

const savedWallet = (): string | undefined => {
  if (!existsSync(expandHome(KEY_FILE))) return undefined;
  try {
    return payerAccount({ BRAINCHAIN_PAYER_KEY_FILE: KEY_FILE }).address;
  } catch {
    return undefined;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function parse(args: readonly string[]): { problem?: string; wallet?: string } {
  let problem: string | undefined;
  let wallet: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--wallet" || arg.startsWith("--wallet=")) {
      wallet = arg === "--wallet" ? args[++i] : arg.slice("--wallet=".length);
      if (!wallet) throw new ClaimUsageError("--wallet takes the address the bounty is paid to, such as --wallet 0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed.");
    } else if (arg.startsWith("-") || problem !== undefined) {
      throw new ClaimUsageError(`Unexpected argument ${arg}: claim takes a problem and --wallet.`);
    } else {
      problem = arg;
    }
  }
  if (wallet !== undefined && problem === undefined) throw new ClaimUsageError("Name the problem the claim is for: brainchain-mcp claim <problem> --wallet 0x...");
  return { ...(problem === undefined ? {} : { problem }), ...(wallet === undefined ? {} : { wallet }) };
}

/** Runs the command and returns its exit code. */
export async function runClaim(args: readonly string[], options: ClaimOptions): Promise<number> {
  const { env, version, fetch: fetchImpl, log, login = readLogin, payer = savedWallet, platform = process.platform } = options;
  const { problem, wallet: given } = parse(args);
  const boardUrl = env.BRAINCHAIN_PROBLEMS_URL?.trim() || BOARD_URL;

  if (problem === undefined) {
    let body: unknown;
    try {
      const response = await fetchImpl(boardUrl, { signal: AbortSignal.timeout(20_000) });
      body = response.ok ? await response.json() : undefined;
    } catch {
      body = undefined;
    }
    let problems;
    try {
      problems = leanProblems(body);
    } catch {
      log(`BrainChain's problem board at ${boardUrl} could not be read just now. Try again in a few minutes.`);
      return 2;
    }
    if (problems.length === 0) {
      log("BrainChain's board lists no Lean problem with a bounty right now.");
      return 0;
    }
    const rows = problems.map((p) => `  ${p.problem}\n      ${p.name}. Bounty: ${p.bounty} USDC on Base. Proof file: ${p.source.proofFile} in ${p.source.repo}.\n      ${p.source.page}`);
    log(`Lean problems with a bounty on BrainChain's board\n\n${rows.join("\n\n")}\n\nProve one on ${problems[0]!.source.name}, then claim it with: brainchain-mcp claim <problem> --wallet 0x...`);
    return 0;
  }

  const config = resolveConfig(env, { payments: false });
  const url = freeUrl(env, config.name);
  if (!url) {
    log(`Bounties are claimed on BrainChain mainnet, and BRAINCHAIN_NETWORK is ${config.name}. Run the claim without it.`);
    return 1;
  }
  const signIn = cliCommand("login", config, version, {}, platform, freeSetting(url, config.name));
  const kept = login();
  if (!kept) {
    log(`Sign in with GitHub first, as the account that sent the merged proof: run \`${signIn}\` in a terminal.`);
    return 1;
  }
  if (kept.url !== url.href) {
    log(`The GitHub sign-in on this machine was made for ${kept.url}, and claims go to ${url.href}. Run \`${signIn}\`, then claim again.`);
    return 1;
  }
  let wallet = given;
  if (wallet === undefined) {
    wallet = payer();
    if (!wallet) throw new ClaimUsageError("Name the wallet the bounty is paid to: brainchain-mcp claim <problem> --wallet 0x...");
    log(`No --wallet given, so the bounty goes to ${wallet}, the wallet in ${KEY_FILE}. Pass --wallet to name another.`);
  }
  if (!isAddress(wallet, { strict: false })) throw new ClaimUsageError("--wallet must be an EVM address: 0x followed by 40 hex characters.");

  const base = url.href.replace(/\/+$/, "");
  let response: Response;
  try {
    response = await fetchImpl(`${base}/claims`, {
      method: "POST",
      headers: { authorization: `Bearer ${kept.token}`, "content-type": "application/json" },
      body: JSON.stringify({ problem, wallet }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    log(`BrainChain's claims at ${base} could not be reached, and nothing was recorded. Try again in a few minutes. If it keeps failing, check your internet connection.`);
    return 2;
  }
  const body = (await response.json().catch(() => undefined)) as unknown;
  if (response.ok && isRecord(body) && isRecord(body.claim)) {
    const { claim } = body;
    log(`Claim recorded for ${String(claim.problem)}: the proof @${String(claim.login)} sent in ${String(claim.pr)}, merged on ${String(claim.mergedAt).slice(0, 10)}, to be paid to ${String(claim.wallet)}.`);
    if (typeof body.next === "string") log(body.next);
    return 0;
  }
  const error = isRecord(body) && typeof body.error === "string" ? body.error : `BrainChain's claims answered ${response.status}, and nothing was recorded. Try again in a few minutes.`;
  log(error);
  return response.status >= 500 ? 2 : 1;
}
