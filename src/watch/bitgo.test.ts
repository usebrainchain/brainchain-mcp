import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { BITGO_START, EARLY_LIST, FIRST_PAGE, TOKEN_LISTS, tokenList, type BitGoReader, type BranchChange } from "../custody.js";
import { bitGoMerges, bitGoPullRequest, bitGoPullRequests, bitGoReleases, releases, STATICS } from "./bitgo.js";
import { EventLog } from "./events.js";
import type { PullRequest } from "./github.js";
import { Requests } from "./http.js";
import { StateFile } from "./state.js";
import { Watcher, type Poller } from "./watcher.js";

const [EDITED, GENERATED] = TOKEN_LISTS;
const sha = (char: string) => char.repeat(40);
const entry = (id: string, name: string, contract: string) => `  erc20Token(\n    '744a1738-6b93-41ae-8884-2faa8f1419f5',\n    'hoodeth:${id}',\n    '${name}',\n    18,\n    '${contract}',\n    UnderlyingAsset['hoodeth:${id}'],\n    Networks.main.hoodeth\n  ),`;
const CASHCAT = entry("cashcat", "Cash Cat", "0x020bfc650a365f8bb26819deaabf3e21291018b4");
const PONS = entry("pons", "Pons", "0x0000000000000000000000000000000000000b0b");
const NEW = entry("newcoin", "New Coin", "0x0000000000000000000000000000000000000c0c");
// The generated list always holds tokens of other chains, so it reads as a list even with no Robinhood Chain token.
const OTHER = `  erc20Token('3493d608-fd3e-45dc-926d-783d54a8fe4d', 'eth:other', 'Other', 18, '0x5884ad2f920c162cfbbacc88c9c51aa75ec09e02', UnderlyingAsset['eth:other'], Networks.main.eth),`;

/** BitGo's lists at each commit: the commit's Robinhood Chain entries in the list engineers edit. */
function lists(at: Record<string, string[]>, pages: Record<string, { changes: BranchChange[]; next?: string }> = {}) {
  const read: string[] = [];
  const reader: BitGoReader = {
    changes: async (page) => ({ readAt: Date.now(), ...pages[page ?? "first"]! }),
    list: async (file, commit) => {
      read.push(`${commit.slice(0, 1)}:${file}`);
      const entries = at[commit];
      if (!entries) return undefined;
      return tokenList(file === GENERATED ? OTHER : file === EARLY_LIST ? OTHER : entries.join("\n") || OTHER);
    },
  };
  return { reader, read };
}

const pr = (more: Partial<PullRequest> = {}): PullRequest => ({
  number: 9357,
  url: "https://github.com/BitGo/BitGoJS/pull/9357",
  title: "feat(statics): onboard polygon:infra, hoodeth:cashcat, rename cETH",
  createdAt: "2026-07-27T09:28:36.000Z",
  updatedAt: "2026-07-28T06:23:02.000Z",
  head: sha("d"),
  base: sha("b"),
  baseRef: "master",
  draft: false,
  ...more,
});

/** Answers each URL from `routes`, which a test can change between reads, and 404 for anything else. */
function routes(table: Record<string, () => Response>) {
  const asked: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    asked.push(`${url}${new Headers(init?.headers).get("if-none-match") ? " (etag)" : ""}`);
    return table[url]?.() ?? new Response("Not Found", { status: 404 });
  }) as typeof fetch;
  return { requests: new Requests({ fetch: fetchImpl }), asked, table };
}

function harness(poller: Poller) {
  const dir = mkdtempSync(join(tmpdir(), "brainchain-watch-"));
  const log = new EventLog(dir);
  const watcher = new Watcher({ log, state: new StateFile(dir), pollers: [poller], say: () => {} });
  return { log, run: () => watcher.runOnce(poller), status: () => watcher.status.get(poller.name)! };
}

const json = (value: unknown, etag?: string) => () => new Response(JSON.stringify(value), { headers: etag ? { etag } : {} });
const notModified = () => new Response(null, { status: 304 });

describe("a BitGo pull request", () => {
  it("adds the tokens its head lists and its base does not, read only when it touches a list", async () => {
    const { reader, read } = lists({ [sha("d")]: [PONS, CASHCAT], [sha("b")]: [PONS] });
    const found = await bitGoPullRequest(reader, pr(), { files: [{ filename: "modules/statics/src/base.ts" }, { filename: EDITED! }], cut: false }, "2026-07-27T09:28:36.000Z");
    expect(found).toEqual([
      {
        kind: "bitgo.pr_opened",
        token: { address: "0x020bfC650A365f8BB26819deAAbF3E21291018b4", symbol: null, name: "Cash Cat" },
        source: "BitGo",
        ref: "https://github.com/BitGo/BitGoJS/pull/9357",
        at: "2026-07-27T09:28:36.000Z",
        detail: { id: "hoodeth:cashcat", decimals: 18, pr: 9357, title: pr().title, head: sha("d") },
      },
    ]);
    read.length = 0;
    expect(await bitGoPullRequest(reader, pr(), { files: [{ filename: "modules/bitgo/src/index.ts" }], cut: false }, "x")).toEqual([]);
    expect(await bitGoPullRequest(reader, pr({ baseRef: "release" }), { files: [{ filename: EDITED! }], cut: false }, "x")).toEqual([]);
    expect(read).toEqual([]);
    // A pull request with more files than are read is read for its lists anyway.
    expect(await bitGoPullRequest(reader, pr(), { files: [], cut: true }, "x")).toHaveLength(1);
  });
});

