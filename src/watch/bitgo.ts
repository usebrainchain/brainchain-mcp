import {
  bitGoReader,
  custodyAdditions,
  custodyHistory,
  CustodyError,
  EARLY_LIST,
  FIRST_PAGE,
  listChanges,
  nextPage,
  TOKEN_LISTS,
  tokensAt,
  type BitGoReader,
  type CustodyAddition,
  type ListedToken,
} from "../custody.js";
import type { Found } from "./events.js";
import { JSON_TYPE, pullRequestsPoller, type PullRequest } from "./github.js";
import type { Requests } from "./http.js";
import type { Poller } from "./watcher.js";

const REPO = "BitGo/BitGoJS";
export const STATICS = "https://registry.npmjs.org/@bitgo/statics";
export const RELEASE_INTERVAL = 5 * 60_000;

const token = (listed: ListedToken) => ({ address: listed.contract ?? null, symbol: null, name: listed.name ?? null });
const described = (id: string, listed: ListedToken) => ({ id: `hoodeth:${id}`, ...(listed.decimals === undefined ? {} : { decimals: listed.decimals }) });

/**
 * A pull request into BitGo's master that adds a Robinhood Chain token: the tokens its head has on BitGo's lists that its
 * base does not, read with the same reader as brainchain_custody_additions. Only a pull request that touches a list is read.
 */
export async function bitGoPullRequest(reader: BitGoReader, pr: PullRequest, { files, cut }: { files: { filename: string }[]; cut: boolean }, at: string): Promise<Found[]> {
  const lists: readonly string[] = [...TOKEN_LISTS, EARLY_LIST];
  if (pr.baseRef !== "master" || (!cut && !files.some(({ filename }) => lists.includes(filename)))) return [];
  const [head, base] = await Promise.all([tokensAt(reader, pr.head, Date.now()), tokensAt(reader, pr.base, Date.now())]);
  return [...head]
    .filter(([id]) => !base.has(id))
    .map(([id, listed]) => ({
      kind: "bitgo.pr_opened",
      token: token(listed),
      source: "BitGo",
      ref: pr.url,
      at,
      detail: { ...described(id, listed), pr: pr.number, title: pr.title, head: pr.head, ...(pr.draft ? { draft: true } : {}) },
    }));
}

export function bitGoPullRequests(requests: Requests, reader: BitGoReader, interval: number): Poller {
  return pullRequestsPoller({
    name: "bitgo-prs",
    repo: REPO,
    interval,
    requests,
    added: (pr, files, at) =>
      bitGoPullRequest(reader, pr, files, at).catch((error: unknown) => {
        // A head whose lists cannot be read, as from a fork the raw host does not serve, is passed over rather than read again at every poll.
        if (error instanceof CustodyError) return [];
        throw error;
      }),
  });
}

const merged = (additions: readonly CustodyAddition[]): Found[] =>
  additions.flatMap(({ addedAt, commit, tokens }) =>
    tokens.map(({ id, ...listed }) => ({
      kind: "bitgo.merged" as const,
      token: { address: listed.contract ?? null, symbol: null, name: listed.name ?? null },
      source: "BitGo",
      ref: commit,
      at: addedAt,
      detail: { id, ...(listed.decimals === undefined ? {} : { decimals: listed.decimals }), commit },
    })),
  );

interface MergesState {
  /** When the newest change to master that was read happened, in milliseconds. */
  through?: number;
}

/**
 * BitGo's merges into master that add a Robinhood Chain token, dated as brainchain_custody_additions dates them. The newest
 * page of master's changes is asked for with its ETag, so a read with nothing new costs no more than the question. The
 * baseline is BitGo's whole history for Robinhood Chain; after it, only the changes since the last one read.
 */
