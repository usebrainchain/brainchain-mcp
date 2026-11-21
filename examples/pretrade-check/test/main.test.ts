import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";
import { encodeFunctionData, erc20Abi } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { DEFAULT_DESK, GRADE_PAYMENT, gradeId, type Verdict } from "../src/desk.ts";
import { describeTrade, loadAccount, noLiquidity, Refusal, report, run, toSign, tradeOf, unfillable, type Io, untrustedReasons } from "../src/main.ts";
import { checksFor, CHECKS_TEMPLATE, mandateText, pretradeCheck, sha256 } from "../src/request.ts";
import { runLocally, type Run } from "../src/sandbox.ts";
import { GATEWAY, quoteQuery, type SignedQuote } from "../src/zerox.ts";

import { USDC_BASE } from "../src/shared.ts";

import { MANDATE, MANDATE_FILE, node, read, recorded, recordOf } from "./helpers.ts";

const { trade, quote, registry } = recorded("inside");
const measured = read("../measured.json") as { runs: ({ case: string } & Verdict)[] };

describe("the trade from the command line", () => {
  const args = { sell: "usdg", buy: "WETH", amount: "5", slippage: "50" };

  it("is read in whole tokens of tokens the mandate lists", () => {
    const t = tradeOf(MANDATE, MANDATE.wallet, args);
    expect(t).toMatchObject({ chainId: 4663, sellAmount: 5_000_000n, slippageBps: 50, buyToken: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" });
    expect(describeTrade(MANDATE, t)).toBe("sell 5 USDG for WETH on Robinhood Chain");
  });

  it.each([
    [{ buy: "0x42b96dbc55e79e930d866c1ee486a342366546bc" }, "The mandate does not list 0x42b96dbc55e79E930d866c1eE486A342366546BC, so it cannot be bought. It lists USDG, WETH, ETH."],
    [{ sell: "BRAIN" }, "The mandate does not list BRAIN, so it cannot be sold. It lists USDG, WETH, ETH."],
    [{ amount: "25.000001" }, "The mandate lets one trade sell at most 25 USDG, not 25.000001."],
    [{ slippage: "101" }, "A slippage of 101 basis points is over the mandate's 100. Pass --slippage-bps 100 or less."],
  ])("refuses %j before 0x is paid", (change, message) => {
    expect(() => tradeOf(MANDATE, MANDATE.wallet, { ...args, ...change })).toThrow(new Refusal(message));
  });

  it("refuses 0x's default slippage under a tighter mandate, and a token the mandate only lets be bought", () => {
    const tight = { ...MANDATE, maxSlippageBps: 50, tokens: MANDATE.tokens.map((t) => (t.symbol === "WETH" ? { ...t, maxSell: "0" } : t)) };
    expect(() => tradeOf(tight, MANDATE.wallet, { ...args, slippage: undefined })).toThrow("0x's default slippage of 100 basis points is over the mandate's 50.");
    expect(() => tradeOf(tight, MANDATE.wallet, { sell: "WETH", buy: "USDG", amount: "0.001" })).toThrow("The mandate lets WETH be bought, never sold.");
  });

  it.each([
    [{ buy: "usdg" }, "--sell and --buy are both USDG."],
    [{ amount: "0" }, "--amount must be more than 0."],
    [{ amount: "0.0000001" }, "--amount has more decimals than USDG's 6."],
    [{ amount: "5e3" }, "--amount is how much USDG to sell"],
    [{ slippage: "1e2" }, "--slippage-bps is a whole number of basis points"],
  ])("rejects %j as input it cannot read", (change, message) => {
    const error = (() => {
      try {
        tradeOf(MANDATE, MANDATE.wallet, { ...args, ...change });
      } catch (e) {
        return e as Error;
      }
    })();
    expect(error?.message).toContain(message);
    expect(error).not.toBeInstanceOf(Refusal);
  });
});

describe("a quote that passes the checks", () => {
  it("is still refused when 0x has no route or the wallet cannot cover it", () => {
    expect(unfillable(recorded("native").quote)).toBe("The wallet holds 298803918768000 base units of 0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee, and the trade needs 1000000000000000. The transaction would revert.");
    expect(unfillable({ ...quote, response: { ...quote.response, body: '{"liquidityAvailable":false}' } })).toBe("0x found no liquidity for this trade.");
    expect(unfillable(quote)).toBeUndefined();
  });
});

describe("a quote 0x has no liquidity for", () => {
  const t = tradeOf(MANDATE, MANDATE.wallet, { sell: "USDG", buy: "WETH", amount: "5" });
  const tokens = { "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168": {}, "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73": {} };

  it("names another chain where both tokens are contracts, as for a mandate set to the wrong chain", async () => {
    const io = { connect: async () => node(tokens) };
    await expect(noLiquidity(t, io)).resolves.toBe("0x found no liquidity for this trade on Robinhood Chain, chain 4663. Both tokens are also contracts on Base, chain 8453: if the trade is meant for that chain, set chain to 8453 in the mandate.");
  });

  it("names only the chain it asked about when it can tell nothing more", async () => {
    await expect(noLiquidity(t, { connect: async () => node({}) })).resolves.toBe("0x found no liquidity for this trade on Robinhood Chain, chain 4663.");
    await expect(noLiquidity(t, { connect: async () => Promise.reject(new Error("down")) })).resolves.toBe("0x found no liquidity for this trade on Robinhood Chain, chain 4663.");
  });
});

describe("after the verdict", () => {
  const body = JSON.parse(quote.response.body);
  const withBody = (change: (b: typeof body) => void): SignedQuote => {
    const copy = structuredClone(body);
    change(copy);
    return { ...quote, response: { ...quote.response, body: JSON.stringify(copy) } };
  };

  it("gives the approval for exactly the amount sold, and the transaction 0x quoted, each ready to sign on the mandate's chain", () => {
    const { approve, transaction } = toSign(quote, 4663);
    expect(approve).toEqual({ to: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: ["0x0000000000001fF3684f28c67538d4D072C22734", 5_000_000n] }), value: "0", chainId: 4663 });
    expect(transaction).toEqual({ to: body.transaction.to, data: body.transaction.data, value: "0", gas: body.transaction.gas, gasPrice: body.transaction.gasPrice, chainId: 4663 });
    expect(toSign(recorded("native").quote, 4663).approve).toBeUndefined();
  });

  it("refuses an approval to anyone but AllowanceHolder, and gas over its cap, as errors rather than refusals by the mandate", () => {
    const spender = (() => {
      try {
        toSign(withBody((b) => (b.issues.allowance.spender = "0x000000000000000000000000000000000000dEaD")), 4663);
      } catch (error) {
        return error as Error;
      }
    })();
    expect(spender?.message).toContain("0x asks for an approval to 0x000000000000000000000000000000000000dEaD, not to AllowanceHolder");
    expect(spender).not.toBeInstanceOf(Refusal);
    expect(() => toSign(withBody((b) => (b.transaction.gasPrice = "1000000000000")), 4663)).toThrow("The transaction may cost 0.254397 ETH in gas, over this client's 0.0001. Ask for a new quote.");
  });

  it("shows the trade and every rule as BrainChain's run printed them", () => {
    const refused = measured.runs.find((r) => r.case === "outside")!;
    const lines = report({ ...refused, status: "" });
    expect(lines[0]).toMatch(/^Refused: pass probability 0%, bar 80%/);
    expect(lines[1]).toBe("Checks: failed (AssertionError: the trade breaks the mandate: tokens). BrainChain's run printed:");
    expect(lines[2]).toMatch(/^ {2}Trade: sell 5 USDG for at least 12220843171422880017856 base units/);
    expect(lines).toContain("  FAIL  tokens: sells USDG; buys 0x42b96dbc55e79e930d866c1ee486a342366546bc, which the mandate does not list");
    expect(lines).toContain("  11 of 12 rules pass; failed: tokens.");
  });

  it("does not call checks unrun when only the record holds what they printed", () => {
    const lines = report({ grade: "0x1", state: "graded", status: "", accepted: true, checks: { language: "python", outcome: "passed" } });
    expect(lines[1]).toBe("Checks: passed; what they printed is not in this reply.");
  });
});