describe("the BitGo pull request poller", () => {
  const PULLS = "https://api.github.com/repos/BitGo/BitGoJS/pulls?state=open&sort=updated&direction=desc&per_page=50";
  const FILES = (n: number) => `https://api.github.com/repos/BitGo/BitGoJS/pulls/${n}/files?per_page=100&page=1`;
  const listed = (...prs: PullRequest[]) => prs.map((one) => ({ number: one.number, html_url: one.url, title: one.title, created_at: one.createdAt, updated_at: one.updatedAt, head: { sha: one.head, repo: { full_name: "BitGo/BitGoJS" } }, base: { sha: one.base, ref: one.baseRef }, draft: one.draft }));

  it("notes open pull requests' heads as the baseline, asks with its ETag, and dates a new one by its opening and a later push by its update", async () => {
    const { reader } = lists({ [sha("d")]: [PONS, CASHCAT], [sha("b")]: [PONS], [sha("e")]: [PONS, NEW], [sha("f")]: [PONS], [sha("9")]: [PONS, NEW, CASHCAT], [sha("8")]: [PONS, CASHCAT, NEW] });
    const later = pr({ number: 9400, url: "https://github.com/BitGo/BitGoJS/pull/9400", head: sha("f"), createdAt: "2026-11-19T00:00:00.000Z" });
    const { requests, asked, table } = routes({ [PULLS]: json(listed(pr()), '"1"'), [FILES(9357)]: json([{ filename: EDITED, status: "modified" }]) });
    const { log, run } = harness(bitGoPullRequests(requests, reader, 60_000));
    await run();
    // The baseline reads no pull request's files: it notes their heads.
    expect([log.size, asked.filter((url) => url.includes("/files")).length]).toEqual([0, 0]);
    table[PULLS] = () => (asked.at(-1)?.endsWith("(etag)") ? notModified() : json([])());
    await run();
    expect(asked.at(-1)).toBe(`${PULLS} (etag)`);
    // Opened after the baseline with its token, and an older one pushed again with one.
    const opened = pr({ number: 9500, url: "https://github.com/BitGo/BitGoJS/pull/9500", head: sha("e"), createdAt: new Date(Date.now() + 1000).toISOString(), updatedAt: new Date(Date.now() + 1000).toISOString() });
    table[PULLS] = json(listed(opened, later), '"2"');
    table[FILES(9500)] = json([{ filename: EDITED, status: "modified" }]);
    table[FILES(9400)] = json([{ filename: EDITED, status: "modified" }]);
    await run();
    expect(log.query().events.map(({ detail, at }) => [detail.pr, detail.id, at])).toEqual([[9500, "hoodeth:newcoin", opened.createdAt]]);
    table[PULLS] = json(listed({ ...later, head: sha("9"), updatedAt: "2026-11-19T13:00:00.000Z" }, opened), '"3"');
    await run();
    expect(log.query({ since: { id: 1 } }).events.map(({ detail, at }) => [detail.pr, detail.id, at])).toEqual([[9400, "hoodeth:newcoin", "2026-11-19T13:00:00.000Z"], [9400, "hoodeth:cashcat", "2026-11-19T13:00:00.000Z"]]);
  });

  it("reports for a pull request open at the baseline only what a later push adds", async () => {
    const { reader } = lists({ [sha("d")]: [PONS, CASHCAT], [sha("b")]: [PONS], [sha("8")]: [PONS, CASHCAT, NEW] });
    const { requests, table } = routes({ [PULLS]: json(listed(pr()), '"1"'), [FILES(9357)]: json([{ filename: EDITED, status: "modified" }]) });
    const { log, run } = harness(bitGoPullRequests(requests, reader, 60_000));
    await run();
    table[PULLS] = json(listed(pr({ head: sha("8"), updatedAt: "2026-11-19T14:00:00.000Z" })), '"2"');
    await run();
    // Cash Cat was in the head the baseline saw, so only New Coin is new.
    expect(log.query().events.map(({ detail, at }) => [detail.id, at])).toEqual([["hoodeth:newcoin", "2026-11-19T14:00:00.000Z"]]);
  });

  it("passes over a head whose lists cannot be read rather than failing every read", async () => {
    const { reader } = lists({ [sha("b")]: [PONS] });
    const { requests } = routes({ [PULLS]: json(listed(pr())), [FILES(9357)]: json([{ filename: EDITED, status: "modified" }]) });
    const { log, run, status } = harness(bitGoPullRequests(requests, reader, 60_000));
    await run();
    expect(status().failures).toBe(0);
    expect(log.size).toBe(0);
  });
});

