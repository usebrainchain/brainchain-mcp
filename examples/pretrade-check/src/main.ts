// Checks a trade through 0x against the agent's mandate before the agent signs it, and prints the transaction to
// sign only if BrainChain accepts it. Nothing here sends a transaction.
import { readdir, readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { encodeFunctionData, erc20Abi, formatEther, formatUnits, getAddress, isAddress, parseUnits, type PrivateKeyAccount, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { deskUrl, payGrade, priceOf, type Paid, type Verdict } from "./desk.ts";
import { parseMandate, readMandate, tokenOf, type Mandate } from "./mandate.ts";
import { checksFor, CHECKS_TEMPLATE, mandateText, MAX_CHECKS, pretradeCheck, sha256, type GradeRequest, type Registry } from "./request.ts";
import { checkFunds, checkGas, checkHolding, checkTokens } from "./preflight.ts";
import { ruleLines, runLines, runLocally, type Run } from "./sandbox.ts";
import { listOf, same } from "./shared.ts";
import { fetchRecord, recordState } from "./verify.ts";
import { ALLOWANCE_HOLDER, buyQuote, checkQuote, connect, RPCS, readSettlers, zeroxPayer, type SignedQuote, type Trade } from "./zerox.ts";

const CHAINS: Record<number, string> = { 4663: "Robinhood Chain", 8453: "Base" };
export const SAMPLE_MANDATE = fileURLToPath(new URL("../fixtures/mandate.json", import.meta.url));
const SAMPLES = fileURLToPath(new URL("../fixtures/quotes/", import.meta.url));
const BASE = 8453;
/** 0x's placeholder for a chain's native token. */
const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
/** The most gas a transaction printed here may cost, at 0x's gas price: about 15 times what the measured quotes cost. */
export const MAX_GAS_COST = 100_000_000_000_000n;

export const USAGE = `Checks a trade through 0x against a mandate before the wallet signs it.

  npm run check -- --dry --mandate <file> [--sell <token> --buy <token> --amount <n>]
  npm run check -- --mandate <file> --sell <token> --buy <token> --amount <n> [--slippage-bps <n>]
  npm run check -- --sample [--quote]
  npm run verify -- <decision id, decision page, grade id or record URL> --mandate <file>

  --mandate <file>      the mandate, a JSON file; required for --dry and a paid check
  --sell <token>        a token the mandate lists and lets be sold, by symbol or address
  --buy <token>         a token the mandate lists, by symbol or address
  --amount <n>          how much to sell, in whole tokens, such as 5 or 0.5
  --slippage-bps <n>    0x's slippage tolerance, at most the mandate's maxSlippageBps; 0x's default is 100
  --dry                 run every free check; needs no key
  --sample              check the recorded quotes here: no wallet, nothing paid
  --quote               with --sample, also ask the grade route its price, without paying
  -h, --help            this text

A paid check reads the wallet's key from the file BRAINCHAIN_PAYER_KEY_FILE names. CHAIN_RPC replaces the public
node for the mandate's chain, BASE_RPC the one for Base, and BRAINCHAIN_DESK_URL BrainChain's desk.

Exit codes: 0 accepted, with the transactions to sign; 2 the mandate refuses the trade, here or on BrainChain;
1 anything else, such as malformed input or a check that did not finish.`;

/** A trade the mandate refuses, here or in BrainChain's run of its checks. The process exits 2. */
export class Refusal extends Error {}

export interface Io {
  log: (line: string) => void;
  error: (line: string) => void;
  fetch: typeof fetch;
  /** Milliseconds, as Date.now. */
  now: () => number;
  env: Record<string, string | undefined>;
  connect: (chainId: number, rpc: string | undefined, variable: string) => Promise<PublicClient>;
  account: (file: string | undefined) => Promise<PrivateKeyAccount>;
  /** Between reads of a grade still being decided. */
  pollMs?: number;
}

const defaultIo: Io = { log: console.log, error: console.error, fetch: (...args) => fetch(...args), now: Date.now, env: process.env, connect, account: (file) => loadAccount(file) };

export interface Checked {
  quote: SignedQuote;
  registry: Registry;
  request: GradeRequest;
  /** The checks as run here before BrainChain was paid. */
  local: Run;
  paid: Paid;
  /** From sending the paid grade to reading its verdict. */
  ms: number;
}

/** The key that signs both payments. It is read from a file and never printed. */
export async function loadAccount(file: string | undefined): Promise<PrivateKeyAccount> {
  if (!file) throw new Error("Set BRAINCHAIN_PAYER_KEY_FILE to a file holding the paying wallet's private key. It pays 0.01 USDC to 0x and 0.25 USDC to BrainChain on Base.");
  const mode = await stat(file).then(
    (s) => s.mode,
    (error: NodeJS.ErrnoException) => {
      throw new Error(`BRAINCHAIN_PAYER_KEY_FILE names ${file}, which ${error.code === "ENOENT" ? "does not exist" : `cannot be read (${error.code ?? error.message})`}.`, { cause: error });
    },
  );
  // As brainchain-mcp does: a key other accounts on the machine can read is a key they can spend.
  if (process.platform !== "win32" && (mode & 0o077) !== 0) throw new Error(`Other accounts can read ${file}. Run chmod 600 on it first.`);
  const key = (await readFile(file, "utf8")).trim().replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(key)) throw new Error("BRAINCHAIN_PAYER_KEY_FILE does not hold a 64-character hex private key.");
  return privateKeyToAccount(`0x${key}`);
}

const chainName = (id: number) => CHAINS[id] ?? `chain ${id}`;

export const describeTrade = (mandate: Mandate, trade: Trade): string => {
  const sell = tokenOf(mandate, trade.sellToken)!;
  const buy = tokenOf(mandate, trade.buyToken)?.symbol ?? trade.buyToken;
  return `sell ${formatUnits(trade.sellAmount, sell.decimals)} ${sell.symbol} for ${buy} on ${chainName(trade.chainId)}`;
};

/**
 * The trade from the command line. Whatever the inputs alone decide is refused here, before 0x is paid: a token the
 * mandate does not list, an amount over the token's `maxSell`, a slippage over the mandate's maximum.
 */
export function tradeOf(mandate: Mandate, wallet: `0x${string}`, args: { sell?: string; buy?: string; amount?: string; slippage?: string }): Trade {
  const listed = mandate.tokens.map((t) => t.symbol).join(", ");
  if (!args.sell || !args.buy || !args.amount) {
    const missing = (["sell", "buy", "amount"] as const).filter((name) => !args[name]).map((name) => `--${name}`);
    throw new Error(`A trade needs --sell, --buy and --amount; ${listOf(missing)} ${missing.length === 1 ? "is" : "are"} missing.`);
  }
  const sell = tokenOf(mandate, args.sell);
  if (!sell) throw new Refusal(`The mandate does not list ${args.sell}, so it cannot be sold. It lists ${listed}.`);
  const buy = tokenOf(mandate, args.buy);
  if (!buy) throw new Refusal(`The mandate does not list ${isAddress(args.buy, { strict: false }) ? getAddress(args.buy) : args.buy}, so it cannot be bought. It lists ${listed}.`);
  if (sell.address === buy.address) throw new Error(`--sell and --buy are both ${sell.symbol}.`);
  if (!/^\d+(\.\d+)?$/.test(args.amount)) throw new Error(`--amount is how much ${sell.symbol} to sell, such as 5 or 0.5.`);
  // parseUnits rounds away extra decimals, which would sell an amount nobody typed.
  if ((args.amount.split(".")[1]?.length ?? 0) > sell.decimals) throw new Error(`--amount has more decimals than ${sell.symbol}'s ${sell.decimals}.`);
  const sellAmount = parseUnits(args.amount, sell.decimals);
  if (sellAmount === 0n) throw new Error("--amount must be more than 0.");
  const most = parseUnits(sell.maxSell, sell.decimals);
  if (most === 0n) throw new Refusal(`The mandate lets ${sell.symbol} be bought, never sold.`);
  if (sellAmount > most) throw new Refusal(`The mandate lets one trade sell at most ${sell.maxSell} ${sell.symbol}, not ${args.amount}.`);
  if (args.slippage !== undefined && !/^\d+$/.test(args.slippage)) throw new Error("--slippage-bps is a whole number of basis points, 0 to 10,000.");
  const slippageBps = args.slippage === undefined ? undefined : Number(args.slippage);
  if (slippageBps !== undefined && slippageBps > 10_000) throw new Error("--slippage-bps is 0 to 10,000.");
  if ((slippageBps ?? 100) > mandate.maxSlippageBps) {
    throw new Refusal(`${slippageBps === undefined ? "0x's default slippage of 100" : `A slippage of ${slippageBps}`} basis points is over the mandate's ${mandate.maxSlippageBps}. Pass --slippage-bps ${mandate.maxSlippageBps} or less.`);
  }
  return { chainId: mandate.chain, sellToken: sell.address, buyToken: buy.address, sellAmount, taker: wallet, ...(slippageBps !== undefined ? { slippageBps } : {}) };
}

/** What a quote within the mandate can still fail on: 0x has no route for it, or the wallet cannot cover it. */
export function unfillable(quote: SignedQuote): string | undefined {
  const body = JSON.parse(quote.response.body) as { liquidityAvailable?: boolean; issues?: { balance?: { token: string; actual: string; expected: string } | null } };
  if (body.liquidityAvailable === false) return NO_LIQUIDITY;
  const short = body.issues?.balance;
  if (short) return `The wallet holds ${short.actual} base units of ${short.token}, and the trade needs ${short.expected}. The transaction would revert.`;
  return undefined;
}

const NO_LIQUIDITY = "0x found no liquidity for this trade.";

/**
 * Where a trade 0x found no liquidity for may belong instead: another chain this client knows a node for, on which
 * both its tokens are contracts too, as for a mandate whose chain was set by mistake.
 */
export async function noLiquidity(trade: Trade, io: Pick<Io, "connect">): Promise<string> {
  const here = `0x found no liquidity for this trade on ${chainName(trade.chainId)}, chain ${trade.chainId}.`;
  const tokens = [trade.sellToken, trade.buyToken].filter((token) => !same(token, NATIVE));
  for (const chainId of Object.keys(RPCS).map(Number).filter((id) => id !== trade.chainId)) {
    const client = await io.connect(chainId, undefined, "CHAIN_RPC").catch(() => undefined);
    const found = client && (await Promise.all(tokens.map((address) => client.getCode({ address }).then((code) => code !== undefined && code !== "0x", () => false))));
    if (found && tokens.length > 0 && found.every(Boolean)) return `${here} Both tokens are also contracts on ${chainName(chainId)}, chain ${chainId}: if the trade is meant for that chain, set chain to ${chainId} in the mandate.`;
  }
  return here;
}

/** Buys the quote, checks it on arrival and here, and pays BrainChain to grade it only if the checks pass here. */
export async function checkTrade(mandate: Mandate, trade: Trade, account: PrivateKeyAccount, client: PublicClient, desk: string, io: Io): Promise<Checked> {
  const quote = await buyQuote(trade, zeroxPayer(account), { fetch: io.fetch, now: io.now });
  const spent = `0x was paid 0.01 USDC for the quote${quote.paymentTx ? ` (${quote.paymentTx})` : ""}; nothing was paid to BrainChain.`;
  io.log(`0x quote bought for 0.01 USDC${quote.paymentTx ? ` (${quote.paymentTx})` : ""}.`);
  let registry: Registry;
  let request: GradeRequest;
  let local: Run;
  try {
    // A quote that is unsigned, signed by another key or already stale is never worth a grade.
    checkQuote(quote);
    const why = unfillable(quote);
    if (why) throw new Error(why === NO_LIQUIDITY ? await noLiquidity(trade, io) : why);
    registry = await readSettlers(quote, client);
    request = pretradeCheck({ quote, registry, mandate, trade: describeTrade(mandate, trade) });
    local = await runLocally(request);
  } catch (error) {
    const message = `${(error as Error).message} ${spent}`;
    throw error instanceof Refusal ? new Refusal(message, { cause: error }) : new Error(message, { cause: error });
  }
  if (local.outcome !== "passed") {
    const lines = runLines(local.output).filter((line) => !line.startsWith("pass"));
    throw new Refusal(`The checks refuse this trade here, before BrainChain is paid:\n${(lines.length ? lines : [local.error ?? local.outcome]).join("\n")}\n${spent}`);
  }
  io.log(`All ${ruleLines(local.output).length} rules pass here. Paying BrainChain 0.25 USDC to grade the trade.`);
  const started = io.now();
  const paid = await payGrade(request, account, { desk, fetch: io.fetch, log: io.log, ...(io.pollMs !== undefined ? { pollMs: io.pollMs } : {}) });
  return { quote, registry, request, local, paid, ms: io.now() - started };
}

/** What BrainChain's run printed: in the paid reply, or for a verdict read later, in the decision record. */
async function outputOf(verdict: Verdict, desk: string, fetchImpl: typeof fetch): Promise<string | undefined> {
  if (verdict.checks?.output !== undefined) return verdict.checks.output;
  const record = verdict.decision?.record;
  if (!record?.startsWith(`${desk}/records/`)) return undefined;
  const fetched = await fetchRecord(record, fetchImpl).catch(() => undefined);
  return fetched && recordState(fetched.record)?.execution?.output;
}

/**
 * Why a verdict cannot be acted on, if it cannot. It must be the grade this client paid for, read from the desk, and
 * accepted on a run that printed the same passing rules as the run here.
 */
export function untrustedReasons(paid: Paid, local: Run, desk: string, output: string | undefined): string[] {
  const { verdict } = paid;
  const problems: string[] = [];
  if (verdict.accepted !== true) problems.push("BrainChain did not accept the trade");
  if (verdict.grade !== paid.id) problems.push(`the verdict is for grade ${verdict.grade}, not ${paid.id}, the one paid for`);
  if (!paid.status.startsWith(`${desk}/x402/grades/`) || verdict.status !== paid.status) problems.push(`the verdict names ${verdict.status} as its status, not ${paid.status} on the desk`);
  if (verdict.checks?.outcome !== "passed") problems.push(`BrainChain's run of the checks ${verdict.checks?.outcome ?? "is not in the verdict"}`);
  const here = ruleLines(local.output);
  if (local.outcome !== "passed" || here.length === 0 || here.some((line) => !line.startsWith("pass"))) problems.push("the checks did not pass here");
  if (output === undefined) problems.push("what BrainChain's run printed is in neither its reply nor its record");
  else if (ruleLines(output).join("\n") !== here.join("\n")) problems.push("BrainChain's run printed other rule lines than the run here");
  return problems;
}

/** The verdict, with what BrainChain's run printed about the trade and each rule. */
export function report(verdict: Verdict, output = verdict.checks?.output): string[] {
  const percent = (p?: number) => (p === undefined ? "?" : `${Math.round(p * 1000) / 10}%`);
  const lines = output === undefined ? [] : runLines(output);
  const checks = verdict.checks ? `${verdict.checks.outcome}${verdict.checks.error ? ` (${verdict.checks.error})` : ""}` : "not in BrainChain's reply";
  return [
    `${verdict.accepted ? "Accepted" : "Refused"}: pass probability ${percent(verdict.passProbability)}, bar ${percent(verdict.bar)}${verdict.second ? `; second model ${verdict.second.model} at ${percent(verdict.second.passProbability)}` : ""}.`,
    `Checks: ${checks}${lines.length ? ". BrainChain's run printed:" : verdict.checks && output === undefined ? "; what they printed is not in this reply." : "."}`,
    ...lines.map((line) => `  ${line}`),
    `Decision ${verdict.decision?.id ?? "?"}: ${verdict.decision?.page ?? verdict.decision?.record ?? verdict.status}`,
  ];
}

/** A transaction ready to sign, as wallets take it. */
export interface Transaction {
  to: string;
  data: string;
  value: string;
  chainId: number;
  gas?: string;
  gasPrice?: string;
}

/**
 * The trade to sign, and before it the approval it needs, for exactly the amount sold. Both reach no further than
 * AllowanceHolder, and the trade's gas is held under MAX_GAS_COST.
 */
export function toSign(quote: SignedQuote, chainId: number): { approve?: Transaction; transaction: Transaction } {
  const body = JSON.parse(quote.response.body) as {
    sellToken: string;
    sellAmount: string;
    issues?: { allowance?: { actual: string; spender: string } | null };
    transaction: { to: string; data: string; value: string; gas: string; gasPrice: string };
  };
  const { to, data, value, gas, gasPrice } = body.transaction;
  if (!same(to, ALLOWANCE_HOLDER)) throw new Error(`The transaction calls ${to}, not AllowanceHolder ${ALLOWANCE_HOLDER}. Do not sign it.`);
  const allowance = body.issues?.allowance;
  if (allowance && !same(allowance.spender, ALLOWANCE_HOLDER)) {
    throw new Error(`0x asks for an approval to ${allowance.spender}, not to AllowanceHolder ${ALLOWANCE_HOLDER}, which the transaction calls. Approve nothing and do not sign it.`);
  }
  if (!/^\d+$/.test(gas) || !/^\d+$/.test(gasPrice) || BigInt(gas) * BigInt(gasPrice) > MAX_GAS_COST) {
    throw new Error(`The transaction may cost ${/^\d+$/.test(gas) && /^\d+$/.test(gasPrice) ? formatEther(BigInt(gas) * BigInt(gasPrice)) : "an unknown amount of"} ETH in gas, over this client's ${formatEther(MAX_GAS_COST)}. Ask for a new quote.`);
  }
  const short = allowance && BigInt(allowance.actual) < BigInt(body.sellAmount);
  const approve = { to: getAddress(body.sellToken), data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [ALLOWANCE_HOLDER, BigInt(body.sellAmount)] }), value: "0", chainId };
  return { ...(short ? { approve } : {}), transaction: { to, data, value, gas, gasPrice, chainId } };
}

