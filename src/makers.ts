import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { formatUnits, getAddress, isAddress, isAddressEqual, parseAbiItem, type Address } from "viem";

import {
  blockOf,
  blockTime,
  ChainError,
  earliestLog,
  firstSince,
  inTurn,
  noContract,
  STRETCH_BLOCKS,
  tokenFacts,
  tooMany,
  tooSlow,
  transferred,
  transfersStart,
  type ChainHistory,
  type Dated,
  type Kept,
  type Moment,
} from "./history.js";

export const MAKERS_NAME = "brainchain_market_maker_holdings";

export interface MakerWallet {
  /** The firm the wallet belongs to; a wallet the caller named has none. */
  name?: string;
  /** The public name tag that says so, as Etherscan shows it for the address on Ethereum. */
  tag?: string;
  /** Set for a wallet the operator added with BRAINCHAIN_MAKER_WALLETS, whose owner nobody here has checked. */
  source?: "configured";
  wallet: Address;
  /** A Safe that acts for the wallet, so a transaction sent to it can be the wallet's own. */
  safe?: Address;
}

/**
 * Wallets whose owner is public knowledge, each active on Robinhood Chain when it was added (2026-11-16).
 *
 * The first is Wintermute's trading contract: Etherscan tags the address as a market maker on Ethereum and Arkham
 * attributes it to Wintermute. It is the first contract its deployer created, so only that deployer's key could have put a
 * contract at the same address on Robinhood Chain. `safe` is the Safe its approvals go through: each of the 36
 * transactions in which it approved Cash Cat or Pons was sent to that Safe.
 *
 * The others are plain wallets with a public name tag on Etherscan. A plain wallet is one key, and one key has the same
 * address on every chain, so the tag on Ethereum names its owner on Robinhood Chain too. A tagged contract does not carry
 * over that way and is left out.
 */
export const MARKET_MAKERS: readonly MakerWallet[] = [
  { name: "Wintermute", tag: "Market Maker: 0x51c7...2a7f", wallet: "0x51C72848c68a965f66FA7a88855F9f7784502a7F", safe: "0x7d330DD7AF628c24E9FC75eb2986b130b2125ad0" },
  { name: "Wintermute", tag: "Wintermute 4", wallet: "0xf8191D98ae98d2f7aBDFB63A9b0b812b93C873AA" },
  { name: "Wintermute", tag: "Wintermute 5", wallet: "0xCe84449A8Ebec019AC110a4b6662E55d0fD9f228" },
  { name: "B2C2", tag: "B2C2 Group 1", wallet: "0xC333E80eF2deC2805F239E3f1e810612D294F771" },
  { name: "Galaxy Digital", tag: "Galaxy Digital: OTC", wallet: "0x33566c9D8BE6Cf0B23795E0d380E112Be9d75836" },
];

/** What the description says of the wallets the operator added, if any. */
function added(configured: readonly MakerWallet[]): string {
  if (configured.length === 0) return "";
  const list = configured.map(({ name, wallet }) => `${name} at ${wallet}`).join(", ");
  const count = configured.length === 1 ? "one more wallet" : `${configured.length} more wallets`;
  return `This server also follows ${count} that its operator added with BRAINCHAIN_MAKER_WALLETS: ${list}. Their entries have \`source\` set to configured and the name the operator gave, and the tool does not check whose wallets they are; passed as \`wallet\`, one of them gets the same entry. `;
}

/** The most wallets BRAINCHAIN_MAKER_WALLETS can add: every answer reads each one in full. */
export const MAX_CONFIGURED = 20;