describe("trusting an acceptance", () => {
  let local: Run;
  beforeAll(async () => {
    local = await runLocally(pretradeCheck({ quote, registry, mandate: MANDATE, trade }));
  }, 60_000);
  const id = `0x${"ab".repeat(32)}`;
  const status = `${DEFAULT_DESK}/x402/grades/${id}`;
  const verdict = (): Verdict => ({ grade: id, state: "graded", status, accepted: true, checks: { language: "python", outcome: "passed", output: local.output } });

  it("holds only for the grade paid for, from the desk, on the same passing rules", () => {
    expect(untrustedReasons({ id, status, verdict: verdict() }, local, DEFAULT_DESK, local.output)).toEqual([]);
  });

  it.each([
    ["not accepted", (v: Verdict) => ({ ...v, accepted: undefined }), "BrainChain did not accept the trade"],
    ["another grade", (v: Verdict) => ({ ...v, grade: `0x${"cd".repeat(32)}` }), "the verdict is for grade"],
    ["another status", (v: Verdict) => ({ ...v, status: "https://evil.test/x402/grades/x" }), "the verdict names https://evil.test/x402/grades/x as its status"],
    ["failed checks", (v: Verdict) => ({ ...v, checks: { language: "python", outcome: "failed" as const } }), "BrainChain's run of the checks failed"],
  ])("fails for a verdict %s", (_case, change, problem) => {
    expect(untrustedReasons({ id, status, verdict: change(verdict()) }, local, DEFAULT_DESK, local.output).join("; ")).toContain(problem);
  });

  it("fails when the run here failed, BrainChain printed other rules, or printed nothing to compare", () => {
    expect(untrustedReasons({ id, status, verdict: verdict() }, { ...local, outcome: "failed" }, DEFAULT_DESK, local.output)).toEqual(["the checks did not pass here"]);
    expect(untrustedReasons({ id, status, verdict: verdict() }, local, DEFAULT_DESK, local.output.replace("pass  recipient", "pass  recipient (forged)"))).toEqual(["BrainChain's run printed other rule lines than the run here"]);
    expect(untrustedReasons({ id, status, verdict: verdict() }, local, DEFAULT_DESK, undefined)).toEqual(["what BrainChain's run printed is in neither its reply nor its record"]);
    expect(untrustedReasons({ id, status: `https://evil.test/x402/grades/${id}`, verdict: { ...verdict(), status: `https://evil.test/x402/grades/${id}` } }, local, DEFAULT_DESK, local.output)).toHaveLength(1);
  });
});

