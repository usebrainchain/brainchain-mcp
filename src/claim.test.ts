import { describe, expect, it } from "vitest";

import { ClaimUsageError, runClaim, type ClaimOptions } from "./claim.js";
import { FREE_URL, type Login } from "./free.js";

const TOKEN = "gho_16C7e42F292c6912E7710c838347Ae178B4a";
const SIGNED_IN: Login = { token: TOKEN, url: `${FREE_URL}/`, network: "mainnet" };
const WALLET = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const PR = "https://github.com/GuillaumeBAUD-coder/open-math-agents/pull/57";
const lean = {
  problem: "erdos-142",
  kind: "lean",
  version: 1,
  name: "Erdős Problem 142",
  bounty: 100,
  opened: "2026-12-10T00:00:00.000Z",
  source: { name: "Left to Solve", id: "E", page: "https://lefttosolve.com/p/E", brief: "https://lefttosolve.com/p/E/agent.txt", api: "https://lefttosolve.com/api/problems/E", repo: "GuillaumeBAUD-coder/open-math-agents", proofFile: "proofs/E.lean" },
  claim: null,
};
const recorded = {
  claim: { problem: "erdos-142", version: 1, login: "prover", wallet: WALLET, pr: PR, mergedAt: "2026-12-20T11:00:00Z", polarity: "proof", at: "2026-12-21T09:00:00.000Z", state: "recorded" },
  bounty: 100,
  next: `BrainChain re-checks the proof and pays 100 USDC on Base to ${WALLET} after the seven-day window.`,
};

/** The board and the watcher's claims route, answering `claims` and recording what was sent there. */
function run(args: string[], claims: Response | Error = Response.json(recorded), options: Partial<ClaimOptions> = {}) {
  const lines: string[] = [];
  const sent: { url: string; authorization: string | null; body: unknown }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    if (req.url === "https://usebrainchain.com/problems.json") return Response.json({ problems: [{ problem: "shannon" }], lean: [lean] });
    sent.push({ url: req.url, authorization: req.headers.get("authorization"), body: await req.json() });
    if (claims instanceof Error) throw claims;
    return claims;
  }) as typeof fetch;
  const done = runClaim(args, { env: {}, version: "0.0.0-test", fetch: fetchImpl, log: (line) => lines.push(line), login: () => SIGNED_IN, payer: () => undefined, platform: "darwin", ...options });
  return { done, lines, sent };
}

describe("brainchain-mcp claim", () => {
  it("lists the Lean problems with their bounties", async () => {
    const { done, lines } = run([]);
    expect(await done).toBe(0);
    expect(lines.join("\n")).toBe(
      "Lean problems with a bounty on BrainChain's board\n\n  erdos-142\n      Erdős Problem 142. Bounty: 100 USDC on Base. Proof file: proofs/E.lean in GuillaumeBAUD-coder/open-math-agents.\n      https://lefttosolve.com/p/E\n\nProve one on Left to Solve, then claim it with: brainchain-mcp claim <problem> --wallet 0x...",
    );
  });

  it("sends the claim with the kept sign-in and says when the bounty is paid", async () => {
    const { done, lines, sent } = run(["erdos-142", "--wallet", WALLET]);
    expect(await done).toBe(0);
    expect(sent).toEqual([{ url: "https://watch.usebrainchain.com/claims", authorization: `Bearer ${TOKEN}`, body: { problem: "erdos-142", wallet: WALLET } }]);
    expect(lines).toEqual([
      `Claim recorded for erdos-142: the proof @prover sent in ${PR}, merged on 2026-12-20, to be paid to ${WALLET}.`,
      `BrainChain re-checks the proof and pays 100 USDC on Base to ${WALLET} after the seven-day window.`,
    ]);
  });

  it("pays to the wallet init made when no --wallet is given, and says so", async () => {
    const { done, lines, sent } = run(["erdos-142"], Response.json(recorded), { payer: () => WALLET });
    expect(await done).toBe(0);
    expect(lines[0]).toBe(`No --wallet given, so the bounty goes to ${WALLET}, the wallet in ~/.brainchain/payer.key. Pass --wallet to name another.`);
    expect(sent[0]!.body).toEqual({ problem: "erdos-142", wallet: WALLET });
    await expect(run(["erdos-142"]).done).rejects.toThrow(new ClaimUsageError("Name the wallet the bounty is paid to: brainchain-mcp claim <problem> --wallet 0x..."));
    await expect(run(["erdos-142", "--wallet", "0x12"]).done).rejects.toThrow("--wallet must be an EVM address");
  });

  it("asks for a sign-in first, and sends nothing", async () => {
    const { done, lines, sent } = run(["erdos-142", "--wallet", WALLET], Response.json(recorded), { login: () => undefined });
    expect(await done).toBe(1);
    expect(lines).toEqual(["Sign in with GitHub first, as the account that sent the merged proof: run `npx -y brainchain-mcp@0.0.0-test login` in a terminal."]);
    expect(sent).toEqual([]);
  });

  it("passes a refusal on and exits 1, and exits 2 when the claims cannot be reached", async () => {
    const refusal = "The merged proof of Erdős Problem 142 was sent by @prover. Sign in as that account with brainchain-mcp login --again, then send the claim again.";
    const refused = run(["erdos-142", "--wallet", WALLET], Response.json({ reason: "author", error: refusal }, { status: 403 }));
    expect(await refused.done).toBe(1);
    expect(refused.lines).toEqual([refusal]);
    const down = run(["erdos-142", "--wallet", WALLET], new TypeError("fetch failed"));
    expect(await down.done).toBe(2);
    expect(down.lines[0]).toMatch(/^BrainChain's claims at https:\/\/watch\.usebrainchain\.com could not be reached, and nothing was recorded\./);
    const busy = run(["erdos-142", "--wallet", WALLET], Response.json({ reason: "unavailable", error: "GitHub could not be read just now. Nothing was recorded. Try again in a minute." }, { status: 503 }));
    expect(await busy.done).toBe(2);
  });

  it("takes a problem and --wallet, and nothing else", async () => {
    await expect(run(["erdos-142", "extra"]).done).rejects.toThrow("Unexpected argument extra");
    await expect(run(["--wallet", WALLET]).done).rejects.toThrow("Name the problem the claim is for");
  });
});