const WALLET_NAME = /^[\p{L}\p{N}][\p{L}\p{N} .&'()-]{0,39}$/u;

/**
 * The wallets BRAINCHAIN_MAKER_WALLETS adds, written as `Name=0xAddress,Name2=0xAddress2`. An address the tool already
 * follows, or one named twice, would answer two ways, so it is refused. A part that is wrong is named by its place and
 * never repeated: a value in the wrong variable can be a key.
 */
export function configuredMakers(value: string | undefined): MakerWallet[] {
  const given = value?.trim();
  if (!given) return [];
  const entries = given.split(",");
  if (entries.length > MAX_CONFIGURED) throw new Error(`BRAINCHAIN_MAKER_WALLETS can add at most ${MAX_CONFIGURED} wallets, and it lists ${entries.length}.`);
  const wallets: MakerWallet[] = [];
  entries.forEach((entry, i) => {
    const which = `wallet ${i + 1} in BRAINCHAIN_MAKER_WALLETS`;
    const parts = entry.split("=").map((part) => part.trim());
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new Error(`BRAINCHAIN_MAKER_WALLETS must list wallets as Name=0xAddress, separated by commas, such as Acme=0x0000000000000000000000000000000000000001; ${which} is not written that way.`);
    }
    const [name, address] = parts as [string, string];
    if (!WALLET_NAME.test(name)) throw new Error(`The name of ${which} must be 1 to 40 letters, digits, spaces or . & ' ( ) -, starting with a letter or digit.`);
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error(`The address of ${which} must be 0x followed by 40 hex characters.`);
    // An address with no small letters carries no checksum, as one with no capitals does.
    const plain = /[a-f]/.test(address) ? address : address.toLowerCase();
    if (!isAddress(plain)) throw new Error(`The capital and small letters in the address of ${which} do not match its checksum, which usually means a character was mistyped. If the address is right, write it in lowercase.`);
    const wallet = getAddress(plain);
    const followed = MARKET_MAKERS.find((maker) => isAddressEqual(maker.wallet, wallet));
    if (followed) throw new Error(`The address of ${which}, ${wallet}, is one of ${followed.name}'s, which the tool already follows. Leave it out.`);
    if (wallets.some((earlier) => isAddressEqual(earlier.wallet, wallet))) throw new Error(`BRAINCHAIN_MAKER_WALLETS names ${wallet} twice.`);
    wallets.push({ name, source: "configured", wallet });
  });
  return wallets;
}

/** The tool as this server describes it, with the wallets its operator added. */
export function makersTool(configured: readonly MakerWallet[] = []): Tool {
    return {
    name: MAKERS_NAME,
    title: "A market maker's holdings and first approval of a Robinhood Chain token",
    description:
      "How much of a Robinhood Chain token a market maker's trading wallet holds, and when that wallet first approved the token, read from the chain. " +
      "An approval is a transaction in which a wallet gives a contract permission to move its holdings of one token. " +
      "A market maker makes one when it is getting ready to trade a token, which can be before an exchange lists the token: " +
      "Wintermute's trading contract first approved Cash Cat on August 5, 2026, and Robinhood listed that token on August 6, 2026. " +
      "A first approval is a lead to look into: it does not say why the market maker wants the token, and it does not mean an exchange will list it. " +
      "Pass the token's contract address as `token`; the `contract` of an entry from brainchain_custody_additions works. " +
      "The tool follows five wallets at three firms: Wintermute's trading contract at 0x51C72848c68a965f66FA7a88855F9f7784502a7F, two more Wintermute wallets, one B2C2 wallet and one Galaxy Digital wallet. " +
      "Etherscan tags the contract's address as a market maker and Arkham attributes it to Wintermute. The other four are plain wallets with a public name tag on Etherscan, which each entry repeats as `tag`. " +
      added(configured) +
      "To read another wallet instead, pass its address as `wallet`. Unless it is one of the five, its entry has no `name` or `tag`, and the tool does not check whose wallet it is. " +
      "In the answer, `token` holds the token's `contract`, the `name` and `symbol` the contract gives itself, its `decimals` and its `totalSupply`, counted in tokens and not in the token's smallest unit. " +
      "Whoever deployed the contract chose the name and symbol, so they do not prove which token it is. " +
      "`wallets` has one entry for each wallet read: the `wallet`, the firm's `name`, the `tag`, the `balance` it holds now, also counted in tokens, and `shareOfSupplyPct`, that balance as a percentage of the total supply, which is left out for a token with no supply. " +
      "`firstApproval` is there only if the token's log shows an approval by the wallet: `at` is when, `block` is the block it is in, `spender` is the contract it gave permission to, and `transaction` is the transaction's hash. " +
      "`confirmed` is true when the wallet took part in that transaction: the wallet sent it, it was sent to the wallet or, for Wintermute's trading contract, it was sent to the Safe at 0x7d330DD7AF628c24E9FC75eb2986b130b2125ad0. " +
      "Every approval of the Cash Cat and Pons tokens by that contract has gone through that Safe. When `confirmed` is false, the token's own log is the only sign of the approval. " +
      "A token's contract writes its own balances and logs, so whoever deployed a token can make any wallet appear to hold it or to have approved it, and anyone can send a wallet tokens. " +
      "For a token whose origin you do not know, a `balance` therefore proves little, and a `firstApproval` counts only when its `confirmed` is true. " +
      "A wallet with a zero `balance` and no `firstApproval` holds none of the token now and has never approved it. A market maker also trades from other wallets, so that does not mean the firm holds none. " +
      "`readAt` is when the chain was read. " +
      "Without `atBlock` or `at`, each `balance` is what the wallet holds at `block`, the newest block when the chain was read, and the entry is marked `currentOnly`: it shows nothing of what could be seen earlier, so leave it out of a backtest. " +
      "To read the balances at a past block, pass its number as `atBlock`, or pass `at`, a time in ISO 8601 such as 2026-11-01T00:00:00Z, for the last block made at or before it. " +
      "Robinhood Chain's public endpoint keeps no state that old, so the tool adds up the token's Transfer logs to and from each wallet up to that block. " +
      "It checks the method at the newest block, where the same sum must equal what the token's own `balanceOf` says. " +
      "`asOf` then gives the `block` asked for and when it was made (`at`), and `transfersCheck` gives the `block` checked and whether the check `passed`. " +
      "If it did not, the token's balances do not follow its transfers, as with a token that rebases or takes a fee on each transfer, and no past `balance` is given: `transfersCheck` names the first `wallet` that differs, what its `transfers` add up to and what `balanceOf` says. " +
      "A past entry has no `shareOfSupplyPct`, since the supply at that block is not read, and `token` is read at the newest block. `firstApproval` is the first approval whenever it was made, so compare its `block` with the one asked for. " +
      "The tool answers one request at a time, so requests sent together are answered in turn. " +
      "The first answer for a token can take half a minute, because the tool reads the token's whole history for each wallet; later ones are faster for as long as the server keeps running. " +
      "At a past block it also reads every transfer of the token to and from each wallet, which can take several tries for a wallet that trades the token often. " +
      "An answer that is not ready after 45 seconds says so, and asking again goes on from where it stopped. " +
      "Free, no key and no payment. Not advice.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        token: { type: "string", description: "The token's contract address on Robinhood Chain: 0x followed by 40 hex characters." },
        wallet: { type: "string", description: "Optional: the address of another wallet or contract to read instead of the wallets the tool follows." },
        atBlock: { type: "integer", minimum: 0, description: "Optional: a block number. The balances are those at the end of that block, added up from the token's transfers." },
        at: { type: "string", description: "Optional, in place of atBlock: a time in ISO 8601, such as 2026-11-01T00:00:00Z. The balances are those at the last block made at or before it." },
      },
      required: ["token"],
      additionalProperties: false,
    },
  };
}