describe("the command line's exit codes", { timeout: 90_000 }, () => {
  // The mandate's address, so 0x's recorded signature over the recorded query still verifies. Nothing here checks
  // the payments it signs.
  const account = { ...privateKeyToAccount(generatePrivateKey()), address: MANDATE.wallet };
  const tokens = { "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168": { decimals: 6, symbol: "USDG", balanceOf: 21_639_954n }, "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73": { decimals: 18, symbol: "WETH" } };
  const robinhood = node({ ...tokens, "0x00000000000004533Fe15556B1E086BB1A72cEae": { ownerOf: registry.settler, prev: registry.previous } }, { block: registry.block, balance: 298_803_918_768_000n });
  const base = (usdc: bigint) => node({ [USDC_BASE]: { balanceOf: usdc } });
  const challenge = (accepts: Record<string, unknown>[]) => ({ "payment-required": Buffer.from(JSON.stringify({ x402Version: 2, resource: { url: "https://x.test/" }, accepts })).toString("base64") });
  const usdc = { scheme: "exact", network: "eip155:8453", asset: GRADE_PAYMENT.asset, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } };
  let local: Run;
  beforeAll(async () => {
    local = await runLocally(pretradeCheck({ quote, registry, mandate: MANDATE, trade }));
  }, 60_000);

  /** 0x's gateway answering with the recorded quote, and a desk answering the paid grade with `grade`. */
  function setup(grade: (id: string) => Response, options: { extra?: Record<string, () => Response>; usdc?: bigint; chain?: typeof robinhood } = {}) {
    const calls: string[] = [];
    const lines: string[] = [];
    const errors: string[] = [];
    const quoteUrl = `${GATEWAY}${quoteQuery(tradeOf(MANDATE, MANDATE.wallet, { sell: "USDG", buy: "WETH", amount: "5", slippage: "50" }))}`;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const paid = Object.keys((init?.headers as Record<string, string>) ?? {}).includes("PAYMENT-SIGNATURE");
      calls.push(`${init?.method ?? "GET"} ${url}${paid ? " paid" : ""}`);
      if (url === quoteUrl) {
        if (!paid) return new Response("{}", { status: 402, headers: challenge([{ ...usdc, amount: "10000", payTo: "0xb15a55e85FdF5edc41B6c1eaf7813e2c6e6def59" }]) });
        const { response } = quote;
        return new Response(response.body, { headers: { "content-type": response.contentType, "content-digest": response.contentDigest, "signature-input": response.signatureInput, signature: response.signature } });
      }
      if (url === `${DEFAULT_DESK}/x402/grades` && init?.method === "POST") {
        if (!paid) return new Response("{}", { status: 402, headers: challenge([{ ...usdc, amount: "250000", payTo: GRADE_PAYMENT.payTo }]) });
        const header = (init.headers as Record<string, string>)["PAYMENT-SIGNATURE"]!;
        return grade(gradeId(JSON.parse(Buffer.from(header, "base64").toString("utf8")).payload));
      }
      const route = options.extra?.[url];
      return route ? route() : new Response("{}", { status: 404 });
    }) as typeof fetch;
    const io: Io = {
      log: (l) => lines.push(l),
      error: (l) => errors.push(l),
      fetch: fetchImpl,
      now: () => quote.receivedAt * 1000,
      env: {},
      connect: async (chainId) => (chainId === 8453 ? base(options.usdc ?? 1_000_000n) : (options.chain ?? robinhood)),
      account: async () => account,
      pollMs: 1,
    };
    return { io, calls, lines, errors, out: () => lines.join("\n") };
  }
  const paidArgs = ["--mandate", MANDATE_FILE, "--sell", "USDG", "--buy", "WETH", "--amount", "5", "--slippage-bps", "50"];
  const view = (id: string, extra: Partial<Verdict> = {}): Verdict => ({
    grade: id,
    state: "graded",
    status: `${DEFAULT_DESK}/x402/grades/${id}`,
    accepted: true,
    passProbability: 0.9,
    bar: 0.8,
    checks: { language: "python", outcome: "passed", output: local.output },
    decision: { id: "2001", record: `${DEFAULT_DESK}/records/0x${"0".repeat(64)}.json` },
    ...extra,
  });
  const mandateFile = async (name: string, change: object) => {
    const dir = await mkdtemp(join(tmpdir(), "mandate-"));
    await writeFile(join(dir, name), JSON.stringify({ ...MANDATE, ...change }));
    return join(dir, name);
  };

  it("exits 0 with the trade as BrainChain's run printed it, and both transactions ready to sign", async () => {
    const s = setup((id) => Response.json(view(id)));
    expect(await run(paidArgs, s.io)).toBe(0);
    expect(s.out()).toContain(`ok    checks: ${checksFor(MANDATE).length.toLocaleString("en-US")} characters of the grade route's 32,000; template SHA-256 ${sha256(CHECKS_TEMPLATE)}, mandate SHA-256 ${sha256(mandateText(MANDATE))}`);
    expect(s.out()).toContain("ok    tokens: as on chain: USDG, 6 decimals; WETH, 18 decimals; ETH, the native token, 18 decimals");
    expect(s.out()).toContain("ok    funds: 0xd937E50Ee21E66f7640F1a7887399e63055290fe holds 1 USDC on Base, enough for 3 checks");
    expect(s.out()).toContain("Checks: passed. BrainChain's run printed:\n  Trade: sell 5 USDG for at least 0.003072049707352334 WETH (0x quoted 0.003087487143067672 WETH)");
    expect(s.out()).toContain("  pass  recipient: pays 0xd937e50ee21e66f7640f1a7887399e63055290fe\n  pass  fees: no fee but 0x's own\n");
    expect(s.out()).toContain("  13 of 13 rules pass.");
    expect(s.out()).toContain(`First sign this approval, which lets AllowanceHolder take exactly 5 USDG for this trade:\n${JSON.stringify(toSign(quote, 4663).approve, null, 2)}`);
    expect(s.out()).toContain('Then sign the trade on Robinhood Chain, from 0xd937E50Ee21E66f7640F1a7887399e63055290fe.');
    expect(s.out()).toContain('  "chainId": 4663\n}');
    expect(s.errors).toEqual([]);
  });

  it("exits 0 for an acceptance read later, with what the checks printed taken from the record", async () => {
    const request = pretradeCheck({ quote, registry, mandate: MANDATE, trade });
    const record = recordOf(request, local);
    const s = setup((id) => Response.json({ grade: id, state: "paid", status: `${DEFAULT_DESK}/x402/grades/${id}` }, { status: 202 }), { extra: { [record.url]: () => new Response(record.bytes) } });
    const status = `${DEFAULT_DESK}/x402/grades/`;
    const polled = s.io.fetch;
    s.io.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith(status)) return Response.json(view(url.slice(status.length), { checks: { language: "python", outcome: "passed" }, decision: { id: "2002", record: record.url } }));
      return polled(input, init);
    }) as typeof fetch;
    expect(await run(paidArgs, s.io)).toBe(0);
    expect(s.out()).toContain("Then sign the trade");
  });

  it("exits 2 for a refusal, and prints no transaction", async () => {
    const s = setup((id) => Response.json(view(id, { accepted: false, passProbability: 0.1 })));
    expect(await run(paidArgs, s.io)).toBe(2);
    expect(s.out()).toContain("Do not sign this trade. Nothing was sent.");
    expect(s.out()).not.toContain("sign the trade on");
  });

  it("exits 1 for an acceptance it cannot trust", async () => {
    const s = setup((id) => Response.json(view(id, { checks: { language: "python", outcome: "passed", output: local.output.replace("pass  size", "pass  size (forged)") } })));
    expect(await run(paidArgs, s.io)).toBe(1);
    expect(s.errors[0]).toBe("BrainChain's acceptance cannot be acted on: BrainChain's run printed other rule lines than the run here. Do not sign this trade.");
  });

  it("exits 2 before paying anyone for a trade the mandate refuses", async () => {
    const s = setup(() => Response.json({}));
    expect(await run(paidArgs.map((a) => (a === "5" ? "30" : a)), s.io)).toBe(2);
    expect(s.errors).toEqual(["The mandate lets one trade sell at most 25 USDG, not 30."]);
    expect(s.calls).toEqual([]);
  });

  it("exits 2 for a mandate that has run out, naming its file", async () => {
    const file = await mandateFile("old.json", { validUntil: "2026-11-01T00:00:00Z" });
    const s = setup(() => Response.json({}));
    expect(await run(paidArgs.map((a) => (a === MANDATE_FILE ? file : a)), s.io)).toBe(2);
    expect(s.errors).toEqual(["The mandate old.json ran out at 2026-11-01T00:00:00Z."]);
  });

  it("exits 2 before paying BrainChain when the checks fail here, showing the trade they read", async () => {
    const file = await mandateFile("elsewhere.json", { recipient: "0x000000000000000000000000000000000000dEaD" });
    const s = setup(() => Response.json({}));
    expect(await run(paidArgs.map((a) => (a === MANDATE_FILE ? file : a)), s.io)).toBe(2);
    expect(s.errors[0]).toMatch(/^The checks refuse this trade here, before BrainChain is paid:\nTrade: sell 5 USDG for at least/);
    expect(s.errors[0]).toContain("\nFAIL  recipient: pays 0xd937e50ee21e66f7640f1a7887399e63055290fe, not the mandate's recipient 0x000000000000000000000000000000000000dead\n12 of 13 rules pass; failed: recipient.\n0x was paid 0.01 USDC for the quote; nothing was paid to BrainChain.");
    expect(s.calls.filter((c) => c.includes("/x402/grades"))).toEqual([]);
  });

  it("exits 1 before paying anyone when the wallet's USDC on Base is short, or the chain contradicts the mandate", async () => {
    const poor = setup(() => Response.json({}), { usdc: 200_000n });
    expect(await run(paidArgs, poor.io)).toBe(1);
    expect(poor.errors[0]).toContain("holds 0.2 USDC on Base, and a check takes 0.26: 0.01 to 0x and 0.25 to BrainChain. Add 0.06 USDC on Base.");
    const odd = setup(() => Response.json({}), { chain: node({ ...tokens, "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73": { decimals: 8, symbol: "WETH" } }) });
    expect(await run(paidArgs, odd.io)).toBe(1);
    expect(odd.errors[0]).toBe("The mandate mandate.json gives WETH 18 decimals; the token at 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73 on chain 4663 has 8.");
    expect([...poor.calls, ...odd.calls]).toEqual([]);
  });

  it.each([
    [["--sell", "USDG", "--buy", "WETH", "--amount", "5"], "Name the mandate with --mandate <file>: a paid check never uses the sample one. Nothing was paid."],
    [["--mandate", MANDATE_FILE, "--sell", "USDG", "--buy", "WETH", "--amount", "0"], "--amount must be more than 0."],
    [["--mandate", MANDATE_FILE, "--sell", "USDG", "--buy", "usdg", "--amount", "5"], "--sell and --buy are both USDG."],
    [["--mandate", MANDATE_FILE, "--sell", "USDG", "--buy", "WETH", "--amount", "5.0000001"], "--amount has more decimals than USDG's 6."],
    [["--sample", "--amount", "5"], "--sample checks the recorded quotes against the sample mandate, so it takes no --amount."],
    [["--quote"], "--quote goes with --sample."],
    [["--frobnicate"], "Unknown option '--frobnicate'"],
  ])("exits 1 for malformed input %j", async (argv, message) => {
    const s = setup(() => Response.json({}));
    expect(await run(argv, s.io)).toBe(1);
    expect(s.errors[0]).toContain(message);
    expect(s.calls).toEqual([]);
  });

  it.each([["--help"], ["-h"]])("exits 0 for %s", async (flag) => {
    const s = setup(() => Response.json({}));
    expect(await run([flag], s.io)).toBe(0);
    expect(s.out()).toContain("Exit codes: 0 accepted, with the transactions to sign; 2 the mandate refuses the trade, here or on BrainChain;");
  });

  it("reads Base through BASE_RPC or its public node, never through CHAIN_RPC", async () => {
    const s = setup((id) => Response.json(view(id)));
    const asked: [number, string | undefined, string][] = [];
    const connect = s.io.connect;
    s.io.env = { CHAIN_RPC: "https://robinhood.example" };
    s.io.connect = async (chainId, rpc, variable) => {
      asked.push([chainId, rpc, variable]);
      return connect(chainId, rpc, variable);
    };
    expect(await run(paidArgs, s.io)).toBe(0);
    expect(asked).toEqual([
      [4663, "https://robinhood.example", "CHAIN_RPC"],
      [8453, undefined, "BASE_RPC"],
    ]);
  });

  it("names the key's variable when its file is missing", async () => {
    await expect(loadAccount("/nowhere/agent.key")).rejects.toThrow("BRAINCHAIN_PAYER_KEY_FILE names /nowhere/agent.key, which does not exist.");
  });
});