/** The recorded quotes, checked on this machine as BrainChain's sandbox would: no wallet, nothing paid. */
async function samples(withPrice: boolean, io: Io): Promise<void> {
  const mandate = parseMandate(JSON.parse(await readFile(SAMPLE_MANDATE, "utf8")));
  let priced = !withPrice;
  for (const name of (await readdir(SAMPLES)).filter((f) => f.endsWith(".json")).sort()) {
    const { trade, quote, registry } = JSON.parse(await readFile(`${SAMPLES}${name}`, "utf8")) as { trade: string; quote: SignedQuote; registry: Registry };
    const request = pretradeCheck({ quote, registry, mandate, trade });
    const run = await runLocally(request);
    io.log(`${name}: ${trade}\n${run.output.split("\nTraceback")[0]!.trim()}\n`);
    if (!priced) io.log(`${(await priceOf(request, { desk: deskUrl(io.env.BRAINCHAIN_DESK_URL), fetch: io.fetch })).text}.\n`);
    priced = true;
  }
}

type Values = Record<string, string | boolean | undefined>;
const TRADE_FLAGS = ["sell", "buy", "amount", "slippage-bps"];
const tradeArgs = (values: Values) => ({ sell: values.sell as string | undefined, buy: values.buy as string | undefined, amount: values.amount as string | undefined, slippage: values["slippage-bps"] as string | undefined });

