import { readFileSync } from "node:fs";

import { getAddress, type Address, type Hash } from "viem";
import { describe, expect, it, vi } from "vitest";

import type { CustodyBoard, CustodyToken } from "./custody.js";
import type { ChainHistory } from "./history.js";
import { configuredMakers, MARKET_MAKERS, type Approval, type MakerWallet } from "./makers.js";
import type { QueuedPool } from "./queued.js";
import type { ReadinessBoard } from "./readiness.js";
import type { SightingsBoard } from "./sightings.js";
import { TIMELINE_NAME, TIMELINE_TOOL, tokenTimeline, type TimelineReaders } from "./timeline.js";

const CASHCAT = getAddress("0x020bfc650a365f8bb26819deaabf3e21291018b4");
const WETH = getAddress("0x0bd7d308f8e1639fab988df18a8011f41eacad73");
const LAUNCHER = getAddress("0xd9ec2db5f3d1b236843925949fe5bd8a3836fccb");
const SPENDER = getAddress("0x520ed467860d840ec6ca20f1dacb9c0fa5168aa7");
const OTHER = getAddress("0xb97e4298c7f5f55360d207a6196125376675b3ea");
const USDG = getAddress("0x5fc5360d0400a0fd4f2af552add042d716f1d168");
const CASHCAT_USDG = getAddress("0x4b0c312ffbb068f6a0bea128759e35d94b94d0e1");
const hash = (byte: string) => `0x${byte.repeat(32)}` as Hash;
const NOW = new Date("2026-08-07T00:00:00Z");
const NEWEST = 29_000_000n;

// Cash Cat's steps as the tools read them on 2026-11-16 and 2026-11-17: minted and pooled on Uniswap v3 in one transaction,
// pooled on v4 two weeks later, on Trust Wallet's and MetaMask's lists on July 8, merged by BitGo on July 28, and first
// approved by Wintermute's trading contract on August 5, the day before Robinhood listed it.
const MINT = { at: "2026-06-18T20:01:25.000Z", block: 88_836, transaction: hash("0e"), to: LAUNCHER };
const V3 = { venue: "Uniswap v3" as const, at: MINT.at, block: 88_836, transaction: MINT.transaction, pairedWith: WETH };
const V4 = { venue: "Uniswap v4" as const, at: "2026-07-01T19:07:10.000Z", block: 820_611, transaction: hash("a4"), pairedWith: "ETH" as const };
const APPROVAL: Approval = { at: "2026-08-05T10:32:17.000Z", block: 28_416_243, transaction: hash("36"), spender: SPENDER, confirmed: true };
// Wintermute's multisig queued Cash Cat's Uniswap v3 pool with USDG on its role registry on August 3, and the role took effect on August 5.
const QUEUED: QueuedPool = {
  at: "2026-08-03T17:47:19.000Z",
  block: 26_953_337,
  transaction: hash("b1"),
  venue: "Uniswap v3",
  pool: CASHCAT_USDG,
  currency0: CASHCAT,
  currency1: USDG,
  fee: 10_000,
  role: hash("d5"),
  granted: { at: "2026-08-05T10:23:40.000Z", block: 28_411_079, transaction: hash("c6") },
  confirmed: true,
};
const MERGE = "https://github.com/BitGo/BitGoJS/commit/9c1f2d0b4a3e5f6789012345678901234567abcd";
const TRUST = "https://github.com/trustwallet/assets/blob/master/blockchains/robinhoodchain/assets/0x020bfC650A365f8BB26819deAAbF3E21291018b4/info.json";
const METAMASK = "https://github.com/MetaMask/contract-metadata/blob/master/metadata/eip155:4663/erc20:0x020bfC650A365f8BB26819deAAbF3E21291018b4.json";

/** Block times through the blocks the steps are in, straight between them, after a genesis at zero as Robinhood Chain's is. */
const POINTS: [bigint, number][] = [
  [0n, 0],
  [1n, Date.parse("2026-04-30T16:52:11Z") / 1000],
  [88_836n, Date.parse(MINT.at) / 1000],
  [820_611n, Date.parse(V4.at) / 1000],
  [26_953_337n, Date.parse(QUEUED.at) / 1000],
  [28_411_079n, Date.parse(QUEUED.granted!.at) / 1000],
  [28_416_243n, Date.parse(APPROVAL.at) / 1000],
  [NEWEST, Date.parse("2026-08-06T23:59:00Z") / 1000],
];
function clock(block: bigint): number {
  const after = POINTS.findIndex(([at]) => at >= block);
  const [high, highAt] = POINTS[after]!;
  if (high === block || after === 0) return highAt;
  const [low, lowAt] = POINTS[after - 1]!;
  return lowAt + Math.floor(((highAt - lowAt) * Number(block - low)) / Number(high - low));
}

