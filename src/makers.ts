import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { BaseError, createPublicClient, decodeFunctionResult, encodeFunctionData, formatUnits, http, isAddressEqual, multicall3Abi, parseAbi, parseAbiItem, RpcRequestError, type Address, type Hash, type PublicClient } from "viem";

import { line, within } from "./custody.js";
import { MULTICALL3, ROBINHOOD_RPC } from "./premiums.js";

export const MAKERS_NAME = "brainchain_market_maker_holdings";

export interface MakerWallet {
  /** Who the wallet belongs to; a wallet the caller named has none. */
  name?: string;
  wallet: Address;
  /** A Safe that acts for the wallet, so a transaction sent to it can be the wallet's own. */
  safe?: Address;
}

/**
 * Wallets whose owner is public knowledge. Wintermute's is its trading contract: Etherscan tags the address as a market maker
 * on Ethereum and Arkham attributes it to Wintermute. It is the first contract its deployer created, so only that deployer's
 * key could have put a contract at the same address on Robinhood Chain. `safe` is the Safe its approvals go through: each of
 * the 36 transactions in which it approved Cash Cat or Pons, read on 2026-11-16, was sent to that Safe.
 */
export const MARKET_MAKERS: readonly MakerWallet[] = [{ name: "Wintermute", wallet: "0x51C72848c68a965f66FA7a88855F9f7784502a7F", safe: "0x7d330DD7AF628c24E9FC75eb2986b130b2125ad0" }];

/** The most blocks Robinhood Chain's public endpoint searches for one token's logs in a request. */
export const STRETCH_BLOCKS = 10_000_000n;
/** A stretch that ended this many blocks ago is read once and kept. Blocks come about ten a second, so this is an hour. */
export const SETTLED_BLOCKS = 36_000n;
/** How many stretches are kept before they are cleared. A first answer takes a dozen for each wallet. */
export const MAX_KEPT = 5_000;
/** The endpoint turns away an address that sends about 25 requests in a burst, so they go out one at a time, this far apart. */
export const GAP_MS = 150;
/** A request the endpoint turned away is sent again after this long, then twice and four times as long: it can refuse for a second or two. */
export const RETRY_MS = 500;
/** `decimals()` returns a uint8, so more than 255 is no token's answer, and writing a balance out takes time that grows with it. */
const MAX_DECIMALS = 255;
const REQUEST_MS = 15_000;
const ANSWER_MS = 45_000;