/** The mandate a run names, refused once it has run out. */
async function mandateOf(values: Values, io: Io, command: string): Promise<{ file: string; mandate: Mandate }> {
  const file = values.mandate as string | undefined;
  if (!file) throw new Error(`Name the mandate with --mandate <file>: ${command} never uses the sample one. Nothing was paid.`);
  const mandate = await readMandate(file);
  if (io.now() > Date.parse(mandate.validUntil)) throw new Refusal(`The mandate ${basename(file)} ran out at ${mandate.validUntil}.`);
  return { file, mandate };
}

/** What every check reads before anything is paid: the checks' size, the chain's node, the tokens, and what the wallet holds. */
async function preflight(mandate: Mandate, file: string, wallet: `0x${string}`, trade: Trade | undefined, io: Io): Promise<{ client: PublicClient; lines: [string, string][] }> {
  const checks = checksFor(mandate);
  if (checks.length > MAX_CHECKS) throw new Error(`With the mandate ${basename(file)} the checks are ${checks.length.toLocaleString("en-US")} characters; the grade route takes ${MAX_CHECKS.toLocaleString("en-US")}.`);
  const client = await io.connect(mandate.chain, io.env.CHAIN_RPC, "CHAIN_RPC");
  const tokens = await checkTokens(mandate, client, file);
  const sell = trade && tokenOf(mandate, trade.sellToken)!;
  const holding = trade && sell && (await checkHolding(mandate, sell, trade.sellAmount, wallet, client));
  const gas = await checkGas(mandate, wallet, client, trade && sell && same(sell.address, NATIVE) ? trade.sellAmount : 0n);
  const funds = await checkFunds(wallet, mandate.chain === BASE ? client : await io.connect(BASE, io.env.BASE_RPC, "BASE_RPC"));
  return {
    client,
    lines: [
      ["checks", `${checks.length.toLocaleString("en-US")} characters of the grade route's ${MAX_CHECKS.toLocaleString("en-US")}; template SHA-256 ${sha256(CHECKS_TEMPLATE)}, mandate SHA-256 ${sha256(mandateText(mandate))}`],
      ["node", `answers on ${chainName(mandate.chain)}, chain ${mandate.chain}`],
      ["tokens", `as on chain: ${tokens.join("; ")}`],
      ...(holding ? [["holds", `${wallet} holds ${holding}`] as [string, string]] : []),
      ["gas", `${wallet} holds ${gas}`],
      ["funds", `${wallet} holds ${funds}`],
    ],
  };
}