const readiness = (more: Partial<ReadinessBoard> = {}): ReadinessBoard => ({
  chain: "Robinhood Chain",
  token: { contract: CASHCAT, name: "Cash Cat", symbol: "CASHCAT", decimals: 18, totalSupply: "1000000000" },
  readAt: NOW.toISOString(),
  deployed: true,
  firstMint: MINT,
  pools: [V3, V4],
  ...more,
});
const custody = (additions: CustodyBoard["additions"] = [{ addedAt: "2026-07-28T07:09:00.000Z", commit: MERGE, tokens: [{ id: "hoodeth:cashcat", name: "Cash Cat", contract: CASHCAT, decimals: 18 }] }]): CustodyBoard => ({
  chain: "Robinhood Chain",
  source: "https://github.com/BitGo/BitGoJS/tree/master/modules/statics/src/coins",
  readAt: NOW.toISOString(),
  since: "2026-05-09T00:00:00.000Z",
  additions,
});
const LISTED: CustodyToken[] = [{ id: "hoodeth:cashcat", name: "Cash Cat", contract: CASHCAT, decimals: 18 }];
const sightings = (more: Partial<SightingsBoard> = {}): SightingsBoard => ({
  chain: "Robinhood Chain",
  token: { contract: CASHCAT, symbol: "CASHCAT", name: "Cash Cat" },
  readAt: "2026-08-06T23:58:00.000Z",
  lists: [
    { source: "Trust Wallet", listed: true, since: "2026-07-08T14:20:00.000Z", link: TRUST },
    { source: "MetaMask", listed: true, since: "2026-07-08T16:02:11.000Z", link: METAMASK },
    { source: "LI.FI", listed: true },
    { source: "CoinGecko", listed: false },
  ],
  exchanges: [{ source: "KuCoin", listed: true, deposits: true, withdrawals: true }],
  robinhood: [{ symbol: "CASHCAT", page: true, pair: true, name: "Cash Cat", tradable: true }],
  unread: [],
  ...more,
});

/** The sources as `tokenTimeline` meets them, each one replaceable, with what was asked of the chain. */
function sources(more: Partial<TimelineReaders> = {}, { created = undefined as Address | undefined } = {}) {
  const asked: string[] = [];
  const reader = {
    async getBlockNumber() {
      asked.push("newest");
      return NEWEST;
    },
    async getBlock({ blockNumber }: { blockNumber: bigint }) {
      asked.push(`block ${blockNumber}`);
      return { timestamp: BigInt(clock(blockNumber)) };
    },
    async getTransactionReceipt({ hash: transaction }: { hash: Hash }) {
      asked.push(`receipt ${transaction.slice(0, 4)}`);
      return { contractAddress: created ?? null };
    },
  } as unknown as ChainHistory;
  const readers: TimelineReaders = {
    chain: (read) => read(reader),
    readiness: async () => (asked.push("readiness"), readiness()),
    approvals: async (_reader, _token, wallets) => (asked.push("approvals"), wallets.map((_, i) => (i === 0 ? APPROVAL : undefined))),
    queued: async (_reader, _token, wallets) => (asked.push("queued"), wallets.map((_, i) => (i === 0 ? QUEUED : undefined))),
    custody: async () => custody(),
    listed: async () => LISTED,
    sightings: async () => sightings(),
    ...more,
  };
  return { readers, asked };
}

const timeline = (readers: TimelineReaders, until?: Parameters<typeof tokenTimeline>[4], wallets: readonly MakerWallet[] = MARKET_MAKERS) => tokenTimeline(readers, CASHCAT, wallets, new Map(), until, NOW);
const kinds = (board: Awaited<ReturnType<typeof timeline>>) => board.steps.map(({ step, source }) => `${step} ${source}`);

