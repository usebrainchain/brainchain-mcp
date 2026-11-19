import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EventLog } from "./events.js";
import { Requests } from "./http.js";
import { listMerges, listPullRequests, METAMASK, TRUST_WALLET } from "./lists.js";
import { StateFile } from "./state.js";
import { Watcher, type Poller } from "./watcher.js";

const CASHCAT = "0x020bfC650A365f8BB26819deAAbF3E21291018b4";
const RCL = "0x1320b310E523B8fA89048Dcc3611A73c33F51320";
const FAKE = "0x0000000000000000000000000000000000000BaD";
const sha = (char: string) => char.repeat(40);

function routes(table: Record<string, () => Response>) {
  const asked: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    asked.push(String(input));
    return table[String(input)]?.() ?? new Response("Not Found", { status: 404 });
  }) as typeof fetch;
  return { requests: new Requests({ fetch: fetchImpl }), asked, table };
}

function harness(poller: Poller) {
  const dir = mkdtempSync(join(tmpdir(), "brainchain-watch-"));
  const log = new EventLog(dir);
  const watcher = new Watcher({ log, state: new StateFile(dir), pollers: [poller], say: () => {} });
  return { log, run: () => watcher.runOnce(poller) };
}

const json = (value: unknown, etag?: string) => () => new Response(JSON.stringify(value), { headers: etag ? { etag } : {} });
const info = (symbol: string, name: string, status = "active") => json({ name, symbol, type: "ROBINHOODCHAIN", decimals: 18, status });

describe("the MetaMask pull request poller", () => {
  const PULLS = "https://api.github.com/repos/MetaMask/contract-metadata/pulls?state=open&sort=updated&direction=desc&per_page=50";
  const FILES = (n: number) => `https://api.github.com/repos/MetaMask/contract-metadata/pulls/${n}/files?per_page=100&page=1`;
  const opened = (number: number, head: string, createdAt: string) => ({
    number,
    html_url: `https://github.com/MetaMask/contract-metadata/pull/${number}`,
    title: "Add Racing Legends (RCL) on Robinhood Chain",
    created_at: createdAt,
    updated_at: createdAt,
    head: { sha: head, repo: { full_name: "someone/contract-metadata" } },
    base: { sha: sha("b"), ref: "master" },
  });

  it("reports a pull request that adds a Robinhood Chain token's file, read at its head in the fork it comes from", async () => {
    const later = new Date(Date.now() + 60_000).toISOString();
    const { requests, table } = routes({ [PULLS]: json([]) });
    const { log, run } = harness(listPullRequests(requests, METAMASK, 60_000));
    await run();
    table[PULLS] = json([opened(2089, sha("c"), later), opened(2090, sha("d"), later)]);
    table[FILES(2089)] = json([
      { filename: `metadata/eip155:4663/erc20:${RCL}.json`, status: "added" },
      { filename: `icons/eip155:4663/erc20:${RCL}.svg`, status: "added" },
    ]);
    table[FILES(2090)] = json([{ filename: `metadata/eip155:1/erc20:${RCL}.json`, status: "added" }]);
    table[`https://raw.githubusercontent.com/someone/contract-metadata/${sha("c")}/metadata/eip155:4663/erc20:${RCL}.json`] = json({ name: "Racing Legends", symbol: "RCL", decimals: 18, erc20: true });
    await run();
    expect(log.query().events).toEqual([
      expect.objectContaining({
        kind: "metamask.pr_opened",
        token: { address: RCL, symbol: "RCL", name: "Racing Legends" },
        source: "MetaMask",
        ref: "https://github.com/MetaMask/contract-metadata/pull/2089",
        at: new Date(later).toISOString(),
        detail: { pr: 2089, title: "Add Racing Legends (RCL) on Robinhood Chain", path: `metadata/eip155:4663/erc20:${RCL}.json`, head: sha("c") },
      }),
    ]);
  });
});

describe("a list pull request open at the baseline", () => {
  const PULLS = "https://api.github.com/repos/MetaMask/contract-metadata/pulls?state=open&sort=updated&direction=desc&per_page=50";
  const FILES = "https://api.github.com/repos/MetaMask/contract-metadata/pulls/2089/files?per_page=100&page=1";
  const RAW = (ref: string, address: string) => `https://raw.githubusercontent.com/someone/contract-metadata/${ref}/metadata/eip155:4663/erc20:${address}.json`;
  const NEW = "0x0000000000000000000000000000000000000c0C";
  const at = (head: string, updatedAt: string) => ({ number: 2089, html_url: "https://github.com/MetaMask/contract-metadata/pull/2089", title: "Add tokens on Robinhood Chain", created_at: "2026-11-18T10:58:36Z", updated_at: updatedAt, head: { sha: head, repo: { full_name: "someone/contract-metadata" } }, base: { sha: sha("b"), ref: "master" } });

  it("reports only the files a later push adds, so what it held before is not news", async () => {
    const { requests, table } = routes({ [PULLS]: json([at(sha("c"), "2026-11-18T11:00:00Z")]) });
    const { log, run } = harness(listPullRequests(requests, METAMASK, 60_000));
    await run();
    table[PULLS] = json([at(sha("d"), "2026-11-19T15:00:00Z")]);
    table[FILES] = json([
      { filename: `metadata/eip155:4663/erc20:${RCL}.json`, status: "added" },
      { filename: `metadata/eip155:4663/erc20:${NEW}.json`, status: "added" },
    ]);
    table[RAW(sha("c"), RCL)] = json({ name: "Racing Legends", symbol: "RCL" });
    table[RAW(sha("d"), NEW)] = json({ name: "New Coin", symbol: "NEW" });
    await run();
    expect(log.query().events.map(({ token, at: when }) => [token.symbol, when])).toEqual([["NEW", "2026-11-19T15:00:00.000Z"]]);
  });
});

