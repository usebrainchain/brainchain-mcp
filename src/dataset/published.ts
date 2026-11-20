import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { expandHome } from "../config.js";
import { parseJsonl, sha256, symbolBucket, type FileEntry, type Manifest, type OutcomeRow, type StepRow, type SymbolRow, type TokenRow } from "./format.js";
import type { KindCounts, PoolPieces } from "./rates.js";

/** Where the tools read the dataset from: a directory on this machine, or the address of a published copy. */
export const DATASET_SETTING = "BRAINCHAIN_DATASET";
/** The dataset as BrainChain publishes it every day. */
export const PUBLISHED_URL = "https://raw.githubusercontent.com/usebrainchain/brainchain-mcp-data/main/";
/** How far back the newest manifest is looked for: a day the build or the publish missed leaves the one before. */
const DAYS_BACK = 7;
/** How long the newest manifest found is kept before it is looked for again. */
export const MANIFEST_MS = 30 * 60_000;
const REQUEST_MS = 20_000;

/** A failure whose message is written for the person asking. */
export class DatasetError extends Error {}

/** Which dataset an answer read: the day, the block it reaches, when it was built, and the SHA-256 of its manifest. */
export interface DatasetRef {
  source: string;
  date: string;
  headBlock: number;
  readAt: string;
  manifest: string;
}

export interface RatesFile {
  readAt: string;
  headBlock: number;
  cut: string;
  /** How far each scan reached, and the wallets whose approvals of every token the build read. */
  through?: { head: number; pools: number; approvals: number; wallets?: string[] };
  /** Outcome rows that rest on a symbol alone, kept and counted in no rate. */
  unconfirmed?: number;
  kinds: KindCounts[];
  pools: PoolPieces;
}

/** The rows the tools read, checked against the manifest they came with. */
export interface Dataset {
  ref: DatasetRef;
  tokens: TokenRow[];
  steps: StepRow[];
  outcomes: OutcomeRow[];
  rates: RatesFile;
}

export interface DatasetReader {
  /** The newest day's dataset, kept until a newer manifest is found. */
  load(): Promise<Dataset>;
  /** The tokens that call themselves `symbol`, from the bucket of every token with a pool. */
  symbol(symbol: string): Promise<SymbolRow[]>;
}

interface Place {
  name: string;
  /** A file's bytes, or undefined when it is not there. */
  read(path: string): Promise<Buffer | undefined>;
  /** The newest manifest's path, or undefined. */
  newest(now: number): Promise<string | undefined>;
}

function directory(dir: string): Place {
  return {
    name: "local directory",
    read: async (path) => (existsSync(join(dir, path)) ? readFileSync(join(dir, path)) : undefined),
    newest: async () => {
      const manifests = join(dir, "manifests");
      const day = existsSync(manifests) ? readdirSync(manifests).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort().at(-1) : undefined;
      return day && `manifests/${day}`;
    },
  };
}

function published(base: URL, fetchImpl: typeof fetch): Place {
  const read = async (path: string) => {
    const response = await fetchImpl(new URL(path, base), { headers: { "User-Agent": "brainchain-mcp" }, redirect: "follow", signal: AbortSignal.timeout(REQUEST_MS) });
    if (response.status === 404) {
      await response.body?.cancel().catch(() => {});
      return undefined;
    }
    if (response.status !== 200) throw new DatasetError(`${base.host} answered ${response.status} for the dataset's ${path}. Try again in a minute.`);
    return Buffer.from(await response.arrayBuffer());
  };
  return {
    name: base.href,
    read,
    newest: async (now) => {
      for (let back = 0; back <= DAYS_BACK; back++) {
        const path = `manifests/${new Date(now - back * 86_400_000).toISOString().slice(0, 10)}.json`;
        if ((await read(path)) !== undefined) return path;
      }
      return undefined;
    },
  };
}