describe("the timeline tool's words", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const row = readme.split("\n").find((line) => line.startsWith(`| \`${TIMELINE_NAME}\` |`))!;
  const paragraph = readme.split("\n").find((line) => line.startsWith(`\`${TIMELINE_NAME}\` puts `))!;

  it("say that it lists dated public steps and forecasts nothing, in the description and in the README", () => {
    for (const text of [TIMELINE_TOOL.description!, paragraph]) {
      expect(text).toContain("The tool lists dated public steps and does not forecast a listing, so it gives no score.");
      expect(text).toContain("A step is a lead to look into: none says why it happened, and together they do not mean an exchange will list the token.");
      expect(text).toContain("Robinhood, Bitstamp, KuCoin, Gate, LI.FI and CoinGecko publish no date for a listing");
      expect(text).toContain("BitGo's merges are read from May 11, 2026, when BitGo added its first Robinhood Chain token, so a token BitGo added at any time since has its merge, including one it has since removed");
      expect(text).toContain("A token BitGo removed again within 16 merges, a few days at its pace, can be missed.");
      expect(text).toContain("about a dozen of the 60 requests an hour GitHub allows one IP address without a key");
      expect(text).not.toContain("90 days");
      expect(text).not.toMatch(/guarantee|will be listed|insider|likely|probab|signal strength/i);
    }
    expect(TIMELINE_TOOL.description).toMatch(/Free, no key and no payment\. Not advice\.$/);
    expect(TIMELINE_TOOL.description).not.toContain("\u2014");
  });

  it("say in plain words what a queued pool is, and when Cash Cat's was, in the description and in the README", () => {
    for (const text of [TIMELINE_TOOL.description!, paragraph]) {
      expect(text).toContain("market maker added one of the token's pools to its trading contracts' approved list");
      expect(text).toContain("Wintermute's multisig adds each pool its trading contracts may trade by queuing it on the role registry they read");
      expect(text).toContain("Cash Cat's first pool on August 3, 2026, and its trading contract first approved the token on August 5");
    }
    expect(row).toContain("`pool_queued`");
  });

  it("name the answer's fields as the answer does", () => {
    const fields = ["`steps`", "`at`", "`step`", "`source`", "`block`", "`transaction`", "`custody`", "`id`", "`name`", "`commit`", "`deploy`", "`mint`", "`to`", "`pool`", "`pairedWith`", "`pool_queued`", "`venue`", "`granted`", "`approval`", "`maker`", "`spender`", "`confirmed`", "`listing`", "`link`", "`until`", "`undated`", "`by`", "`withheld`", "`deployed`", "`token`", "`contract`", "`symbol`", "`unread`", "`readAt`", "`atBlock`"];
    for (const text of [TIMELINE_TOOL.description!, row]) for (const field of fields) expect(text, field).toContain(field);
  });

  it("are counted with the free tools that only read, and ask for the token and an optional cut-off", () => {
    expect(TIMELINE_TOOL.annotations).toEqual({ readOnlyHint: true, openWorldHint: true });
    expect(TIMELINE_TOOL.inputSchema).toMatchObject({ required: ["token"], additionalProperties: false });
    expect(Object.keys(TIMELINE_TOOL.inputSchema.properties!)).toEqual(["token", "atBlock", "at"]);
    expect(readme).toContain(`- \`${TIMELINE_NAME}\` `);
    expect(row).toContain("Free, no key.");
  });
});