export function bitGoMerges(requests: Requests, lists: BitGoReader, interval: number): Poller {
  return {
    name: "bitgo-merges",
    interval,
    async poll(context) {
      const state = context.state as MergesState;
      const got = await requests.get("bitgo-merges", FIRST_PAGE, { accept: JSON_TYPE, conditional: true });
      if (got.status === 304) return;
      if (got.status !== 200) throw new Error(`GitHub answered ${got.status} for BitGo's changes to master.`);
      const newest = listChanges(JSON.parse(got.body));
      const next = nextPage(new Response(null, { headers: got.headers }));
      const first = { changes: newest, readAt: Date.now(), ...(next ? { next } : {}) };
      const reader: BitGoReader = { changes: (page) => (page === undefined ? Promise.resolve(first) : lists.changes(page)), list: lists.list };
      const board = context.baseline || state.through === undefined ? await custodyHistory(reader) : await custodyAdditions(reader, new Date(state.through));
      await context.record(merged(board.additions));
      if (newest[0]) state.through = newest[0].at;
      requests.commit(FIRST_PAGE, got);
    },
  };
}

export interface Release {
  version: string;
  time: string;
  gitHead: string;
}

/** The stable releases of @bitgo/statics with the commit each was built from, oldest first, from npm's document for the package. */
export function releases(body: string): Release[] {
  const doc = JSON.parse(body) as { time?: Record<string, unknown>; versions?: Record<string, { gitHead?: unknown }> };
  if (!doc.time || !doc.versions) throw new Error("npm's answer was not the document for @bitgo/statics.");
  return Object.entries(doc.versions)
    .flatMap(([version, manifest]) => {
      const time = doc.time![version];
      const gitHead = manifest?.gitHead;
      if (version.includes("-") || typeof time !== "string" || typeof gitHead !== "string" || !/^[0-9a-f]{40}$/.test(gitHead)) return [];
      return [{ version, time: new Date(time).toISOString(), gitHead }];
    })
    .sort((a, b) => a.time.localeCompare(b.time));
}

interface ReleasesState {
  version?: string;
  time?: string;
  /** BitGo's ids, without `hoodeth:`, of the Robinhood Chain tokens in the release last read. */
  ids?: string[];
}

const releaseLink = (version: string) => `https://www.npmjs.com/package/@bitgo/statics/v/${version}`;

/**
 * Each release of @bitgo/statics, the package BitGo's code takes its token lists from, and the Robinhood Chain tokens it
 * includes for the first time: the lists at the commit npm says it was built from, against the release before. The
 * baseline is the newest release, with every token in it.
 */
export function bitGoReleases(requests: Requests, lists: BitGoReader, interval = RELEASE_INTERVAL): Poller {
  return {
    name: "bitgo-releases",
    interval,
    async poll(context) {
      const state = context.state as ReleasesState;
      const got = await requests.get("bitgo-releases", STATICS, { conditional: true });
      if (got.status === 304) return;
      if (got.status !== 200) throw new Error(`npm answered ${got.status} for @bitgo/statics.`);
      const all = releases(got.body);
      const newest = all.at(-1);
      if (!newest) throw new Error("npm lists no release of @bitgo/statics.");
      if (context.baseline || !state.time || !state.ids) {
        const held = await tokensAt(lists, newest.gitHead, Date.parse(newest.time));
        await context.record(
          [...held].map(([id, listed]) => ({
            kind: "bitgo.released",
            token: token(listed),
            source: "BitGo",
            ref: releaseLink(newest.version),
            at: null,
            detail: { ...described(id, listed), version: newest.version, by: newest.time },
          })),
        );
        Object.assign(state, { version: newest.version, time: newest.time, ids: [...held.keys()] });
      } else {
        for (const release of all.filter(({ time }) => time > state.time!)) {
          const held = await tokensAt(lists, release.gitHead, Date.parse(release.time));
          const before = new Set(state.ids);
          await context.record(
            [...held]
              .filter(([id]) => !before.has(id))
              .map(([id, listed]) => ({
                kind: "bitgo.released",
                token: token(listed),
                source: "BitGo",
                ref: releaseLink(release.version),
                at: release.time,
                detail: { ...described(id, listed), version: release.version, gitHead: release.gitHead },
              })),
          );
          Object.assign(state, { version: release.version, time: release.time, ids: [...held.keys()] });
        }
      }
      requests.commit(STATICS, got);
    },
  };
}

/** BitGo's lists, read through the watcher's requests: commits and older pages are kept, as brainchain_custody_additions keeps them. */
export const bitGoLists = (requests: Requests): BitGoReader => bitGoReader(requests.fetchFor("bitgo-lists"));