/** Every check that costs nothing, with no key: the mandate, the inputs, the chain's reads, the route, and the checks on a recorded quote. */
async function dryRun(values: Values, io: Io): Promise<number> {
  const line = (mark: "ok" | "skip", step: string, text: string) => io.log(`  ${mark.padEnd(5)} ${step}: ${text}`);
  const { file, mandate } = await mandateOf(values, io, "--dry");
  line("ok", "mandate", `${basename(file)}: ${mandate.tokens.map((t) => t.symbol).join(", ")} on ${chainName(mandate.chain)} for wallet ${mandate.wallet}, until ${mandate.validUntil}`);
  const desk = deskUrl(io.env.BRAINCHAIN_DESK_URL);
  const given = TRADE_FLAGS.filter((name) => values[name] !== undefined);
  const missing = ["sell", "buy", "amount"].filter((name) => values[name] === undefined).map((name) => `--${name}`);
  if (given.length > 0 && missing.length > 0) throw new Error(`--dry checks a trade with all of --sell, --buy and --amount, or none of them; ${listOf(missing)} ${missing.length === 1 ? "is" : "are"} missing.`);
  const trade = given.length > 0 ? tradeOf(mandate, mandate.wallet, tradeArgs(values)) : undefined;
  if (trade) line("ok", "trade", `${describeTrade(mandate, trade)}, within the mandate`);
  else line("skip", "trade", "give --sell, --buy and --amount to check a trade too");
  for (const [step, text] of (await preflight(mandate, file, mandate.wallet, trade, io)).lines) line("ok", step, text);
  // A quote costs 0.01 USDC, so the checks run with this mandate on one bought earlier.
  const sample = JSON.parse(await readFile(`${SAMPLES}inside.json`, "utf8")) as { trade: string; quote: SignedQuote; registry: Registry };
  const request = pretradeCheck({ ...sample, mandate });
  const price = await priceOf(request, { desk, fetch: io.fetch });
  if (!price.takes) throw new Error(`${price.text}. Nothing was paid.`);
  line("ok", "route", price.text);
  const local = await runLocally(request);
  io.log(`\nThe checks with this mandate, run here on a quote recorded for the sample wallet (${sample.trade}). Rules about another wallet, chain or token fail on it, as they should:`);
  io.log(runLines(local.output).map((l) => `  ${l}`).join("\n"));
  io.log("\nNothing was paid. A paid check buys a fresh quote from 0x for 0.01 USDC, runs these checks on it, and pays BrainChain 0.25 USDC only if they pass.");
  return 0;
}