export const MAKERS_TOOL: Tool = {
  name: MAKERS_NAME,
  title: "A market maker's holdings and first approval of a Robinhood Chain token",
  description:
    "How much of a Robinhood Chain token a market maker's trading wallet holds, and when that wallet first approved the token, read from the chain. " +
    "An approval is a transaction in which a wallet gives a contract permission to move its holdings of one token. " +
    "A market maker makes one when it is getting ready to trade a token, which can be before an exchange lists the token: " +
    "Wintermute's trading contract first approved Cash Cat on August 5, 2026, and Robinhood listed that token on August 6, 2026. " +
    "That makes a first approval worth a closer look, not a prediction: it does not say why the market maker wants the token, and it does not mean an exchange will list it. " +
    "Pass the token's contract address as `token`; the `contract` of an entry from brainchain_custody_additions works. " +
    "The tool follows one market maker today, Wintermute, and reads that firm's trading contract at 0x51C72848c68a965f66FA7a88855F9f7784502a7F: " +
    "Etherscan tags that address as a market maker and Arkham attributes it to Wintermute. " +
    "To read another wallet instead, pass its address as `wallet`. Its entry has no `name`, and the tool does not check whose wallet it is. " +
    "In the answer, `token` holds the token's `contract`, the `name` and `symbol` the contract gives itself, its `decimals` and its `totalSupply`, counted in tokens and not in the token's smallest unit. " +
    "Whoever deployed the contract chose the name and symbol, so they do not prove which token it is. " +
    "`wallets` has one entry for each wallet read: the `wallet`, its `name`, the `balance` it holds now, also counted in tokens, and `shareOfSupplyPct`, that balance as a percentage of the total supply, which is left out for a token with no supply. " +
    "`firstApproval` is there only if the token's log shows an approval by the wallet: `at` is when, `spender` is the contract it gave permission to, and `transaction` is the transaction's hash. " +
    "`confirmed` is true when the wallet took part in that transaction: the wallet sent it, it was sent to the wallet or, for Wintermute, it was sent to the Safe at 0x7d330DD7AF628c24E9FC75eb2986b130b2125ad0. " +
    "Every approval of the Cash Cat and Pons tokens by Wintermute's trading contract has gone through that Safe. When `confirmed` is false, the token's own log is the only sign of the approval. " +
    "A token's contract writes its own balances and logs, so whoever deployed a token can make any wallet appear to hold it or to have approved it, and anyone can send a wallet tokens. " +
    "For a token whose origin you do not know, a `balance` therefore proves little, and a `firstApproval` counts only when its `confirmed` is true. " +
    "A wallet with a zero `balance` and no `firstApproval` holds none of the token now and has never approved it. A market maker also trades from other wallets, so that does not mean the firm holds none. " +
    "`readAt` is when the chain was read. " +
    "The tool answers one request at a time, so requests sent together are answered in turn. " +
    "The first answer for a token and wallet takes several seconds, because the tool reads the token's whole history; later ones are faster for as long as the server keeps running. " +
    "Free, no key and no payment. Not advice.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: {
    type: "object",
    properties: {
      token: { type: "string", description: "The token's contract address on Robinhood Chain: 0x followed by 40 hex characters." },
      wallet: { type: "string", description: "Optional: the address of another wallet or contract to read instead of the market maker the tool follows." },
    },
    required: ["token"],
    additionalProperties: false,
  },
};

export interface Approval {
  at: string;
  spender: Address;
  transaction: Hash;
  /** Whether the transaction was sent by the wallet, to it or to its Safe. The token's contract writes the log, so its deployer can write one for any wallet. */
  confirmed: boolean;
}

export interface MakerHolding {
  name?: string;
  wallet: Address;
  balance: string;
  /** Left out for a token with no supply, and for a balance above the supply, which only a broken token reports. */
  shareOfSupplyPct?: string;
  firstApproval?: Approval;
}

export interface MakerBoard {
  chain: "Robinhood Chain";
  token: { contract: Address; name?: string; symbol?: string; decimals: number; totalSupply: string };
  readAt: string;
  wallets: MakerHolding[];
}

export type MakerReader = Pick<PublicClient, "getBlock" | "getBlockNumber" | "getCode" | "getLogs" | "getTransaction" | "readContract">;

/** The first approval in each stretch of blocks already read, by token, wallet and stretch. */
export type Kept = Map<string, Promise<Approval | undefined>>;

/** As `CustodyError`: a message already written for the person asking. */
export class MakerError extends Error {}

const tokenAbi = parseAbi([
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
]);
const approvalEvent = parseAbiItem("event Approval(address indexed owner, address indexed spender, uint256 value)");

/** Whether the endpoint itself answered with an error whose text matches. */
const endpointSaid = (error: unknown, text: RegExp) => error instanceof BaseError && error.walk((cause) => cause instanceof RpcRequestError && text.test(cause.details)) !== null;
/** The endpoint returns at most 10,000 logs for a request and refuses one that matches more. */
const tooMany = (error: unknown) => endpointSaid(error, /exceeds limit/i);

const notToken = (token: Address) => new MakerError(`The contract at ${token} on Robinhood Chain does not behave like a token: its decimals, its total supply or a balance could not be read. Check that this is the token's own contract address.`);

/**
 * A token's name for itself is whatever its deployer wrote, and an agent reads it. It goes out as one short line with
 * nothing that passes for markup and no letter that shows as blank.
 */
