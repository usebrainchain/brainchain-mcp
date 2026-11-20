import { getAddress } from "viem";

import { label } from "../history.js";
import { tokenFile } from "../sightings.js";
import type { Found, Kind } from "./events.js";
import { API, commitFiles, commitList, JSON_TYPE, pullRequestsPoller, type ChangedFile, type PullRequest } from "./github.js";
import type { Requests } from "./http.js";
import type { Poller } from "./watcher.js";

/** A list kept as one file per token in a public GitHub repository, as brainchain_token_sightings reads it. */
export interface FileList {
  key: "trustwallet" | "metamask";
  source: "Trust Wallet" | "MetaMask";
  repo: string;
  /** The folder that holds Robinhood Chain's files. */
  dir: string;
  /** The token a file is for, or nothing for a file that is not a token's. */
  address(path: string): string | undefined;
  /** The path of a token's file. */
  path(address: string): string;
  /** The token an entry of the chain's folder is for. */
  inFolder(path: string): string | undefined;
  /** Whether a file lists its token, as opposed to marking it as spam or dropped. */
  listed(entry: Record<string, unknown>): boolean;
}

export const TRUST_WALLET: FileList = {
  key: "trustwallet",
  source: "Trust Wallet",
  repo: "trustwallet/assets",
  dir: "blockchains/robinhoodchain/assets",
  address: (path) => /^blockchains\/robinhoodchain\/assets\/(0x[0-9a-fA-F]{40})\/info\.json$/.exec(path)?.[1],
  path: (address) => `blockchains/robinhoodchain/assets/${address}/info.json`,
  inFolder: (path) => /^blockchains\/robinhoodchain\/assets\/(0x[0-9a-fA-F]{40})$/.exec(path)?.[1],
  listed: (entry) => entry.status === "active",
};

export const METAMASK: FileList = {
  key: "metamask",
  source: "MetaMask",
  repo: "MetaMask/contract-metadata",
  dir: "metadata/eip155:4663",
  address: (path) => /^metadata\/eip155:4663\/erc20:(0x[0-9a-fA-F]{40})\.json$/.exec(path)?.[1],
  path: (address) => `metadata/eip155:4663/erc20:${address}.json`,
  inFolder: (path) => METAMASK.address(path),
  listed: () => true,
};

const raw = (repo: string, ref: string, path: string) => `https://raw.githubusercontent.com/${repo}/${ref}/${path}`;

/** What a token's file says of it, or nothing when the file is missing or does not list the token. */
async function listedIn(requests: Requests, source: string, list: FileList, url: string): Promise<{ symbol: string | null; name: string | null } | undefined> {
  const got = await requests.get(source, url, { accept: "*/*" });
  if (got.status !== 200 && got.status !== 404) throw new Error(`${new URL(url).host} answered ${got.status}.`);
  const entry = tokenFile({ status: got.status, body: got.body });
  if (!entry || !list.listed(entry)) return undefined;
  const symbol = typeof entry.symbol === "string" ? label(entry.symbol, 20) : "";
  const name = typeof entry.name === "string" ? label(entry.name, 60) : "";
  return { symbol: symbol || null, name: name || null };
}

/** The tokens a pull request adds a listing file for, read at its head; with `before`, only files that head did not have. */
export async function listPullRequest(requests: Requests, list: FileList, pr: PullRequest, { files }: { files: ChangedFile[] }, at: string, before?: string): Promise<Found[]> {
  const found: Found[] = [];
  for (const { filename, status } of files) {
    const address = list.address(filename);
    if (status !== "added" || !address) continue;
    if (before && (await requests.get(`${list.key}-prs`, raw(pr.headRepo ?? list.repo, before, filename), { accept: "*/*" })).status === 200) continue;
    const named = await listedIn(requests, `${list.key}-prs`, list, raw(pr.headRepo ?? list.repo, pr.head, filename));
    if (!named) continue;
    found.push({ kind: `${list.key}.pr_opened` as Kind, token: { address: getAddress(address.toLowerCase()), ...named }, source: list.source, ref: pr.url, at, detail: { pr: pr.number, title: pr.title, path: filename, head: pr.head } });
  }
  return found;
}