export const MAKERS_TOOL = makersTool();

export interface Approval extends Dated {
  spender: Address;
  /** Whether the transaction was sent by the wallet, to it or to its Safe. The token's contract writes the log, so its deployer can write one for any wallet. */
  confirmed: boolean;
}

export interface MakerHolding {
  name?: string;
  tag?: string;
  wallet: Address;
  /** Left out at a past block when the token's balances do not follow its transfers. */
  balance?: string;
  /** The block the balance is at, and when it was read. */
  block: number;
  readAt: string;
  /** A balance read now, which a backtest must not take for one that could be seen at an earlier block. */
  currentOnly?: true;
  /** Left out for a token with no supply, for a balance above the supply, which only a broken token reports, and for a past balance. */
  shareOfSupplyPct?: string;
  firstApproval?: Approval;
}

/** Whether each wallet's transfers, added up to the newest block, come to what the token says it holds there. */
export interface TransfersCheck {
  block: number;
  passed: boolean;
  /** For a check that did not pass, the first wallet that differs and both figures, counted in tokens. */
  wallet?: Address;
  transfers?: string;
  balanceOf?: string;
}

export interface MakerBoard {
  chain: "Robinhood Chain";
  token: { contract: Address; name?: string; symbol?: string; decimals: number; totalSupply: string };
  readAt: string;
  /** For balances at a past block: the block and when it was made. */
  asOf?: { block: number; at: string };
  transfersCheck?: TransfersCheck;
  wallets: MakerHolding[];
}

/**
 * What was found in the stretches already read: each wallet's first approval of a token, where each token's approvals
 * and transfers begin, what each wallet was sent and sent out in a range of blocks, and when blocks were made.
 */
