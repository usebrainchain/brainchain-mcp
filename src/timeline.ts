import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { isAddressEqual, type Address, type Hash } from "viem";

import { BY_SYMBOL, readCustodyHistory, readListedTokens, TOKEN_INPUT, type CustodyBoard, type CustodyToken } from "./custody.js";
import { blockOf, inTurn, type ChainHistory, type Moment } from "./history.js";
import { firstApprovalsIn, MARKET_MAKERS, who, type Approval, type MakerWallet } from "./makers.js";
import { firstQueued, otherSide, queuedKept, type QueuedPool } from "./queued.js";
import { readinessIn, type Pool, type ReadinessBoard } from "./readiness.js";
import { readTokenSightings, type ListSighting, type SightingsBoard } from "./sightings.js";

export const TIMELINE_NAME = "brainchain_token_timeline";

export const TIMELINE_TOOL: Tool = {
  name: TIMELINE_NAME,
  title: "Every dated public step of a Robinhood Chain token",
  description:
    "Every dated public step of one Robinhood Chain token in one answer, oldest first, each with the `source` it was read from. " +
    "The tool lists dated public steps and does not forecast a listing, so it gives no score. A step is a lead to look into: none says why it happened, and together they do not mean an exchange will list the token. " +
    "`steps` can hold BitGo's merge of the token into its lists (`custody`, with BitGo's `id` and `name` and a link to the `commit`), the contract's creation (`deploy`, given only when the transaction that first minted the token also created its contract), " +
    "its first mint (`mint`, with `to`, the address that received it), the first pool on each Uniswap venue (`pool`, with `pairedWith`), " +
    "the first time a market maker added one of the token's pools to its trading contracts' approved list (`pool_queued`, with the wallet as `maker`, the `venue`, the `pool`, `pairedWith`, `confirmed`, and `granted` once the addition took effect, with its own `at`, `block` and `transaction`), " +
    "the first approval of the token by each wallet brainchain_market_maker_holdings follows (`approval`, with the wallet as `maker`, the `spender` and `confirmed`), " +
    "and the merge that added the token's file to Trust Wallet's and MetaMask's lists (`listing`, with its `link`), dated when the list's master branch took it, not when its commit was made. " +
    "Each step has `at`, `step` and `source`, and one read from the chain also has its `block` and `transaction`. " +
    "Wintermute's multisig adds each pool its trading contracts may trade by queuing it on the role registry they read, and the pool can be traded from `granted` on, hours or days later. It queued Cash Cat's first pool on August 3, 2026, and its trading contract first approved the token on August 5. " +
    "A `pool_queued` step's `confirmed` is true when the transaction was sent to the market maker's Safe. " +
    "brainchain_custody_additions, brainchain_token_readiness, brainchain_market_maker_holdings and brainchain_token_sightings read the same steps and say what each does and does not show: an `approval` counts only when its `confirmed` is true, and anyone can create a pool for any token. " +
    "Pass the token's contract address as `token`; the `contract` of an entry from brainchain_custody_additions works. " +
    BY_SYMBOL +
    "To see only what was public at a point in the past, pass `atBlock`, a block number, or `at`, a time in ISO 8601 such as 2026-11-01T00:00:00Z. " +
    "A step read from the chain is kept when its block is at or before that block, or the last block made at or before that time, and any other step when its time is at or before the block's time, or the time given. `until` then gives the `block` and the time (`at`) used. " +
    "A `pool_queued` step whose addition took effect after the cut-off has no `granted`. " +
    "BitGo's merges are read from May 11, 2026, when BitGo added its first Robinhood Chain token, so a token BitGo added at any time since has its merge, including one it has since removed. A token BitGo removed again within 16 merges, a few days at its pace, can be missed. " +
    "`undated` has a listing whose merge could not be dated, with `by`, a time it had happened by, in place of `at`. " +
    "With a cut-off, an undated step whose `by` is after it goes to `withheld`: it is public now, and nothing shows whether it was public by then, so it is named rather than left out. " +
    "Robinhood, Bitstamp, KuCoin, Gate, LI.FI and CoinGecko publish no date for a listing, so brainchain_token_sightings reads them and they are not steps here. " +
    "`deployed` says whether a contract is at the address, `token` holds its `contract` and the `name` and `symbol` it gives itself, and `unread` names a source that could not be read just now: BitGo, Trust Wallet or MetaMask. `readAt` is when the answer was made. " +
    "The tool answers one request at a time, in turn with the other tools that read the chain. The first answer for a token can take half a minute; an answer that is not ready after 45 seconds says so, and asking again goes on from where it stopped. " +
    "The first answer after the server starts also reads BitGo's history, with about a dozen of the 60 requests an hour GitHub allows one IP address without a key; the server keeps what it worked out, and later answers read only BitGo's changes since. If that history is not read within 45 seconds, `unread` names BitGo, and asking again goes on from where it stopped. " +
    "A server whose operator set GITHUB_TOKEN reads GitHub with that token's allowance. " +
    "Free, no key and no payment. Not advice.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: {
    type: "object",
    properties: {
      token: TOKEN_INPUT,
      atBlock: { type: "integer", minimum: 0, description: "Optional: a block number. Only the steps public by the end of that block are listed." },
      at: { type: "string", description: "Optional, in place of atBlock: a time in ISO 8601, such as 2026-11-01T00:00:00Z. Only the steps public by then are listed." },
    },
    required: ["token"],
    additionalProperties: false,
  },
};