export const listPullRequests = (requests: Requests, list: FileList, interval: number): Poller =>
  pullRequestsPoller({ name: `${list.key}-prs`, repo: list.repo, interval, requests, added: (pr, files, at, before) => listPullRequest(requests, list, pr, files, at, before) });

interface MergesState {
  /** The newest commit to the chain's folder on master that was read. */
  last?: string;
}

/**
 * Commits to master that add a Robinhood Chain token's file, dated when the commit landed: GitHub sets a merged pull
 * request's commit time to the merge. The commits that touch the folder are asked for with their ETag. The baseline is
 * every file in the folder that lists its token.
 */
export function listMerges(requests: Requests, list: FileList, interval: number): Poller {
  const name = `${list.key}-merges`;
  const url = `${API}/repos/${list.repo}/commits?sha=master&path=${encodeURIComponent(list.dir)}&per_page=30`;
  return {
    name,
    interval,
    async poll(context) {
      const state = context.state as MergesState;
      const got = await requests.get(name, url, { accept: JSON_TYPE, conditional: true });
      if (got.status === 304) return;
      if (got.status !== 200) throw new Error(`GitHub answered ${got.status} for ${list.repo}'s commits.`);
      const commits = commitList(got.body);
      if (context.baseline || !state.last) {
        const folder = await requests.get(name, `${API}/repos/${list.repo}/contents/${list.dir}?ref=master`, { accept: JSON_TYPE });
        if (folder.status !== 200) throw new Error(`GitHub answered ${folder.status} for ${list.repo}'s ${list.dir} folder.`);
        const entries: unknown = JSON.parse(folder.body);
        if (!Array.isArray(entries)) throw new Error(`GitHub's answer for ${list.repo}'s ${list.dir} folder was not a list.`);
        const addresses = entries.flatMap((entry: { path?: unknown }) => {
          const address = typeof entry?.path === "string" ? list.inFolder(entry.path) : undefined;
          return address ? [address] : [];
        });
        const found: Found[] = [];
        for (const address of addresses) {
          const named = await listedIn(requests, name, list, raw(list.repo, "master", list.path(address)));
          if (!named) continue;
          const link = `https://github.com/${list.repo}/blob/master/${list.path(address)}`;
          found.push({ kind: `${list.key}.merged` as Kind, token: { address: getAddress(address.toLowerCase()), ...named }, source: list.source, ref: link, at: null, detail: { path: list.path(address), link } });
        }
        await context.record(found);
      } else {
        const seen = commits.findIndex(({ sha }) => sha === state.last);
        if (seen < 0) context.log(`more than ${commits.length} new commits since the last read; reading the newest ${commits.length}.`);
        for (const commit of commits.slice(0, seen < 0 ? commits.length : seen).reverse()) {
          const found: Found[] = [];
          for (const { filename, status } of await commitFiles(requests, name, list.repo, commit.sha)) {
            const address = list.address(filename);
            if (status !== "added" || !address) continue;
            const named = await listedIn(requests, name, list, raw(list.repo, commit.sha, filename));
            if (!named) continue;
            const pr = /\(#(\d+)\)$/.exec(commit.message)?.[1];
            found.push({
              kind: `${list.key}.merged` as Kind,
              token: { address: getAddress(address.toLowerCase()), ...named },
              source: list.source,
              ref: `https://github.com/${list.repo}/commit/${commit.sha}`,
              at: commit.at,
              detail: { commit: commit.sha, path: filename, link: `https://github.com/${list.repo}/blob/master/${filename}`, ...(pr ? { pr: Number(pr) } : {}) },
            });
          }
          await context.record(found);
          state.last = commit.sha;
        }
      }
      if (commits[0]) state.last = commits[0].sha;
      requests.commit(url, got);
    },
  };
}