export interface MakerKept {
  approvals: Kept<Approval>;
  starts: Kept<bigint>;
  transfers: Map<string, Promise<bigint>>;
  times: Map<string, Promise<bigint>>;
}

const approvalEvent = parseAbiItem("event Approval(address indexed owner, address indexed spender, uint256 value)");

/**
 * The first time `maker.wallet` approved `token` between two blocks. Some tokens log an approval at every transfer a
 * spender makes, and only the first one is wanted.
 */
async function firstApproval(reader: ChainHistory, token: Address, maker: MakerWallet, from: bigint, to: bigint): Promise<Approval | undefined> {
  const { wallet, safe } = maker;
  const first = await earliestLog(
    (low, high) => reader.getLogs({ address: token, event: approvalEvent, args: { owner: wallet }, fromBlock: low, toBlock: high, strict: true }),
    from,
    to,
    // An approval of zero takes a spender's allowance away.
    (log) => log.args.value > 0n,
    () => new ChainError(`The contract at ${token} logged more than 10,000 approvals for ${wallet} in a single block, more than this tool can read, so it cannot answer for this token and wallet. Trying again will not change that.`),
  );
  if (!first) return undefined;
  const at = await blockTime(reader, first.blockNumber);
  const sent = await reader.getTransaction({ hash: first.transactionHash });
  const own = (address: Address | null) => address !== null && (isAddressEqual(address, wallet) || (safe !== undefined && isAddressEqual(address, safe)));
  return { at, block: Number(first.blockNumber), transaction: first.transactionHash, spender: first.args.spender, confirmed: isAddressEqual(sent.from, wallet) || own(sent.to) };
}

/** `part` of `whole` in percent, to four places, rounded half up. */
const percent = (part: bigint, whole: bigint) => (Number((part * 2_000_000n + whole) / (2n * whole)) / 10_000).toFixed(4);

/**
 * The start of the first stretch in which `token` logged an approval by anyone. No wallet approved it before that, so
 * each wallet's search starts there, which saves most of the reading for a token that is new, and all of it for one
 * nobody has approved. A stretch too full to return counts, since it has approvals, and so does one the endpoint took
 * too long to search, which only a busy token's is.
 */
function approvalsStart(reader: ChainHistory, token: Address, newest: bigint, kept: Kept<bigint>): Promise<bigint | undefined> {
  return firstSince(kept, `${token}:approvals`, newest, (from, to) =>
    reader.getLogs({ address: token, event: approvalEvent, fromBlock: from, toBlock: to, strict: true }).then(
      (logs) => (logs.length > 0 ? from : undefined),
      (error: unknown) => {
        if (tooMany(error) || tooSlow(error)) return from;
        throw error;
      },
    ),
  );
}

/**
 * What `holder` held of `token` at `block` and at `newest`, as its Transfer logs add up, read a stretch at a time from
 * `start`. The stretch that holds `block` is read in two parts, so every whole stretch is the same range from one block
 * asked for to the next, and is kept once it has settled.
 */
async function rebuilt(reader: ChainHistory, token: Address, holder: Address, start: bigint, block: bigint, newest: bigint, kept: Map<string, Promise<bigint>>): Promise<{ then: bigint; now: bigint }> {
  let then = 0n;
  let now = 0n;
  for (let from = (start / STRETCH_BLOCKS) * STRETCH_BLOCKS; from <= newest; from += STRETCH_BLOCKS) {
    const end = from + STRETCH_BLOCKS - 1n < newest ? from + STRETCH_BLOCKS - 1n : newest;
    const parts: [bigint, bigint][] = from <= block && block < end ? [[from, block], [block + 1n, end]] : [[from, end]];
    for (const [low, high] of parts) {
      const net = (await transferred(reader, token, holder, "to", low, high, newest, kept)) - (await transferred(reader, token, holder, "from", low, high, newest, kept));
      now += net;
      if (high <= block) then += net;
    }
  }
  return { then, now };
}

/** Each wallet's first approval of `token`, in the order the wallets were given, found in the token's logs a stretch at a time (see `firstSince`). */
export async function firstApprovals(reader: ChainHistory, token: Address, wallets: readonly MakerWallet[], kept: Pick<MakerKept, "approvals" | "starts">, newest: bigint): Promise<(Approval | undefined)[]> {
  const start = await approvalsStart(reader, token, newest, kept.starts);
  const first: (Approval | undefined)[] = [];
  for (const maker of wallets) first.push(start === undefined ? undefined : await firstSince(kept.approvals, `${token}:${maker.wallet}`, newest, (from, to) => firstApproval(reader, token, maker, from, to), start));
  return first;
}