interface OnChain {
  block: number;
  transaction: Hash;
}

export type Step =
  | { at: string; step: "custody"; source: "BitGo"; id: string; name?: string; commit: string }
  | ({ at: string; step: "deploy"; source: "Robinhood Chain" } & OnChain)
  | ({ at: string; step: "mint"; source: "Robinhood Chain"; to: Address } & OnChain)
  | ({ at: string; step: "pool"; source: Pool["venue"]; pairedWith: Pool["pairedWith"] } & OnChain)
  | ({ at: string; step: "pool_queued"; source: "Robinhood Chain"; maker: ReturnType<typeof who>; venue: QueuedPool["venue"]; pool: string; pairedWith: Address | "ETH"; granted?: { at: string } & OnChain; confirmed: boolean } & OnChain)
  | ({ at: string; step: "approval"; source: "Robinhood Chain"; maker: ReturnType<typeof who>; spender: Address; confirmed: boolean } & OnChain)
  | { at: string; step: "listing"; source: "Trust Wallet" | "MetaMask"; link: string };

/** Under a cut-off, an undated step not known to have happened by then: public now, but on neither side of the cut. */
export type Withheld = { step: "custody"; source: "BitGo"; id: string; name?: string } | { step: "listing"; source: "Trust Wallet" | "MetaMask"; link: string };

/** A step whose time is not known, with `by`, a time it had happened by. */
export type Undated = Withheld & { by: string };

export interface TimelineBoard {
  chain: "Robinhood Chain";
  token: { contract: Address; name?: string; symbol?: string };
  readAt: string;
  until?: { block: number; at: string };
  deployed: boolean;
  steps: Step[];
  undated: Undated[];
  withheld?: Withheld[];
  unread: ("BitGo" | "Trust Wallet" | "MetaMask")[];
}

/** Where the steps come from. A test passes its own. */
export interface TimelineReaders {
  /** Runs `read` against the chain in the turn every tool that reads it waits for. */
  chain<T>(read: (reader: ChainHistory) => Promise<T>): Promise<T>;
  readiness(reader: ChainHistory, token: Address): Promise<ReadinessBoard>;
  approvals(reader: ChainHistory, token: Address, wallets: readonly MakerWallet[], newest: bigint): Promise<(Approval | undefined)[]>;
  /** For each wallet, the first of the token's pools its multisig queued on its role registry. */
  queued(reader: ChainHistory, token: Address, wallets: readonly MakerWallet[], newest: bigint): Promise<(QueuedPool | undefined)[]>;
  custody(): Promise<CustodyBoard>;
  listed(): Promise<CustodyToken[]>;
  sightings(token: Address): Promise<SightingsBoard>;
}

/** Steps in the same second are in the order one leads to the next, and those in the same block in the order the chain logs them. */
const ORDER: Step["step"][] = ["custody", "deploy", "mint", "pool", "pool_queued", "approval", "listing"];
const inOrder = (a: Step, b: Step) => Date.parse(a.at) - Date.parse(b.at) || ("block" in a && "block" in b ? a.block - b.block : 0) || ORDER.indexOf(a.step) - ORDER.indexOf(b.step);

const dated = (list: ListSighting): list is ListSighting & { source: "Trust Wallet" | "MetaMask"; link: string } => (list.source === "Trust Wallet" || list.source === "MetaMask") && list.listed && list.link !== undefined;

/** Whether the transaction that first minted `token` also created it, which dates the contract. A factory that creates a token leaves no address on the receipt. */
async function createdBy(reader: ChainHistory, token: Address, transaction: Hash): Promise<boolean> {
  const { contractAddress } = await reader.getTransactionReceipt({ hash: transaction });
  return contractAddress !== null && contractAddress !== undefined && isAddressEqual(contractAddress, token);
}

/**
 * Every dated public step of `token`, oldest first. The chain is read in one turn, and BitGo's code and the lists at the
 * same time beside it: a source that fails is named in `unread` and takes nothing else with it, while a chain that cannot
 * be read fails the answer, as it does for the tools that read it alone. With `until`, only what was public by then is kept.
 */
