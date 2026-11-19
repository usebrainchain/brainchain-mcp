import type { Found } from "./events.js";
import type { Requests } from "./http.js";
import type { Poller } from "./watcher.js";

export const API = "https://api.github.com";
export const JSON_TYPE = "application/vnd.github+json";
/** How many of a repository's open pull requests one read lists, most recently updated first. */
export const PRS_PER_READ = 50;
/** A pull request's files come 100 to a page; past this many pages the rest are not read. */
export const FILE_PAGES = 3;

export interface PullRequest {
  number: number;
  url: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  head: string;
  /** The repository the head commit is in, which differs from the base for a pull request from a fork. */
  headRepo?: string;
  base: string;
  baseRef: string;
  draft: boolean;
}

export interface ChangedFile {
  filename: string;
  status: string;
}

const SHA = /^[0-9a-f]{40}$/;
const record = (value: unknown): Record<string, unknown> => (value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {});
const text = (value: unknown) => (typeof value === "string" ? value : "");
const time = (value: unknown) => {
  const at = typeof value === "string" ? Date.parse(value) : NaN;
  if (Number.isNaN(at)) throw new Error("GitHub's answer had a time that is not one.");
  return new Date(at).toISOString();
};

function array(body: string, what: string): unknown[] {
  const value: unknown = JSON.parse(body);
  if (!Array.isArray(value)) throw new Error(`GitHub's answer was not a list of ${what}.`);
  return value;
}

/** GitHub's list of pull requests, read field by field: it is another party's answer. */
export function pullRequests(body: string): PullRequest[] {
  return array(body, "pull requests").map((entry) => {
    const pr = record(entry);
    const head = record(pr.head);
    const base = record(pr.base);
    if (typeof pr.number !== "number" || !SHA.test(text(head.sha)) || !SHA.test(text(base.sha))) throw new Error("GitHub's answer was not a list of pull requests.");
    const headRepo = text(record(head.repo).full_name);
    return {
      number: pr.number,
      url: text(pr.html_url),
      title: text(pr.title).slice(0, 200),
      createdAt: time(pr.created_at),
      updatedAt: time(pr.updated_at),
      head: text(head.sha),
      ...(headRepo ? { headRepo } : {}),
      base: text(base.sha),
      baseRef: text(base.ref),
      draft: pr.draft === true,
    };
  });
}

export function changedFiles(body: string): ChangedFile[] {
  return array(body, "files").map((entry) => ({ filename: text(record(entry).filename), status: text(record(entry).status) }));
}

/** The files a pull request changes, and whether there were more than `FILE_PAGES` pages of them. */
export async function prFiles(requests: Requests, source: string, repo: string, number: number): Promise<{ files: ChangedFile[]; cut: boolean }> {
  const files: ChangedFile[] = [];
  for (let page = 1; page <= FILE_PAGES; page++) {
    const got = await requests.get(source, `${API}/repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`, { accept: JSON_TYPE });
    if (got.status !== 200) throw new Error(`GitHub answered ${got.status} for the files of ${repo}#${number}.`);
    const more = changedFiles(got.body);
    files.push(...more);
    if (more.length < 100) return { files, cut: false };
  }
  return { files, cut: true };
}

export interface PullRequestsOptions {
  name: string;
  repo: string;
  interval: number;
  requests: Requests;
  /** What a pull request at its current head adds. `at` is when that became public, as far as GitHub dates it. */
  added(pr: PullRequest, files: { files: ChangedFile[]; cut: boolean }, at: string): Promise<Found[]>;
}

interface PullRequestsState {
  /** The head each open pull request had when it was last read. */
  heads?: Record<string, string>;
  /** When the baseline was read: a pull request opened since then, first seen with what it adds, is dated by its opening. */
  since?: string;
}

/**
 * Open pull requests into the default branch of `repo`, most recently updated first. A pull request whose head moved since
 * the last read has its files read, and `added` says what it adds. One that adds something the first time it is seen, and
 * was opened after the baseline, is dated by its opening; one that adds it in a later push is dated by its last update,
 * which is that push.
 */
export function pullRequestsPoller({ name, repo, interval, requests, added }: PullRequestsOptions): Poller {
  const url = `${API}/repos/${repo}/pulls?state=open&sort=updated&direction=desc&per_page=${PRS_PER_READ}`;
  return {
    name,
    interval,
    async poll(context) {
      const state = context.state as PullRequestsState;
      state.since ??= new Date().toISOString();
      const got = await requests.get(name, url, { accept: JSON_TYPE, conditional: true });
      if (got.status === 304) return;
      if (got.status !== 200) throw new Error(`GitHub answered ${got.status} for ${repo}'s pull requests.`);
      const open = pullRequests(got.body);
      const heads = (state.heads ??= {});
      for (const pr of [...open].reverse()) {
        const seen = heads[pr.number];
        if (seen === pr.head) continue;
        const at = seen === undefined && pr.createdAt >= state.since ? pr.createdAt : pr.updatedAt;
        await context.record(await added(pr, await prFiles(requests, name, repo, pr.number), at));
        heads[pr.number] = pr.head;
      }
      // A pull request that left the list was merged, closed or pushed down by newer updates; its head is read again if it comes back.
      const listed = new Set(open.map(({ number }) => String(number)));
      for (const number of Object.keys(heads)) if (!listed.has(number)) delete heads[number];
      requests.commit(url, got);
    },
  };
}

export interface Commit {
  sha: string;
  /** When the commit was committed, which for a pull request GitHub merged is when it merged. */
  at: string;
  message: string;
}

export function commitList(body: string): Commit[] {
  return array(body, "commits").map((entry) => {
    const commit = record(entry);
    const sha = text(commit.sha);
    if (!SHA.test(sha)) throw new Error("GitHub's answer was not a list of commits.");
    return { sha, at: time(record(record(commit.commit).committer).date), message: text(record(commit.commit).message).split("\n")[0]!.slice(0, 200) };
  });
}

/** The files one commit changes. */
export async function commitFiles(requests: Requests, source: string, repo: string, sha: string): Promise<ChangedFile[]> {
  const got = await requests.get(source, `${API}/repos/${repo}/commits/${sha}`, { accept: JSON_TYPE });
  if (got.status !== 200) throw new Error(`GitHub answered ${got.status} for commit ${sha} of ${repo}.`);
  const files = record(JSON.parse(got.body)).files;
  if (!Array.isArray(files)) throw new Error(`GitHub's answer for commit ${sha} of ${repo} listed no files.`);
  return files.map((file) => ({ filename: text(record(file).filename), status: text(record(file).status) }));
}