describe("the BitGo merge poller", () => {
  const T0 = BITGO_START + 1000;
  const change = (at: number, before: string, after: string) => ({ at, before, after });
  const activity = (changes: BranchChange[], etag: string) => () => new Response(JSON.stringify(changes.map(({ at, before, after }) => ({ timestamp: new Date(at).toISOString(), before, after }))), { headers: { etag } });

  it("keeps BitGo's history as the baseline, then reports a merge that adds a token, dated by master's push", async () => {
    const at = { [sha("0")]: [], [sha("1")]: [PONS], [sha("2")]: [PONS, CASHCAT], [sha("3")]: [PONS, CASHCAT, NEW] };
    const { reader } = lists(at);
    const history = [change(T0 + 2000, sha("1"), sha("2")), change(T0 + 1000, sha("0"), sha("1"))];
    const { requests, table, asked } = routes({ [FIRST_PAGE]: activity(history, '"a"') });
    const { log, run } = harness(bitGoMerges(requests, reader, 60_000));
    await run();
    expect(log.all().map(({ kind, detail, at: when, ref, baseline }) => [kind, detail.id, when, ref, baseline])).toEqual([
      ["bitgo.merged", "hoodeth:cashcat", new Date(T0 + 2000).toISOString(), `https://github.com/BitGo/BitGoJS/commit/${sha("2")}`, true],
      ["bitgo.merged", "hoodeth:pons", new Date(T0 + 1000).toISOString(), `https://github.com/BitGo/BitGoJS/commit/${sha("1")}`, true],
    ]);
    table[FIRST_PAGE] = notModified;
    await run();
    expect(asked.at(-1)).toBe(`${FIRST_PAGE} (etag)`);
    table[FIRST_PAGE] = activity([change(T0 + 3000, sha("2"), sha("3")), ...history], '"b"');
    await run();
    expect(log.query().events.map(({ detail, at: when, token }) => [detail.id, when, token.name])).toEqual([["hoodeth:newcoin", new Date(T0 + 3000).toISOString(), "New Coin"]]);
  });
});

describe("the @bitgo/statics release poller", () => {
  const packument = (versions: Record<string, [string, string]>) =>
    json({ name: "@bitgo/statics", time: Object.fromEntries(Object.entries(versions).map(([version, [time]]) => [version, time])), versions: Object.fromEntries(Object.entries(versions).map(([version, [, gitHead]]) => [version, { gitHead }])) });

  it("keeps the newest release's tokens as the baseline, then reports each token a new release includes for the first time", async () => {
    const { reader } = lists({ [sha("1")]: [PONS], [sha("2")]: [PONS, CASHCAT], [sha("3")]: [PONS, CASHCAT] });
    const { requests, table } = routes({ [STATICS]: packument({ "59.0.0": ["2026-07-20T00:00:00Z", sha("1")] }) });
    const { log, run } = harness(bitGoReleases(requests, reader));
    await run();
    expect(log.all().map(({ kind, detail, at, baseline }) => [kind, detail.id, detail.version, at, baseline])).toEqual([["bitgo.released", "hoodeth:pons", "59.0.0", null, true]]);
    table[STATICS] = packument({ "59.0.0": ["2026-07-20T00:00:00Z", sha("1")], "59.1.0": ["2026-07-28T20:29:13.342Z", sha("2")], "59.2.0-beta.1": ["2026-07-29T00:00:00Z", sha("3")], "59.2.0": ["2026-07-30T14:36:46.353Z", sha("3")] });
    await run();
    expect(log.query().events.map(({ detail, at, ref }) => [detail.id, detail.version, at, ref])).toEqual([["hoodeth:cashcat", "59.1.0", "2026-07-28T20:29:13.342Z", "https://www.npmjs.com/package/@bitgo/statics/v/59.1.0"]]);
  });

  it("reads only stable releases built from a commit", () => {
    expect(releases(JSON.stringify({ time: { "1.0.0": "2026-01-01T00:00:00Z", "1.1.0-rc.1": "2026-01-02T00:00:00Z", "1.2.0": "2026-01-03T00:00:00Z" }, versions: { "1.0.0": { gitHead: sha("a") }, "1.1.0-rc.1": { gitHead: sha("b") }, "1.2.0": {} } }))).toEqual([
      { version: "1.0.0", time: "2026-01-01T00:00:00.000Z", gitHead: sha("a") },
    ]);
    expect(() => releases("{}")).toThrow("npm's answer was not the document for @bitgo/statics.");
  });
});