/** The setting, checked: a directory, absolute or under ~/, or an https address; unset is BrainChain's published copy. */
export function datasetPlace(value: string | undefined, fetchImpl: typeof fetch = fetch): Place {
  const given = value?.trim();
  if (!given) return published(new URL(PUBLISHED_URL), fetchImpl);
  if (/^https:\/\//i.test(given)) return published(new URL(given.endsWith("/") ? given : `${given}/`), fetchImpl);
  const dir = expandHome(given);
  if (!isAbsolute(dir)) throw new DatasetError(`${DATASET_SETTING} must be an https address or a directory, absolute or starting with ~/.`);
  return directory(dir);
}

export function datasetReader(value: string | undefined, fetchImpl: typeof fetch = fetch, clock: () => number = Date.now): DatasetReader {
  const place = datasetPlace(value, fetchImpl);
  let latest: { until: number; manifest: Promise<{ path: string; manifest: Manifest; bytes: Buffer }> } | undefined;
  let loaded: { hash: string; dataset: Promise<Dataset> } | undefined;
  const buckets = new Map<string, Promise<SymbolRow[]>>();

  const manifest = () => {
    if (latest && clock() < latest.until) return latest.manifest;
    const reading = (async () => {
      const path = await place.newest(clock());
      if (!path) throw new DatasetError(`No dataset was published in the last ${DAYS_BACK} days at ${place.name}.`);
      const bytes = await place.read(path);
      if (!bytes) throw new DatasetError(`The dataset's ${path} could not be read at ${place.name}.`);
      return { path, manifest: JSON.parse(bytes.toString("utf8")) as Manifest, bytes };
    })();
    latest = { until: clock() + MANIFEST_MS, manifest: reading };
    reading.catch(() => {
      // A failed read is not kept: the next answer asks again.
      if (latest?.manifest === reading) latest = undefined;
    });
    return reading;
  };

  /** A file of the dataset, refused unless it hashes to its entry in the manifest. */
  const file = async ({ manifest: m }: { manifest: Manifest }, path: string): Promise<Buffer> => {
    const entry: FileEntry | undefined = m.files[path];
    if (!entry) throw new DatasetError(`The dataset of ${m.date} lists no ${path}.`);
    const bytes = await place.read(path);
    if (!bytes) throw new DatasetError(`The dataset's ${path} could not be read at ${place.name}.`);
    if (sha256(bytes) !== entry.sha256) throw new DatasetError(`The dataset's ${path} does not match the SHA-256 its manifest of ${m.date} gives, so it was not read. It may be mid-publish: try again in a minute.`);
    return bytes;
  };

  return {
    async load() {
      const found = await manifest();
      const hash = sha256(found.bytes);
      if (loaded?.hash === hash) return loaded.dataset;
      const reading = (async (): Promise<Dataset> => {
        const [tokens, steps, outcomes, rates] = await Promise.all(["tokens.jsonl", "events.jsonl", "outcomes.jsonl", "base-rates.json"].map((path) => file(found, path)));
        return {
          ref: { source: place.name, date: found.manifest.date, headBlock: found.manifest.headBlock, readAt: found.manifest.readAt, manifest: hash },
          tokens: parseJsonl<TokenRow>(tokens!.toString("utf8")),
          steps: parseJsonl<StepRow>(steps!.toString("utf8")),
          outcomes: parseJsonl<OutcomeRow>(outcomes!.toString("utf8")),
          rates: JSON.parse(rates!.toString("utf8")) as RatesFile,
        };
      })();
      loaded = { hash, dataset: reading };
      reading.catch(() => {
        if (loaded?.dataset === reading) loaded = undefined;
      });
      return reading;
    },
    async symbol(symbol) {
      const found = await manifest();
      const path = symbolBucket(symbol);
      const key = `${sha256(found.bytes)}:${path}`;
      if (!buckets.has(key)) {
        if (buckets.size > 32) buckets.clear();
        const reading = found.manifest.files[path] ? file(found, path).then((bytes) => parseJsonl<SymbolRow>(bytes.toString("utf8"))) : Promise.resolve([]);
        buckets.set(key, reading);
        reading.catch(() => buckets.delete(key));
      }
      const wanted = symbol.toUpperCase();
      return (await buckets.get(key)!).filter((row) => row.symbol.toUpperCase() === wanted);
    },
  };
}