describe("the Trust Wallet merge poller", () => {
  const COMMITS = "https://api.github.com/repos/trustwallet/assets/commits?sha=master&path=blockchains%2Frobinhoodchain%2Fassets&per_page=30";
  const FOLDER = "https://api.github.com/repos/trustwallet/assets/contents/blockchains/robinhoodchain/assets?ref=master";
  const RAW = (ref: string, address: string) => `https://raw.githubusercontent.com/trustwallet/assets/${ref}/blockchains/robinhoodchain/assets/${address}/info.json`;
  const commit = (char: string, date: string, message: string) => ({ sha: sha(char), commit: { committer: { date }, message } });

  it("keeps the files that list a token as the baseline, then reports a merge that adds one, dated when it landed", async () => {
    const { requests, table, asked } = routes({
      [COMMITS]: json([commit("1", "2026-07-08T05:36:21Z", "Add Cash Cat (#36000)")], '"c1"'),
      [FOLDER]: json([{ name: CASHCAT, path: `blockchains/robinhoodchain/assets/${CASHCAT}`, type: "dir" }, { name: FAKE, path: `blockchains/robinhoodchain/assets/${FAKE}`, type: "dir" }]),
      [RAW("master", CASHCAT)]: info("CASHCAT", "Cash Cat"),
      [RAW("master", FAKE)]: info("USDC", "USD Coin", "spam"),
    });
    const { log, run } = harness(listMerges(requests, TRUST_WALLET, 60_000));
    await run();
    expect(log.all().map(({ kind, token, at, ref, baseline }) => [kind, token.symbol, at, ref, baseline])).toEqual([["trustwallet.merged", "CASHCAT", null, `https://github.com/trustwallet/assets/blob/master/blockchains/robinhoodchain/assets/${CASHCAT}/info.json`, true]]);
    table[COMMITS] = json([commit("3", "2026-11-19T12:00:00Z", "Add Racing Legends (#38900)"), commit("2", "2026-11-19T11:00:00Z", "Mark FAKE USDC as FAKE (#38899)"), commit("1", "2026-07-08T05:36:21Z", "Add Cash Cat (#36000)")], '"c2"');
    table[`https://api.github.com/repos/trustwallet/assets/commits/${sha("2")}`] = json({ files: [{ filename: `blockchains/robinhoodchain/assets/${FAKE}/info.json`, status: "modified" }] });
    table[`https://api.github.com/repos/trustwallet/assets/commits/${sha("3")}`] = json({ files: [{ filename: `blockchains/robinhoodchain/assets/${RCL}/info.json`, status: "added" }, { filename: `blockchains/robinhoodchain/assets/${RCL}/logo.png`, status: "added" }] });
    table[RAW(sha("3"), RCL)] = info("RCL", "Racing Legends");
    await run();
    expect(log.query().events.map(({ kind, token, at, ref, detail }) => [kind, token.symbol, at, ref, detail.pr])).toEqual([["trustwallet.merged", "RCL", "2026-11-19T12:00:00.000Z", `https://github.com/trustwallet/assets/commit/${sha("3")}`, 38900]]);
    // The commit already read is not read again.
    expect(asked.filter((url) => url.endsWith(sha("1")))).toEqual([]);
  });

  it("leaves out a file that marks its token as spam", async () => {
    const { requests, table } = routes({ [COMMITS]: json([commit("1", "2026-07-08T05:36:21Z", "x")]), [FOLDER]: json([]) });
    const { log, run } = harness(listMerges(requests, TRUST_WALLET, 60_000));
    await run();
    table[COMMITS] = json([commit("2", "2026-11-19T11:00:00Z", "Add fake"), commit("1", "2026-07-08T05:36:21Z", "x")]);
    table[`https://api.github.com/repos/trustwallet/assets/commits/${sha("2")}`] = json({ files: [{ filename: `blockchains/robinhoodchain/assets/${FAKE}/info.json`, status: "added" }] });
    table[RAW(sha("2"), FAKE)] = info("USDC", "USD Coin", "spam");
    await run();
    expect(log.size).toBe(0);
  });
});