async function paidCheck(values: Values, io: Io): Promise<number> {
  const { file, mandate } = await mandateOf(values, io, "a paid check");
  const desk = deskUrl(io.env.BRAINCHAIN_DESK_URL);
  const account = await io.account(io.env.BRAINCHAIN_PAYER_KEY_FILE);
  if (!same(account.address, mandate.wallet)) throw new Error(`The mandate ${basename(file)} is for wallet ${mandate.wallet}, but the key is for ${account.address}.`);
  const trade = tradeOf(mandate, account.address, tradeArgs(values));
  const { client, lines } = await preflight(mandate, file, account.address, trade, io);
  io.log(`Checking: ${describeTrade(mandate, trade)}, from ${account.address}.`);
  for (const [step, text] of lines) io.log(`  ok    ${step}: ${text}`);

  const { quote, local, paid, ms } = await checkTrade(mandate, trade, account, client, desk, io);
  const output = await outputOf(paid.verdict, desk, io.fetch);
  io.log([...report(paid.verdict, output), `Verdict in ${(ms / 1000).toFixed(1)} s.`].join("\n"));
  io.log(`To check the record later: npm run verify -- ${paid.verdict.decision?.id ?? paid.id} --mandate ${file}`);
  if (paid.verdict.accepted !== true) {
    io.log("\nDo not sign this trade. Nothing was sent.");
    return 2;
  }
  const problems = untrustedReasons(paid, local, desk, output);
  if (problems.length > 0) throw new Error(`BrainChain's acceptance cannot be acted on: ${problems.join("; ")}. Do not sign this trade.`);
  if (io.now() > Date.parse(mandate.validUntil)) throw new Refusal(`The mandate ${basename(file)} ran out at ${mandate.validUntil}, while the trade was graded. Do not sign it.`);
  const { approve, transaction } = toSign(quote, mandate.chain);
  const sold = `${formatUnits(trade.sellAmount, tokenOf(mandate, trade.sellToken)!.decimals)} ${tokenOf(mandate, trade.sellToken)!.symbol}`;
  if (approve) io.log(`\nFirst sign this approval, which lets AllowanceHolder take exactly ${sold} for this trade:\n${JSON.stringify(approve, null, 2)}`);
  io.log(`\n${approve ? "Then sign" : "Sign"} the trade on ${chainName(mandate.chain)}, from ${mandate.wallet}. It reverts rather than pay out less than the checked minimum:\n${JSON.stringify(transaction, null, 2)}`);
  return 0;
}

export async function run(argv: string[], io: Io = defaultIo): Promise<number> {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        sell: { type: "string" },
        buy: { type: "string" },
        amount: { type: "string" },
        "slippage-bps": { type: "string" },
        mandate: { type: "string" },
        dry: { type: "boolean" },
        sample: { type: "boolean" },
        quote: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
    if (values.help) {
      io.log(USAGE);
      return 0;
    }
    if (values.sample) {
      const ignored = [...TRADE_FLAGS, "mandate", "dry"].filter((name) => values[name as keyof typeof values] !== undefined);
      if (ignored.length > 0) throw new Error(`--sample checks the recorded quotes against the sample mandate, so it takes no ${ignored.map((n) => `--${n}`).join(", ")}.`);
      await samples(values.quote === true, io);
      return 0;
    }
    if (values.quote) throw new Error("--quote goes with --sample.");
    return await (values.dry ? dryRun(values, io) : paidCheck(values, io));
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    return error instanceof Refusal ? 2 : 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await run(process.argv.slice(2));