describe("a dry run", { timeout: 90_000 }, () => {
  const tokens = { "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168": { decimals: 6, symbol: "USDG", balanceOf: 21_639_954n }, "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73": { decimals: 18, symbol: "WETH" } };
  const offer = Buffer.from(JSON.stringify({ x402Version: 2, accepts: [{ network: "eip155:8453", asset: GRADE_PAYMENT.asset, amount: "250000" }, { network: "eip155:4663", asset: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", amount: "250000" }, { network: "eip155:4663", asset: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", amount: "250000" }] })).toString("base64");
  function setup(route: () => Response = () => new Response("{}", { status: 402, headers: { "payment-required": offer } })) {
    const lines: string[] = [];
    const errors: string[] = [];
    const calls: string[] = [];
    const io: Io = {
      log: (l) => lines.push(l),
      error: (l) => errors.push(l),
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${String(input)}${Object.keys((init?.headers as Record<string, string>) ?? {}).includes("PAYMENT-SIGNATURE") ? " paid" : ""}`);
        return route();
      }) as typeof fetch,
      now: () => quote.receivedAt * 1000,
      env: {},
      connect: async (chainId) => (chainId === 8453 ? node({ [USDC_BASE]: { balanceOf: 300_000n } }) : node(tokens, { balance: 298_803_918_768_000n })),
      account: async () => {
        throw new Error("a dry run reads no key");
      },
    };
    return { io, lines, errors, calls, out: () => lines.join("\n") };
  }

  it("checks everything free, with no key, pays nothing and exits 0", async () => {
    const s = setup();
    expect(await run(["--dry", "--mandate", MANDATE_FILE, "--sell", "USDG", "--buy", "WETH", "--amount", "5"], s.io)).toBe(0);
    for (const step of ["mandate", "trade", "checks", "node", "tokens", "holds", "gas", "funds", "route"]) expect(s.out()).toMatch(new RegExp(`^ {2}ok {4}${step}: `, "m"));
    expect(s.out()).toContain("ok    gas: 0xd937E50Ee21E66f7640F1a7887399e63055290fe holds 0.000298803918768 ETH on chain 4663, about 0.0000135 needed for the gas of the approval and the trade");
    expect(s.out()).toContain("ok    route: BrainChain would grade this request for 0.25 USDC on Base, 0.25 USDG on Robinhood Chain");
    expect(s.out()).toContain("  13 of 13 rules pass.");
    expect(s.out()).toContain("Nothing was paid.");
    expect(s.calls).toEqual([`POST ${DEFAULT_DESK}/x402/grades`]);
    expect(s.errors).toEqual([]);
  });

  it.each([
    [["--amount", "5"], "--dry checks a trade with all of --sell, --buy and --amount, or none of them; --sell and --buy are missing."],
    [["--sell", "USDG", "--buy", "WETH"], "--dry checks a trade with all of --sell, --buy and --amount, or none of them; --amount is missing."],
    [["--slippage-bps", "50"], "--dry checks a trade with all of --sell, --buy and --amount, or none of them; --sell, --buy and --amount are missing."],
  ])("says exactly which trade flags are missing for %j", async (flags, message) => {
    const s = setup();
    expect(await run(["--dry", "--mandate", MANDATE_FILE, ...flags], s.io)).toBe(1);
    expect(s.errors).toEqual([message]);
  });

  it("checks the mandate alone when no trade is given", async () => {
    const s = setup();
    expect(await run(["--dry", "--mandate", MANDATE_FILE], s.io)).toBe(0);
    expect(s.out()).toContain("skip  trade: give --sell, --buy and --amount to check a trade too");
  });

  it("exits 2 for a trade the mandate refuses, and 1 when the route would not take the request", async () => {
    const s = setup();
    expect(await run(["--dry", "--mandate", MANDATE_FILE, "--sell", "USDG", "--buy", "WETH", "--amount", "26"], s.io)).toBe(2);
    const closed = setup(() => Response.json({ error: "brief must be 1 to 32,000 characters." }, { status: 400 }));
    expect(await run(["--dry", "--mandate", MANDATE_FILE], closed.io)).toBe(1);
    expect(closed.errors[0]).toContain("BrainChain's grade route answered 400");
  });
});