describe("tokenTimeline", () => {
  it("puts every dated step in one list, oldest first, each with the source it was read from", async () => {
    const { readers } = sources();
    expect(await timeline(readers)).toEqual({
      chain: "Robinhood Chain",
      token: { contract: CASHCAT, name: "Cash Cat", symbol: "CASHCAT" },
      readAt: NOW.toISOString(),
      deployed: true,
      steps: [
        { at: MINT.at, step: "mint", source: "Robinhood Chain", block: 88_836, transaction: MINT.transaction, to: LAUNCHER },
        { at: MINT.at, step: "pool", source: "Uniswap v3", block: 88_836, transaction: MINT.transaction, pairedWith: WETH },
        { at: V4.at, step: "pool", source: "Uniswap v4", block: 820_611, transaction: V4.transaction, pairedWith: "ETH" },
        { at: "2026-07-08T14:20:00.000Z", step: "listing", source: "Trust Wallet", link: TRUST },
        { at: "2026-07-08T16:02:11.000Z", step: "listing", source: "MetaMask", link: METAMASK },
        { at: "2026-07-28T07:09:00.000Z", step: "custody", source: "BitGo", id: "hoodeth:cashcat", name: "Cash Cat", commit: MERGE },
        {
          at: QUEUED.at,
          step: "pool_queued",
          source: "Robinhood Chain",
          block: 26_953_337,
          transaction: QUEUED.transaction,
          maker: { name: "Wintermute", tag: "Market Maker: 0x51c7...2a7f", wallet: MARKET_MAKERS[0]!.wallet },
          venue: "Uniswap v3",
          pool: CASHCAT_USDG,
          pairedWith: USDG,
          granted: QUEUED.granted,
          confirmed: true,
        },
        {
          at: APPROVAL.at,
          step: "approval",
          source: "Robinhood Chain",
          block: 28_416_243,
          transaction: APPROVAL.transaction,
          maker: { name: "Wintermute", tag: "Market Maker: 0x51c7...2a7f", wallet: MARKET_MAKERS[0]!.wallet },
          spender: SPENDER,
          confirmed: true,
        },
      ],
      undated: [],
      unread: [],
    });
  });

  it("dates the contract's creation only when the transaction that first minted the token created it", async () => {
    const made = sources({}, { created: CASHCAT });
    const board = await timeline(made.readers);
    expect(kinds(board).slice(0, 3)).toEqual(["deploy Robinhood Chain", "mint Robinhood Chain", "pool Uniswap v3"]);
    expect(board.steps[0]).toEqual({ at: MINT.at, step: "deploy", source: "Robinhood Chain", block: 88_836, transaction: MINT.transaction });
    expect(made.asked.filter((entry) => entry.startsWith("receipt"))).toEqual(["receipt 0x0e"]);

    // A launchpad's factory created Cash Cat, so the receipt names no contract; nor does it for another contract made in that transaction.
    for (const created of [undefined, OTHER]) expect(kinds(await timeline(sources({}, { created }).readers))).not.toContain("deploy Robinhood Chain");
  });

  it("lists the approvals of the wallets it was given, named as the market maker tool names them, and only those with one", async () => {
    const wallets = [...MARKET_MAKERS, ...configuredMakers(`Acme=${OTHER}`)];
    const unconfirmed = { ...APPROVAL, block: 28_500_000, at: "2026-08-05T12:00:00.000Z", transaction: hash("37"), confirmed: false };
    const { readers } = sources({ approvals: async () => wallets.map((_, i) => (i === wallets.length - 1 ? unconfirmed : undefined)) });
    const approvals = (await timeline(readers, undefined, wallets)).steps.filter(({ step }) => step === "approval");
    expect(approvals).toEqual([
      { at: "2026-08-05T12:00:00.000Z", step: "approval", source: "Robinhood Chain", block: 28_500_000, transaction: hash("37"), maker: { name: "Acme", source: "configured", wallet: OTHER }, spender: SPENDER, confirmed: false },
    ]);
  });

  it("gives the first pool each market maker's multisig queued for its trading contracts, and only for a wallet with one", async () => {
    const wallets = [...MARKET_MAKERS, ...configuredMakers(`Acme=${OTHER}`)];
    const withEth: QueuedPool = { ...QUEUED, venue: "Uniswap v4", pool: hash("a9"), currency0: "0x0000000000000000000000000000000000000000", currency1: CASHCAT, confirmed: false };
    delete withEth.granted;
    const { readers } = sources({ queued: async () => wallets.map((_, i) => (i === 0 ? withEth : undefined)) });
    const queued = (await timeline(readers, undefined, wallets)).steps.filter(({ step }) => step === "pool_queued");
    expect(queued).toEqual([
      {
        at: QUEUED.at,
        step: "pool_queued",
        source: "Robinhood Chain",
        block: 26_953_337,
        transaction: QUEUED.transaction,
        maker: { name: "Wintermute", tag: "Market Maker: 0x51c7...2a7f", wallet: MARKET_MAKERS[0]!.wallet },
        venue: "Uniswap v4",
        pool: hash("a9"),
        pairedWith: "ETH",
        confirmed: false,
      },
    ]);
  });

  it("keeps a queued pool by its block, and says it took effect only when that was by the cut-off too", async () => {
    const { readers } = sources();
    const queued = async (until: { block: bigint }) => (await timeline(readers, until)).steps.find(({ step }) => step === "pool_queued");
    expect(await queued({ block: 26_953_336n })).toBeUndefined();
    const before = await queued({ block: 28_411_078n });
    expect(before).toMatchObject({ block: 26_953_337, pool: CASHCAT_USDG });
    expect(before).not.toHaveProperty("granted");
    expect(await queued({ block: 28_411_079n })).toMatchObject({ granted: QUEUED.granted });
  });

  it("keeps only what was public by a past block: steps on chain by their block, the others by that block's time", async () => {
    const { readers } = sources();
    const board = await timeline(readers, { block: 820_611n });
    expect(board.until).toEqual({ block: 820_611, at: V4.at });
    expect(kinds(board)).toEqual(["mint Robinhood Chain", "pool Uniswap v3", "pool Uniswap v4"]);

    const later = await timeline(readers, { block: 28_416_242n });
    expect(kinds(later)).toEqual(["mint Robinhood Chain", "pool Uniswap v3", "pool Uniswap v4", "listing Trust Wallet", "listing MetaMask", "custody BitGo", "pool_queued Robinhood Chain"]);
    expect(kinds(await timeline(readers, { block: 28_416_243n }))).toContain("approval Robinhood Chain");
  });

  it("keeps only what was public by a past time: steps on chain by the last block made by then, the others by the time itself", async () => {
    const { readers, asked } = sources();
    const time = Date.parse("2026-07-08T15:00:00Z");
    const board = await timeline(readers, { time });
    expect(board.until!.at).toBe("2026-07-08T15:00:00.000Z");
    const block = BigInt(board.until!.block);
    expect(clock(block) * 1000).toBeLessThanOrEqual(time);
    expect(clock(block + 1n) * 1000).toBeGreaterThan(time);
    expect(kinds(board)).toEqual(["mint Robinhood Chain", "pool Uniswap v3", "pool Uniswap v4", "listing Trust Wallet"]);
    expect(asked.filter((entry) => entry.startsWith("block ")).length).toBeLessThan(60);

    // A second into the block of the approval, and a millisecond before the merge.
    expect(kinds(await timeline(readers, { time: Date.parse(APPROVAL.at) + 500 }))).toContain("approval Robinhood Chain");
    expect(kinds(await timeline(readers, { time: Date.parse("2026-07-28T07:08:59.999Z") }))).not.toContain("custody BitGo");
  });

  it("gives BitGo's merge of a token already on its lists when the period read began as undated, with when it had happened by", async () => {
    const { readers } = sources({ custody: async () => custody([]) });
    const board = await timeline(readers);
    expect(kinds(board)).not.toContain("custody BitGo");
    expect(board.undated).toEqual([{ step: "custody", source: "BitGo", id: "hoodeth:cashcat", name: "Cash Cat", by: "2026-05-09T00:00:00.000Z" }]);
    expect((await timeline(readers, { time: Date.parse("2026-05-09T00:00:00Z") })).undated).toHaveLength(1);
    const before = await timeline(readers, { time: Date.parse("2026-05-08T23:59:59Z") });
    expect(before.undated).toEqual([]);
    expect(before.withheld).toEqual([{ step: "custody", source: "BitGo", id: "hoodeth:cashcat", name: "Cash Cat" }]);
  });

  it("gives a token BitGo has since removed from its lists its BitGo step", async () => {
    const { readers } = sources({ listed: async () => [] });
    const board = await timeline(readers);
    expect(board.steps.filter(({ step }) => step === "custody")).toEqual([{ at: "2026-07-28T07:09:00.000Z", step: "custody", source: "BitGo", id: "hoodeth:cashcat", name: "Cash Cat", commit: MERGE }]);
    expect(board.undated).toEqual([]);
    expect(kinds(await timeline(readers, { time: Date.parse("2026-07-28T07:09:00Z") }))).toContain("custody BitGo");
  });

  it("gives nothing for BitGo when the token is on none of its lists, and takes only the token's own entry from a merge", async () => {
    const elsewhere = { id: "hoodeth:pons", name: "Pons", contract: getAddress("0x39dbed3a2bd333467115de45665cc57f813c4571"), decimals: 18 };
    const { readers } = sources({ custody: async () => custody([{ addedAt: "2026-07-20T00:00:00.000Z", commit: MERGE, tokens: [elsewhere, { id: "hoodeth:deed" }] }]), listed: async () => [elsewhere] });
    const board = await timeline(readers);
    expect(kinds(board)).not.toContain("custody BitGo");
    expect(board.undated).toEqual([]);
  });

  it("gives a listing whose first commit could not be dated as undated, as of when the lists were read", async () => {
    const { readers } = sources({ sightings: async () => sightings({ lists: [{ source: "Trust Wallet", listed: true, link: TRUST }, { source: "MetaMask", listed: false }] }) });
    const board = await timeline(readers);
    expect(kinds(board).filter((kind) => kind.startsWith("listing"))).toEqual([]);
    expect(board.undated).toEqual([{ step: "listing", source: "Trust Wallet", link: TRUST, by: "2026-08-06T23:58:00.000Z" }]);
    expect(board).not.toHaveProperty("withheld");
    // Before the lists were read the listing cannot be placed, so it is named rather than dropped.
    const cut = await timeline(readers, { block: 820_611n });
    expect(cut.undated).toEqual([]);
    expect(cut.withheld).toEqual([{ step: "listing", source: "Trust Wallet", link: TRUST }]);
    expect((await timeline(readers, { time: Date.parse("2026-08-06T23:58:00Z") })).withheld).toEqual([]);
  });

  it("leaves out a list's entry for a token it does not list, or only warns about", async () => {
    const { readers } = sources({ sightings: async () => sightings({ lists: [{ source: "Trust Wallet", listed: false, status: "spam" }, { source: "MetaMask", listed: false }] }) });
    const board = await timeline(readers);
    expect(kinds(board).filter((kind) => kind.startsWith("listing"))).toEqual([]);
    expect(board.undated).toEqual([]);
  });

  it("names a source it could not read, and goes on without it", async () => {
    const failed = async (): Promise<never> => {
      throw new Error("GitHub answered 502.");
    };
    for (const [more, unread, missing] of [
      [{ custody: failed }, ["BitGo"], "custody BitGo"],
      [{ listed: failed }, ["BitGo"], "custody BitGo"],
      [{ sightings: failed }, ["Trust Wallet", "MetaMask"], "listing Trust Wallet"],
      [{ sightings: async () => sightings({ lists: sightings().lists.filter(({ source }) => source !== "MetaMask"), unread: ["MetaMask", "KuCoin"] }) }, ["MetaMask"], "listing MetaMask"],
    ] as const) {
      const board = await timeline(sources(more).readers);
      expect(board.unread).toEqual(unread);
      expect(kinds(board)).not.toContain(missing);
      expect(kinds(board)).toContain("mint Robinhood Chain");
    }
  });

  it("fails as the chain tools do when the chain cannot be read", async () => {
    const refused = Object.assign(new Error("HTTP request failed."), { status: 429 });
    await expect(timeline(sources({ chain: async () => Promise.reject(refused) }).readers)).rejects.toBe(refused);
  });

  it("gives a token BitGo lists before its contract exists its BitGo step, and reads nothing more of the chain", async () => {
    const { readers, asked } = sources({ readiness: async () => ({ chain: "Robinhood Chain", token: { contract: CASHCAT }, readAt: NOW.toISOString(), deployed: false }) });
    const board = await timeline(readers);
    expect(board).toMatchObject({ token: { contract: CASHCAT }, deployed: false });
    expect(kinds(board)).toEqual(["listing Trust Wallet", "listing MetaMask", "custody BitGo"]);
    expect(asked).toEqual(["newest"]);
  });

  it("orders steps of the same block by what leads to what, and of the same second by block", async () => {
    const sameSecond = { ...APPROVAL, at: V4.at, block: 820_610 };
    const { readers } = sources({ approvals: async (_reader, _token, wallets) => wallets.map((_, i) => (i === 0 ? sameSecond : undefined)) }, { created: CASHCAT });
    expect(kinds(await timeline(readers)).slice(0, 5)).toEqual(["deploy Robinhood Chain", "mint Robinhood Chain", "pool Uniswap v3", "approval Robinhood Chain", "pool Uniswap v4"]);
  });
});

describe("readTokenTimeline", () => {
  it("says after 45 seconds that it is still reading", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    try {
      const fresh = await import("./timeline.js");
      const history = await import("./history.js");
      const late = expect(fresh.readTokenTimeline(CASHCAT)).rejects.toStrictEqual(new history.ChainError(history.STILL_READING));
      await vi.advanceTimersByTimeAsync(44_999);
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      await vi.advanceTimersByTimeAsync(1);
      await late;
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});
