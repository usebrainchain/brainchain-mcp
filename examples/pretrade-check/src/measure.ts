// Runs the measured cases with real payments and adds each to measured.json, with its delivery in fixtures/quotes.
// Each case costs 0.01 USDC to 0x and 0.25 USDC to BrainChain, on Base; the tampered one reuses a bought quote.
// Run: BRAINCHAIN_PAYER_KEY_FILE=... node src/measure.ts <case>...
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { payGrade, type Verdict } from "./desk.ts";
import { checkTrade, describeTrade, loadAccount, SAMPLE_MANDATE, tradeOf } from "./main.ts";
import { parseMandate, type Mandate } from "./mandate.ts";
import { pretradeCheck, type Registry } from "./request.ts";
import type { SignedQuote } from "./zerox.ts";

const MEASURED = fileURLToPath(new URL("../measured.json", import.meta.url));
const QUOTES = fileURLToPath(new URL("../fixtures/quotes/", import.meta.url));
const BRAIN = "0x42b96dbc55e79E930d866c1eE486A342366546BC";

interface Case {
  name: string;
  what: string;
  expected: string;
  trade?: { sell: string; buy: string; amount: string; slippage: string };
  /** A case made from another case's delivery instead of a new quote. */
  from?: string;
}

export const CASES: Case[] = [
  { name: "inside", what: "Sell 5 USDG for WETH at 50 bps slippage, inside every rule", expected: "accepted", trade: { sell: "USDG", buy: "WETH", amount: "5", slippage: "50" } },
  { name: "native", what: "Sell 0.001 ETH for USDG at 50 bps slippage, inside every rule", expected: "accepted", trade: { sell: "ETH", buy: "USDG", amount: "0.001", slippage: "50" } },
  { name: "outside", what: "Sell 5 USDG for BRAIN, a token the mandate does not list", expected: "refused: tokens", trade: { sell: "USDG", buy: BRAIN, amount: "5", slippage: "50" } },
  { name: "minimum", what: "Sell 5 USDG for WETH at 300 bps slippage, a minimum out the mandate's 100 bps does not allow", expected: "refused: minimum out", trade: { sell: "USDG", buy: "WETH", amount: "5", slippage: "300" } },
  { name: "size", what: "Sell 30 USDG for WETH, over the mandate's 25 USDG", expected: "refused: size", trade: { sell: "USDG", buy: "WETH", amount: "30", slippage: "50" } },
  { name: "tampered", what: "The inside quote with one byte of its route changed and its Content-Digest recomputed", expected: "refused: signature", from: "inside" },
];

/**
 * Rewrites one byte inside the Settler actions, the route, in the body as sent, and recomputes the body's digest:
 * every mandate rule still holds, so only 0x's signature can catch it.
 */
export function tamperRoute(quote: SignedQuote): SignedQuote {
  const { body } = quote.response;
  const start = body.indexOf('"data":"0x') + '"data":"0x'.length;
  const end = body.indexOf('"', start);
  // Past exec's head and Settler's slippage words, inside the actions.
  const at = start + Math.floor((end - start) / 2);
  const nibble = (parseInt(body[at]!, 16) + 1) % 16;
  const changed = `${body.slice(0, at)}${nibble.toString(16)}${body.slice(at + 1)}`;
  const digest = `sha-256=:${createHash("sha256").update(changed, "utf8").digest("base64")}:`;
  return { ...quote, response: { ...quote.response, body: changed, contentDigest: digest } };
}

const summary = (verdict: Verdict, ms: number) => ({
  grade: verdict.grade,
  accepted: verdict.accepted,
  passProbability: verdict.passProbability,
  bar: verdict.bar,
  confidence: verdict.confidence,
  levels: verdict.levels?.map((l) => l.probability),
  second: verdict.second,
  checks: verdict.checks,
  decision: verdict.decision,
  paymentTx: verdict.paymentTx,
  secondsToVerdict: Math.round(ms / 100) / 10,
});

async function measure(c: Case, mandate: Mandate): Promise<Record<string, unknown>> {
  const account = await loadAccount();
  if (c.from) {
    const { trade, quote, registry } = JSON.parse(await readFile(`${QUOTES}${c.from}.json`, "utf8")) as { trade: string; quote: SignedQuote; registry: Registry };
    const tampered = tamperRoute(quote);
    const started = Date.now();
    const verdict = await payGrade(pretradeCheck({ quote: tampered, registry, mandate, trade }), account, { log: console.log });
    await writeFile(`${QUOTES}${c.name}.json`, `${JSON.stringify({ trade, quote: tampered, registry }, null, 1)}\n`);
    return { case: c.name, what: c.what, expected: c.expected, trade, cost: "0.25 USDC", ...summary(verdict, Date.now() - started) };
  }
  const trade = tradeOf(mandate, account.address, c.trade!);
  const { quote, registry, verdict, ms } = await checkTrade(mandate, trade, account);
  await writeFile(`${QUOTES}${c.name}.json`, `${JSON.stringify({ trade: describeTrade(mandate, trade), quote, registry }, null, 1)}\n`);
  return { case: c.name, what: c.what, expected: c.expected, trade: describeTrade(mandate, trade), quotePaymentTx: quote.paymentTx, cost: "0.26 USDC", ...summary(verdict, ms) };
}

async function main(): Promise<void> {
  const names = process.argv.slice(2);
  const chosen = names.map((name) => CASES.find((c) => c.name === name) ?? (() => { throw new Error(`No case ${name}: ${CASES.map((c) => c.name).join(", ")}.`); })());
  if (chosen.length === 0) throw new Error(`Name the cases to run: ${CASES.map((c) => c.name).join(", ")}.`);
  const mandate = parseMandate(JSON.parse(await readFile(SAMPLE_MANDATE, "utf8")));
  await mkdir(QUOTES, { recursive: true });
  const measured = JSON.parse(await readFile(MEASURED, "utf8").catch(() => "null")) ?? {
    measured: new Date().toISOString().slice(0, 10),
    gateway: "https://agent.api.0x.org/v1/x402/swap-allowance-holder-quote/",
    route: "https://brain.usebrainchain.com/x402/grades",
    price: "0.01 USDC to 0x per quote and 0.25 USDC to BrainChain per grade, both on Base",
    mandate,
    runs: [],
  };
  for (const c of chosen) {
    console.log(`\n${c.name}: ${c.what}`);
    const run = await measure(c, mandate);
    measured.runs.push({ at: new Date().toISOString(), ...run });
    await writeFile(MEASURED, `${JSON.stringify(measured, null, 2)}\n`);
    const { checks, ...shown } = run as { checks?: Verdict["checks"] };
    console.log(JSON.stringify(shown, null, 1));
    console.log(checks?.output ?? "");
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
