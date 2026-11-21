import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";
import { createPublicClient, custom, encodeFunctionResult, numberToHex, parseAbi, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { DEFAULT_DESK, GRADE_PAYMENT, gradeId, type Verdict } from "../src/desk.ts";
import { describeTrade, distrust, Refusal, report, run, toSign, tradeOf, unfillable, type Io } from "../src/main.ts";
import { CHECKS_TEMPLATE, mandateText, pretradeCheck, sha256 } from "../src/request.ts";
import { runLocally, type Run } from "../src/sandbox.ts";
import { GATEWAY, quoteQuery, type SignedQuote } from "../src/zerox.ts";

import { MANDATE, MANDATE_FILE, read, recorded, recordOf } from "./helpers.ts";

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

describe("after the verdict", () => {
  const body = JSON.parse(quote.response.body);
  const withBody = (change: (b: typeof body) => void): SignedQuote => {
    const copy = structuredClone(body);
    change(copy);
    return { ...quote, response: { ...quote.response, body: JSON.stringify(copy) } };
  };

  it("gives the approval and the transaction 0x quoted, unchanged", () => {
    expect(toSign(quote)).toEqual({
      approve: { token: body.sellToken, spender: "0x0000000000001fF3684f28c67538d4D072C22734", amount: "5000000" },
      transaction: { to: body.transaction.to, data: body.transaction.data, value: "0", gas: body.transaction.gas, gasPrice: body.transaction.gasPrice },
    });
  });

  it("refuses an approval to anyone but AllowanceHolder, and gas over its cap", () => {
    expect(() => toSign(withBody((b) => (b.issues.allowance.spender = "0x000000000000000000000000000000000000dEaD")))).toThrow("0x asks for an approval to 0x000000000000000000000000000000000000dEaD, not to AllowanceHolder");
    expect(() => toSign(withBody((b) => (b.transaction.gasPrice = "1000000000000")))).toThrow("The transaction may cost 0.254397 ETH in gas, over this client's 0.0001. Ask for a new quote.");
  });

  it("names the rules a refused trade broke", () => {
    const refused = measured.runs.find((r) => r.case === "outside")!;
    const lines = report({ ...refused, status: "" });
    expect(lines[0]).toMatch(/^Refused: pass probability 0%, bar 80%/);
    expect(lines).toContain("FAIL  tokens: sells USDG; buys 0x42b96dbc55e79e930d866c1ee486a342366546bc, which the mandate does not list");
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
    expect(distrust({ id, status, verdict: verdict() }, local, DEFAULT_DESK, local.output)).toEqual([]);
  });

  it.each([
    ["not accepted", (v: Verdict) => ({ ...v, accepted: undefined }), "BrainChain did not accept the trade"],
    ["another grade", (v: Verdict) => ({ ...v, grade: `0x${"cd".repeat(32)}` }), "the verdict is for grade"],
    ["another status", (v: Verdict) => ({ ...v, status: "https://evil.test/x402/grades/x" }), "the verdict names https://evil.test/x402/grades/x as its status"],
    ["failed checks", (v: Verdict) => ({ ...v, checks: { language: "python", outcome: "failed" as const } }), "BrainChain's run of the checks failed"],
  ])("fails for a verdict %s", (_case, change, problem) => {
    expect(distrust({ id, status, verdict: change(verdict()) }, local, DEFAULT_DESK, local.output).join("; ")).toContain(problem);
  });

  it("fails when the run here failed, BrainChain printed other rules, or printed nothing to compare", () => {
    expect(distrust({ id, status, verdict: verdict() }, { ...local, outcome: "failed" }, DEFAULT_DESK, local.output)).toEqual(["the checks did not pass here"]);
    expect(distrust({ id, status, verdict: verdict() }, local, DEFAULT_DESK, local.output.replace("pass  recipient", "pass  recipient (forged)"))).toEqual(["BrainChain's run printed other rule lines than the run here"]);
    expect(distrust({ id, status, verdict: verdict() }, local, DEFAULT_DESK, undefined)).toEqual(["what BrainChain's run printed is in neither its reply nor its record"]);
    expect(distrust({ id, status: `https://evil.test/x402/grades/${id}`, verdict: { ...verdict(), status: `https://evil.test/x402/grades/${id}` } }, local, DEFAULT_DESK, local.output)).toHaveLength(1);
  });
});

describe("the command line's exit codes", { timeout: 90_000 }, () => {
  // The mandate's address, so 0x's recorded signature over the recorded query still verifies. Nothing here checks
  // the payments it signs.
  const account = { ...privateKeyToAccount(generatePrivateKey()), address: MANDATE.wallet };
  const abi = parseAbi(["function ownerOf(uint256) view returns (address)", "function prev(uint128) view returns (address)"]);
  const client = createPublicClient({
    transport: custom({
      async request({ method, params }: { method: string; params: unknown[] }) {
        if (method === "eth_blockNumber") return numberToHex(registry.block);
        const { data } = params[0] as { data: Hex };
        return data.startsWith("0x6352211e") ? encodeFunctionResult({ abi, functionName: "ownerOf", result: registry.settler }) : encodeFunctionResult({ abi, functionName: "prev", result: registry.previous });
      },
    }),
  });
  const challenge = (accepts: Record<string, unknown>[]) => ({ "payment-required": Buffer.from(JSON.stringify({ x402Version: 2, resource: { url: "https://x.test/" }, accepts })).toString("base64") });
  const usdc = { scheme: "exact", network: "eip155:8453", asset: GRADE_PAYMENT.asset, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } };
  let local: Run;
  beforeAll(async () => {
    local = await runLocally(pretradeCheck({ quote, registry, mandate: MANDATE, trade }));
  }, 60_000);

  /** 0x's gateway answering with the recorded quote, and a desk answering the paid grade with `grade`. */
  function setup(grade: (id: string) => Response, extra: Record<string, () => Response> = {}) {
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
      const route = extra[url];
      return route ? route() : new Response("{}", { status: 404 });
    }) as typeof fetch;
    const io: Io = { log: (l) => lines.push(l), error: (l) => errors.push(l), fetch: fetchImpl, now: () => quote.receivedAt * 1000, env: {}, connect: async () => client, account: async () => account, pollMs: 1 };
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

  it("exits 0 with the transaction for an acceptance it can trust", async () => {
    const s = setup((id) => Response.json(view(id)));
    expect(await run(paidArgs, s.io)).toBe(0);
    expect(s.out()).toContain(`Checks template SHA-256 ${sha256(CHECKS_TEMPLATE)}, mandate SHA-256 ${sha256(mandateText(MANDATE))}.`);
    expect(s.out()).toContain("Checks: passed, 13 of 13 rules pass.");
    expect(s.out()).toContain("First approve 0x0000000000001fF3684f28c67538d4D072C22734 (AllowanceHolder) to spend 5000000 base units");
    expect(s.out()).toContain("The transaction to sign on Robinhood Chain");
    expect(s.errors).toEqual([]);
  });

  it("exits 0 for an acceptance read later, with what the checks printed taken from the record", async () => {
    const request = pretradeCheck({ quote, registry, mandate: MANDATE, trade });
    const record = recordOf(request, local);
    const s = setup((id) => Response.json({ grade: id, state: "paid", status: `${DEFAULT_DESK}/x402/grades/${id}` }, { status: 202 }), { [record.url]: () => new Response(record.bytes) });
    const status = `${DEFAULT_DESK}/x402/grades/`;
    const polled = s.io.fetch;
    s.io.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith(status)) return Response.json(view(url.slice(status.length), { checks: { language: "python", outcome: "passed" }, decision: { id: "2002", record: record.url } }));
      return polled(input, init);
    }) as typeof fetch;
    expect(await run(paidArgs, s.io)).toBe(0);
    expect(s.out()).toContain("The transaction to sign");
  });

  it("exits 2 for a refusal, and prints no transaction", async () => {
    const s = setup((id) => Response.json(view(id, { accepted: false, passProbability: 0.1 })));
    expect(await run(paidArgs, s.io)).toBe(2);
    expect(s.out()).toContain("Do not sign this trade. Nothing was sent.");
    expect(s.out()).not.toContain("The transaction to sign");
  });

  it("exits 1 for an acceptance it cannot trust", async () => {
    const s = setup((id) => Response.json(view(id, { checks: { language: "python", outcome: "passed", output: local.output.replace("pass  size", "pass  size (forged)") } })));
    expect(await run(paidArgs, s.io)).toBe(1);
    expect(s.errors[0]).toBe("BrainChain's acceptance cannot be acted on: BrainChain's run printed other rule lines than the run here. Do not sign this trade.");
    expect(s.out()).not.toContain("The transaction to sign");
  });

  it("exits 2 before paying anyone for what the inputs decide", async () => {
    const s = setup(() => Response.json({}));
    expect(await run(paidArgs.map((a) => (a === "5" ? "30" : a)), s.io)).toBe(2);
    expect(s.errors).toEqual(["The mandate lets one trade sell at most 25 USDG, not 30."]);
    expect(s.calls).toEqual([]);
  });

  it("exits 2 before paying BrainChain when the checks fail here", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mandate-"));
    const file = join(dir, "elsewhere.json");
    await writeFile(file, JSON.stringify({ ...MANDATE, recipient: "0x000000000000000000000000000000000000dEaD" }));
    const s = setup(() => Response.json({}));
    expect(await run(paidArgs.map((a) => (a === MANDATE_FILE ? file : a)), s.io)).toBe(2);
    expect(s.errors[0]).toContain("The checks refuse this trade here, before BrainChain is paid:\nFAIL  recipient: pays 0xd937e50ee21e66f7640f1a7887399e63055290fe, not the mandate's recipient 0x000000000000000000000000000000000000dead\n0x was paid 0.01 USDC for the quote; nothing was paid to BrainChain.");
    expect(s.calls.filter((c) => c.includes("/x402/grades"))).toEqual([]);
  });

  it.each([
    [["--sell", "USDG", "--buy", "WETH", "--amount", "5"], "--mandate names the mandate file. A paid check never falls back to the sample mandate."],
    [["--sample", "--amount", "5"], "--sample checks the recorded quotes against the sample mandate, so it takes no --amount."],
    [["--quote"], "--quote goes with --sample."],
    [["--frobnicate"], "Unknown option '--frobnicate'"],
  ])("exits 1 for %j", async (argv, message) => {
    const s = setup(() => Response.json({}));
    expect(await run(argv, s.io)).toBe(1);
    expect(s.errors[0]).toContain(message);
    expect(s.calls).toEqual([]);
  });

  it("exits 0 for --help", async () => {
    const s = setup(() => Response.json({}));
    expect(await run(["--help"], s.io)).toBe(0);
    expect(s.out()).toContain("Exit codes: 0 accepted, with the transaction to sign; 2 refused, do not sign; 1 the check did not finish.");
  });
});
