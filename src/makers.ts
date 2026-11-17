import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { formatUnits, isAddressEqual, parseAbiItem, type Address } from "viem";

import { blockTime, ChainError, earliestLog, firstSince, inTurn, noContract, tokenFacts, tooMany, tooSlow, type ChainHistory, type Dated, type Kept } from "./history.js";

export const MAKERS_NAME = "brainchain_market_maker_holdings";

export interface MakerWallet {
  /** The firm the wallet belongs to; a wallet the caller named has none. */
  name?: string;
  /** The public name tag that says so, as Etherscan shows it for the address on Ethereum. */
  tag?: string;
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

export const MAKERS_TOOL: Tool = {
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
    "The tool answers one request at a time, so requests sent together are answered in turn. " +
    "The first answer for a token can take half a minute, because the tool reads the token's whole history for each wallet; later ones are faster for as long as the server keeps running. " +
    "An answer that is not ready after 45 seconds says so, and asking again goes on from where it stopped. " +
    "Free, no key and no payment. Not advice.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: {
    type: "object",
    properties: {
      token: { type: "string", description: "The token's contract address on Robinhood Chain: 0x followed by 40 hex characters." },
      wallet: { type: "string", description: "Optional: the address of another wallet or contract to read instead of the wallets the tool follows." },
    },
    required: ["token"],
    additionalProperties: false,
  },
};

export interface Approval extends Dated {
  spender: Address;
  /** Whether the transaction was sent by the wallet, to it or to its Safe. The token's contract writes the log, so its deployer can write one for any wallet. */
  confirmed: boolean;
}

export interface MakerHolding {
  name?: string;
  tag?: string;
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

/** What was found in the stretches already read: each wallet's first approval of a token, and where each token's approvals begin. */
export interface MakerKept {
  approvals: Kept<Approval>;
  starts: Kept<bigint>;
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
 * What each wallet holds of `token` now, and the first time it approved the token, found in the token's logs a stretch
 * at a time (see `firstSince`).
 */
export async function makerHoldings(reader: ChainHistory, token: Address, wallets: readonly MakerWallet[], kept: MakerKept, now = new Date()): Promise<MakerBoard> {
  const facts = await tokenFacts(
    reader,
    token,
    wallets.map(({ wallet }) => wallet),
  );
  if (!facts) throw noContract(token);
  const { decimals, supply, name, symbol, balances } = facts;
  const newest = await reader.getBlockNumber();
  const start = await approvalsStart(reader, token, newest, kept.starts);
  const first: (Approval | undefined)[] = [];
  for (const maker of wallets) first.push(start === undefined ? undefined : await firstSince(kept.approvals, `${token}:${maker.wallet}`, newest, (from, to) => firstApproval(reader, token, maker, from, to), start));
  return {
    chain: "Robinhood Chain",
    token: { contract: token, ...(name ? { name } : {}), ...(symbol ? { symbol } : {}), decimals, totalSupply: formatUnits(supply, decimals) },
    readAt: now.toISOString(),
    wallets: wallets.map(({ name: owner, tag, wallet }, i) => ({
      ...(owner ? { name: owner } : {}),
      ...(tag ? { tag } : {}),
      wallet,
      balance: formatUnits(balances[i]!, decimals),
      ...(supply > 0n && balances[i]! <= supply ? { shareOfSupplyPct: percent(balances[i]!, supply) } : {}),
      ...(first[i] ? { firstApproval: first[i] } : {}),
    })),
  };
}

const kept: MakerKept = { approvals: new Map(), starts: new Map() };

/** A caller who names a wallet the tool follows gets that wallet's entry, Safe included: the same address must not answer two ways. */
export function readMakerHoldings(token: Address, wallet?: Address): Promise<MakerBoard> {
  const wallets = wallet ? [MARKET_MAKERS.find((maker) => isAddressEqual(maker.wallet, wallet)) ?? { wallet }] : MARKET_MAKERS;
  return inTurn((reader) => makerHoldings(reader, token, wallets, kept));
}