export async function tokenTimeline(readers: TimelineReaders, token: Address, wallets: readonly MakerWallet[], times: Map<string, Promise<bigint>>, until?: Moment, now = new Date()): Promise<TimelineBoard> {
  const attempt = <T>(reading: Promise<T>) => reading.then((value) => ({ value }), () => undefined);
  const [chain, custody, listed, sightings] = await Promise.all([
    readers.chain(async (reader) => {
      const newest = await reader.getBlockNumber();
      const cutoff = until && (await blockOf(reader, until, newest, times));
      const readiness = await readers.readiness(reader, token);
      if (!readiness.deployed) return { cutoff, readiness, approvals: [], queued: [], deploy: false };
      const approvals = await readers.approvals(reader, token, wallets, newest);
      const queued = await readers.queued(reader, token, wallets, newest);
      const deploy = readiness.firstMint !== undefined && (await createdBy(reader, token, readiness.firstMint.transaction));
      return { cutoff, readiness, approvals, queued, deploy };
    }),
    attempt(readers.custody()),
    attempt(readers.listed()),
    attempt(readers.sightings(token)),
  ]);
  const { cutoff, readiness, approvals, queued, deploy } = chain;
  const steps: Step[] = [];
  const undated: Undated[] = [];
  const unread: TimelineBoard["unread"] = [];

  const mint = readiness.firstMint;
  if (mint && deploy) steps.push({ at: mint.at, step: "deploy", source: "Robinhood Chain", block: mint.block, transaction: mint.transaction });
  if (mint) steps.push({ at: mint.at, step: "mint", source: "Robinhood Chain", block: mint.block, transaction: mint.transaction, to: mint.to });
  for (const { venue, at, block, transaction, pairedWith } of readiness.pools ?? []) steps.push({ at, step: "pool", source: venue, block, transaction, pairedWith });
  // Given a cut-off, a role queued by then that took effect later is shown as queued only.
  const cutBlock = cutoff && Number(cutoff.block);
  queued.forEach((first, i) => {
    if (!first) return;
    const { at, block, transaction, venue, pool, granted, confirmed } = first;
    const shown = granted && (cutBlock === undefined || granted.block <= cutBlock) ? { granted } : {};
    steps.push({ at, step: "pool_queued", source: "Robinhood Chain", block, transaction, maker: who(wallets[i]!), venue, pool, pairedWith: otherSide(first, token), ...shown, confirmed });
  });
  approvals.forEach((approval, i) => {
    if (approval) steps.push({ at: approval.at, step: "approval", source: "Robinhood Chain", block: approval.block, transaction: approval.transaction, maker: who(wallets[i]!), spender: approval.spender, confirmed: approval.confirmed });
  });

  const ours = ({ contract }: { contract?: Address }) => contract !== undefined && isAddressEqual(contract, token);
  if (!custody || !listed) unread.push("BitGo");
  else {
    const merged = custody.value.additions.flatMap(({ addedAt, commit, tokens }) => tokens.filter(ours).map(({ id, name }): Step => ({ at: addedAt, step: "custody", source: "BitGo", id, ...(name ? { name } : {}), commit })));
    steps.push(...merged);
    // On the lists now and added in none of the merges read, so it was on them when the period began.
    if (merged.length === 0) for (const { id, name } of listed.value.filter(ours)) undated.push({ step: "custody", source: "BitGo", id, ...(name ? { name } : {}), by: custody.value.since });
  }

  if (!sightings) unread.push("Trust Wallet", "MetaMask");
  else {
    for (const list of sightings.value.lists.filter(dated)) {
      if (list.since) steps.push({ at: list.since, step: "listing", source: list.source, link: list.link });
      else undated.push({ step: "listing", source: list.source, link: list.link, by: sightings.value.readAt });
    }
    for (const source of ["Trust Wallet", "MetaMask"] as const) if (sightings.value.unread.includes(source)) unread.push(source);
  }

  // Given a time, a step dated by time is weighed against that time itself, not the time of the last block before it.
  const cut = cutoff && { block: Number(cutoff.block), time: until && "time" in until ? until.time : Date.parse(cutoff.at) };
  const known = (step: Step) => !cut || ("block" in step ? step.block <= cut.block : Date.parse(step.at) <= cut.time);
  const late = ({ by }: Undated) => cut !== undefined && Date.parse(by) > cut.time;
  return {
    chain: "Robinhood Chain",
    token: { contract: token, ...(readiness.token.name ? { name: readiness.token.name } : {}), ...(readiness.token.symbol ? { symbol: readiness.token.symbol } : {}) },
    readAt: now.toISOString(),
    ...(cut ? { until: { block: cut.block, at: new Date(cut.time).toISOString() } } : {}),
    deployed: readiness.deployed,
    steps: steps.filter(known).sort(inOrder),
    undated: undated.filter((step) => !late(step)),
    ...(cut ? { withheld: undated.filter(late).map(({ by, ...step }) => step) } : {}),
    unread,
  };
}

const queuedSeen = queuedKept();

/** Each wallet's first queued pool for `token`, read in a turn another tool already holds. */
export const firstQueuedIn = (reader: ChainHistory, token: Address, wallets: readonly MakerWallet[], newest: bigint) =>
  Promise.all(wallets.map((maker) => firstQueued(reader, maker, token, newest, queuedSeen)));

const READERS: TimelineReaders = {
  chain: inTurn,
  readiness: readinessIn,
  approvals: firstApprovalsIn,
  queued: firstQueuedIn,
  custody: readCustodyHistory,
  listed: readListedTokens,
  sightings: readTokenSightings,
};

const times = new Map<string, Promise<bigint>>();

export function readTokenTimeline(token: Address, until?: Moment, followed: readonly MakerWallet[] = MARKET_MAKERS): Promise<TimelineBoard> {
  return tokenTimeline(READERS, token, followed, times, until);
}