const label = (text: string, max: number) => line(text.replace(/[<>[\]`\u034f\u115f\u1160\u17b4\u17b5\u180b-\u180f\u2800\u3164\ufe00-\ufe0f\uffa0\u{e0000}-\u{e0fff}]/gu, " "), max);

/**
 * The first time `maker.wallet` approved `token` between two blocks. A stretch with more logs than the endpoint returns
 * is halved: some tokens log an approval at every transfer a spender makes, and only the first one is wanted.
 */
async function firstApproval(reader: MakerReader, token: Address, maker: MakerWallet, from: bigint, to: bigint): Promise<Approval | undefined> {
  const { wallet, safe } = maker;
  const logs = await reader.getLogs({ address: token, event: approvalEvent, args: { owner: wallet }, fromBlock: from, toBlock: to, strict: true }).catch((error: unknown) => {
    if (!tooMany(error)) throw error;
    if (from < to) return undefined;
    throw new MakerError(
      `The contract at ${token} logged more than 10,000 approvals for ${wallet} in a single block, more than this tool can read, so it cannot answer for this token and wallet. Trying again will not change that.`,
    );
  });
  if (!logs) {
    const middle = (from + to) / 2n;
    return (await firstApproval(reader, token, maker, from, middle)) ?? firstApproval(reader, token, maker, middle + 1n, to);
  }
  // An approval of zero takes a spender's allowance away.
  const granted = logs.filter((log) => log.args.value > 0n);
  if (granted.length === 0) return undefined;
  const first = granted.reduce((earliest, log) => (log.blockNumber < earliest.blockNumber || (log.blockNumber === earliest.blockNumber && log.logIndex < earliest.logIndex) ? log : earliest));
  // The endpoint sends every log with a block time of zero, so the time comes from the block.
  const block = await reader.getBlock({ blockNumber: first.blockNumber });
  const sent = await reader.getTransaction({ hash: first.transactionHash });
  const own = (address: Address | null) => address !== null && (isAddressEqual(address, wallet) || (safe !== undefined && isAddressEqual(address, safe)));
  return {
    at: new Date(Number(block.timestamp) * 1000).toISOString(),
    spender: first.args.spender,
    transaction: first.transactionHash,
    confirmed: isAddressEqual(sent.from, wallet) || own(sent.to),
  };
}

/** `part` of `whole` in percent, to four places, rounded half up. */
const percent = (part: bigint, whole: bigint) => (Number((part * 2_000_000n + whole) / (2n * whole)) / 10_000).toFixed(4);

type TokenRead = "decimals" | "totalSupply" | "name" | "symbol" | "balanceOf";

/**
 * What each wallet holds of `token` now, and the first time it approved the token since the chain began.
 *
 * The endpoint keeps no balances from the past, so a first approval is found in the token's logs, read in stretches of
 * `STRETCH_BLOCKS` from block zero until one holds an approval. A stretch that ended `SETTLED_BLOCKS` ago cannot change
 * and is kept in `kept`, so asking again reads only the newest stretch.
 */
export async function makerHoldings(reader: MakerReader, token: Address, wallets: readonly MakerWallet[], kept: Kept, now = new Date()): Promise<MakerBoard> {
  const reads: { functionName: TokenRead; args?: [Address] }[] = [
    { functionName: "decimals" },
    { functionName: "totalSupply" },
    { functionName: "name" },
    { functionName: "symbol" },
    ...wallets.map(({ wallet }) => ({ functionName: "balanceOf" as const, args: [wallet] as [Address] })),
  ];
  // One call to Multicall3 and not viem's multicall, which reports a request the endpoint refused as every read having failed.
  const answers = await reader
    .readContract({
      address: MULTICALL3,
      abi: multicall3Abi,
      functionName: "aggregate3",
      args: [reads.map((read) => ({ target: token, allowFailure: true, callData: encodeFunctionData({ abi: tokenAbi, ...read }) }))],
    })
    .catch((error: unknown) => {
      // A contract that burns all the gas it is given takes the whole call down with it.
      throw endpointSaid(error, /out of gas|reverted/i) ? notToken(token) : error;
    });
  const [decimals, supply, name, symbol, ...balances] = reads.map(({ functionName }, i): unknown => {
    const answer = answers[i];
    if (!answer?.success) return undefined;
    try {
      return decodeFunctionResult({ abi: tokenAbi, functionName, data: answer.returnData });
    } catch {
      return undefined;
    }
  });
  const held = balances.filter((balance) => typeof balance === "bigint");
  if (typeof decimals !== "number" || decimals > MAX_DECIMALS || typeof supply !== "bigint" || held.length !== wallets.length) {
    const code = await reader.getCode({ address: token });
    if (code && code !== "0x") throw notToken(token);
    throw new MakerError(
      `There is no contract at ${token} on Robinhood Chain. If the address came from brainchain_custody_additions, the token may not be deployed yet: BitGo lists some tokens before their contract exists. Otherwise check the address.`,
    );
  }

  const newest = await reader.getBlockNumber();
  function stretch(maker: MakerWallet, from: bigint): Promise<Approval | undefined> {
    const to = from + STRETCH_BLOCKS - 1n;
    if (to + SETTLED_BLOCKS > newest) return firstApproval(reader, token, maker, from, to < newest ? to : newest);
    const key = `${token}:${maker.wallet}:${from}`;
    const earlier = kept.get(key);
    if (earlier) return earlier;
    if (kept.size >= MAX_KEPT) kept.clear();
    const reading = firstApproval(reader, token, maker, from, to);
    kept.set(key, reading);
    reading.catch(() => {
      if (kept.get(key) === reading) kept.delete(key);
    });
    return reading;
  }
  async function firstEver(maker: MakerWallet): Promise<Approval | undefined> {
    for (let from = 0n; from <= newest; from += STRETCH_BLOCKS) {
      const found = await stretch(maker, from);
      if (found) return found;
    }
    return undefined;
  }
  const first: (Approval | undefined)[] = [];
  for (const maker of wallets) first.push(await firstEver(maker));

  const [tokenName, tokenSymbol] = [typeof name === "string" ? label(name, 60) : "", typeof symbol === "string" ? label(symbol, 20) : ""];
  return {
    chain: "Robinhood Chain",
    token: {
      contract: token,
      ...(tokenName ? { name: tokenName } : {}),
      ...(tokenSymbol ? { symbol: tokenSymbol } : {}),
      decimals,
      totalSupply: formatUnits(supply, decimals),
    },
    readAt: now.toISOString(),
    wallets: wallets.map(({ name: owner, wallet }, i) => ({
      ...(owner ? { name: owner } : {}),
      wallet,
      balance: formatUnits(held[i]!, decimals),
      ...(supply > 0n && held[i]! <= supply ? { shareOfSupplyPct: percent(held[i]!, supply) } : {}),
      ...(first[i] ? { firstApproval: first[i] } : {}),
    })),
  };
}

/** `fetchImpl` with one request out at a time and `gap` milliseconds before the next. */
export function paced(fetchImpl: typeof fetch = fetch, gap = GAP_MS): typeof fetch {
  let last: Promise<unknown> = Promise.resolve();
  return (input, init) => {
    const turn = last.then(() => fetchImpl(input, init));
    const rest = () => new Promise((resolve) => setTimeout(resolve, gap));
    last = turn.then(rest, rest);
    return turn;
  };
}

export function makerReader(rpc = ROBINHOOD_RPC, fetchImpl: typeof fetch = fetch): MakerReader {
  return createPublicClient({ transport: http(rpc, { fetchFn: paced(fetchImpl), retryCount: 3, retryDelay: RETRY_MS, timeout: REQUEST_MS }) });
}

let reader: MakerReader | undefined;
const kept: Kept = new Map();
let busy: Promise<unknown> = Promise.resolve();

/**
 * One answer is read at a time: requests go out one by one, so answers read side by side would all come late together.
 * An answer that gave up waiting is still read when its turn comes, and what it reads is kept for the next call.
 */
export function readMakerHoldings(token: Address, wallet?: Address): Promise<MakerBoard> {
  const chain = (reader ??= makerReader());
  const answer = busy.then(() => makerHoldings(chain, token, wallet ? [{ wallet }] : MARKET_MAKERS, kept));
  busy = answer.catch(() => {});
  return within(ANSWER_MS, answer, new MakerError("Robinhood Chain is taking too long to read. Try again in a minute."));
}
