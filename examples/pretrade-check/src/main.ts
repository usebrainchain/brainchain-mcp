// Checks a trade through 0x against the agent's mandate before the agent signs it, and prints the transaction to
// sign only if BrainChain accepts it. Nothing here sends a transaction.
// Run: node src/main.ts --sell USDG --buy WETH --amount 5 [--slippage-bps 50] [--mandate mandate.json]
//      node src/main.ts --sample [--quote]
import { readdir, readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { formatUnits, getAddress, isAddress, parseUnits, type Address, type PrivateKeyAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { payGrade, priceOf, type Verdict } from "./desk.ts";
import { parseMandate, tokenOf, type Mandate } from "./mandate.ts";
import { pretradeCheck, type GradeRequest, type Registry } from "./request.ts";
import { runLocally } from "./sandbox.ts";
import { buyQuote, checkQuote, readSettlers, zeroxPayer, type SignedQuote, type Trade } from "./zerox.ts";

const CHAINS: Record<number, string> = { 4663: "Robinhood Chain", 8453: "Base" };
export const SAMPLE_MANDATE = fileURLToPath(new URL("../fixtures/mandate.json", import.meta.url));
const SAMPLES = fileURLToPath(new URL("../fixtures/quotes/", import.meta.url));

export interface Checked {
  quote: SignedQuote;
  registry: Registry;
  request: GradeRequest;
  verdict: Verdict;
  /** From sending the paid grade to reading its verdict. */
  ms: number;
}

/** The key that signs both payments. It is read from a file and never printed. */
export async function loadAccount(file = process.env.BRAINCHAIN_PAYER_KEY_FILE): Promise<PrivateKeyAccount> {
  if (!file) throw new Error("Set BRAINCHAIN_PAYER_KEY_FILE to a file holding the paying wallet's private key. It pays 0.01 USDC to 0x and 0.25 USDC to BrainChain on Base.");
  // As brainchain-mcp does: a key other accounts on the machine can read is a key they can spend.
  if (process.platform !== "win32" && ((await stat(file)).mode & 0o077) !== 0) throw new Error(`Other accounts can read ${file}. Run chmod 600 on it first.`);
  const key = (await readFile(file, "utf8")).trim().replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(key)) throw new Error("BRAINCHAIN_PAYER_KEY_FILE does not hold a 64-character hex private key.");
  return privateKeyToAccount(`0x${key}`);
}

export const describeTrade = (mandate: Mandate, trade: Trade): string => {
  const sell = tokenOf(mandate, trade.sellToken)!;
  const buy = tokenOf(mandate, trade.buyToken)?.symbol ?? trade.buyToken;
  return `sell ${formatUnits(trade.sellAmount, sell.decimals)} ${sell.symbol} for ${buy} on ${CHAINS[trade.chainId] ?? `chain ${trade.chainId}`}`;
};

/** The trade from the command line. The sell token must be one the mandate lists, so the amount can be read in whole tokens. */
export function tradeOf(mandate: Mandate, wallet: Address, args: { sell?: string; buy?: string; amount?: string; slippage?: string }): Trade {
  const sell = args.sell && tokenOf(mandate, args.sell);
  if (!sell) throw new Error(`--sell names a token the mandate lists: ${mandate.tokens.map((t) => t.symbol).join(", ")}.`);
  const buy = args.buy && (tokenOf(mandate, args.buy)?.address ?? (isAddress(args.buy, { strict: false }) ? getAddress(args.buy) : undefined));
  if (!buy) throw new Error("--buy names a token the mandate lists, or any token by its address.");
  if (!args.amount || !/^\d+(\.\d+)?$/.test(args.amount)) throw new Error(`--amount is how much ${sell.symbol} to sell, such as 5 or 0.5.`);
  const slippageBps = args.slippage === undefined ? undefined : Number(args.slippage);
  if (slippageBps !== undefined && (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000)) throw new Error("--slippage-bps is 0 to 10,000.");
  return { chainId: mandate.chain, sellToken: sell.address, buyToken: buy, sellAmount: parseUnits(args.amount, sell.decimals), taker: wallet, ...(slippageBps !== undefined ? { slippageBps } : {}) };
}

/** Buys the quote, checks it on arrival, reads the registry at its block, and pays BrainChain to grade it. */
export async function checkTrade(mandate: Mandate, trade: Trade, account: PrivateKeyAccount, log: (line: string) => void = console.log): Promise<Checked> {
  if (account.address.toLowerCase() !== mandate.wallet.toLowerCase()) throw new Error(`The mandate is for wallet ${mandate.wallet}, but the key is for ${account.address}.`);
  const quote = await buyQuote(trade, zeroxPayer(account));
  log(`0x quote bought for 0.01 USDC${quote.paymentTx ? ` (${quote.paymentTx})` : ""}.`);
  // A quote that is unsigned, signed by another key or already stale is never worth a grade.
  checkQuote(quote);
  const registry = await readSettlers(quote);
  const request = pretradeCheck({ quote, registry, mandate, trade: describeTrade(mandate, trade) });
  const started = Date.now();
  const verdict = await payGrade(request, account, { log });
  return { quote, registry, request, verdict, ms: Date.now() - started };
}

/** The transaction the agent may now sign, and the approval it needs first. */
export function toSign(quote: SignedQuote): { approve?: { token: string; spender: string; amount: string }; transaction: Record<string, string> } {
  const body = JSON.parse(quote.response.body) as {
    sellToken: string;
    sellAmount: string;
    issues?: { allowance?: { actual: string; spender: string } | null };
    transaction: { to: string; data: string; value: string; gas: string; gasPrice: string };
  };
  const allowance = body.issues?.allowance;
  const short = allowance && BigInt(allowance.actual) < BigInt(body.sellAmount);
  const { to, data, value, gas, gasPrice } = body.transaction;
  return { ...(short ? { approve: { token: body.sellToken, spender: allowance.spender, amount: body.sellAmount } } : {}), transaction: { to, data, value, gas, gasPrice } };
}

/** The verdict in a few lines, with the rules the checks failed. */
export function report(verdict: Verdict): string[] {
  const percent = (p?: number) => (p === undefined ? "?" : `${Math.round(p * 1000) / 10}%`);
  const failed = (verdict.checks?.output ?? "").split("\n").filter((line) => line.startsWith("FAIL"));
  return [
    `${verdict.accepted ? "Accepted" : "Refused"}: pass probability ${percent(verdict.passProbability)}, bar ${percent(verdict.bar)}${verdict.second ? `; second model ${verdict.second.model} at ${percent(verdict.second.passProbability)}` : ""}.`,
    `Checks: ${verdict.checks?.outcome ?? "not run"}${verdict.checks?.error ? ` (${verdict.checks.error})` : ""}.`,
    ...failed,
    `Decision ${verdict.decision?.id ?? "?"}: ${verdict.decision?.page ?? verdict.decision?.record ?? verdict.status}`,
  ];
}

/** The recorded quotes, checked on this machine as BrainChain's sandbox would: no wallet, nothing paid. */
async function samples(withPrice: boolean): Promise<void> {
  const mandate = parseMandate(JSON.parse(await readFile(SAMPLE_MANDATE, "utf8")));
  let priced = !withPrice;
  for (const name of (await readdir(SAMPLES)).filter((f) => f.endsWith(".json")).sort()) {
    const { trade, quote, registry } = JSON.parse(await readFile(`${SAMPLES}${name}`, "utf8")) as { trade: string; quote: SignedQuote; registry: Registry };
    const request = pretradeCheck({ quote, registry, mandate, trade });
    const run = await runLocally(request);
    console.log(`${name}: ${trade}\n${run.output.split("\nTraceback")[0]!.trim()}\n`);
    if (!priced) console.log(`The grade route ${await priceOf(request)}\n`);
    priced = true;
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      sell: { type: "string" },
      buy: { type: "string" },
      amount: { type: "string" },
      "slippage-bps": { type: "string" },
      mandate: { type: "string", default: SAMPLE_MANDATE },
      sample: { type: "boolean", default: false },
      quote: { type: "boolean", default: false },
    },
  });
  if (values.sample) return samples(values.quote);
  const mandate = parseMandate(JSON.parse(await readFile(values.mandate, "utf8")));
  if (Date.now() > Date.parse(mandate.validUntil)) throw new Error(`The mandate ran out at ${mandate.validUntil}.`);
  const account = await loadAccount();
  const trade = tradeOf(mandate, account.address, { sell: values.sell, buy: values.buy, amount: values.amount, slippage: values["slippage-bps"] });
  console.log(`Checking: ${describeTrade(mandate, trade)}, from ${account.address}.`);
  const { quote, verdict, ms } = await checkTrade(mandate, trade, account);
  console.log([...report(verdict), `Verdict in ${(ms / 1000).toFixed(1)} s.`].join("\n"));
  if (!verdict.accepted) {
    console.log("\nDo not sign this trade. Nothing was sent.");
    process.exitCode = 2;
    return;
  }
  if (Date.now() > Date.parse(mandate.validUntil)) throw new Error(`The mandate ran out at ${mandate.validUntil}, while the trade was graded. Do not sign it.`);
  const { approve, transaction } = toSign(quote);
  if (approve) console.log(`\nFirst approve ${approve.spender} (AllowanceHolder) to spend ${approve.amount} base units of ${approve.token}.`);
  console.log(`\nThe transaction to sign on ${CHAINS[mandate.chain] ?? `chain ${mandate.chain}`}, from ${mandate.wallet}. It reverts rather than pay out less than the checked minimum:\n${JSON.stringify(transaction, null, 2)}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