/**
 * What each wallet holds of `token` at the newest block, and the first time it approved the token. Given `moment`, the
 * balances are those at a past block instead, added up from the token's Transfer logs, since the endpoint keeps no state
 * that old. The same sum up to the newest block must come to each wallet's balance there, or the token's balances do not
 * follow its transfers and no past balance is given.
 */
export async function makerHoldings(reader: ChainHistory, token: Address, wallets: readonly MakerWallet[], kept: MakerKept, now = new Date(), moment?: Moment): Promise<MakerBoard> {
  const newest = await reader.getBlockNumber();
  const facts = await tokenFacts(
    reader,
    token,
    wallets.map(({ wallet }) => wallet),
    newest,
  );
  if (!facts) throw noContract(token);
  const { decimals, supply, name, symbol, balances } = facts;
  const first = await firstApprovals(reader, token, wallets, kept, newest);
  const readAt = now.toISOString();
  const who = ({ name: owner, tag, source, wallet }: MakerWallet) => ({ ...(owner ? { name: owner } : {}), ...(tag ? { tag } : {}), ...(source ? { source } : {}), wallet });
  const approved = (i: number) => (first[i] ? { firstApproval: first[i] } : {});
  const board = {
    chain: "Robinhood Chain" as const,
    token: { contract: token, ...(name ? { name } : {}), ...(symbol ? { symbol } : {}), decimals, totalSupply: formatUnits(supply, decimals) },
    readAt,
  };
  if (!moment) {
    return {
      ...board,
      wallets: wallets.map((maker, i) => ({
        ...who(maker),
        balance: formatUnits(balances[i]!, decimals),
        block: Number(newest),
        readAt,
        currentOnly: true as const,
        ...(supply > 0n && balances[i]! <= supply ? { shareOfSupplyPct: percent(balances[i]!, supply) } : {}),
        ...approved(i),
      })),
    };
  }

  const asOf = await blockOf(reader, moment, newest, kept.times);
  const start = await transfersStart(reader, token, newest, kept.starts);
  const sums: { then: bigint; now: bigint }[] = [];
  for (const { wallet } of wallets) sums.push(start === undefined ? { then: 0n, now: 0n } : await rebuilt(reader, token, wallet, start, asOf.block, newest, kept.transfers));
  // A negative balance is no balance at all, whatever the newest block says.
  const differs = sums.findIndex(({ then, now: summed }, i) => summed !== balances[i] || then < 0n);
  const transfersCheck: TransfersCheck =
    differs < 0
      ? { block: Number(newest), passed: true }
      : { block: Number(newest), passed: false, wallet: wallets[differs]!.wallet, transfers: formatUnits(sums[differs]!.now, decimals), balanceOf: formatUnits(balances[differs]!, decimals) };
  return {
    ...board,
    asOf: { block: Number(asOf.block), at: asOf.at },
    transfersCheck,
    wallets: wallets.map((maker, i) => ({
      ...who(maker),
      ...(transfersCheck.passed ? { balance: formatUnits(sums[i]!.then, decimals) } : {}),
      block: Number(asOf.block),
      readAt,
      ...approved(i),
    })),
  };
}

const kept: MakerKept = { approvals: new Map(), starts: new Map(), transfers: new Map(), times: new Map() };

/** A caller who names a wallet the tool follows gets that wallet's entry, Safe included: the same address must not answer two ways. */
export function readMakerHoldings(token: Address, wallet?: Address, moment?: Moment, followed: readonly MakerWallet[] = MARKET_MAKERS): Promise<MakerBoard> {
  const wallets = wallet ? [followed.find((maker) => isAddressEqual(maker.wallet, wallet)) ?? { wallet }] : followed;
  return inTurn((reader) => makerHoldings(reader, token, wallets, kept, new Date(), moment));
}

/** The first approvals `readMakerHoldings` finds, read in a turn another tool already holds, so both share what was read. */
export const readFirstApprovals = (reader: ChainHistory, token: Address, wallets: readonly MakerWallet[], newest: bigint) => firstApprovals(reader, token, wallets, kept, newest);
