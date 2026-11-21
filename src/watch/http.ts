import { gitHubAuth, hasGitHubToken } from "../github.js";

/** A request held back, by a host that refused or by the watcher's own budget, until `until`. */
export class Backoff extends Error {
  constructor(
    message: string,
    readonly until: number,
  ) {
    super(message);
  }
}

/** What a conditional request needs from an earlier answer. */
export interface Validators {
  etag?: string;
  lastModified?: string;
}

export interface Got {
  status: number;
  /** Empty for a 304. */
  body: string;
  headers: Headers;
  /** The answer's validators, to keep with `commit` once the body has been dealt with. */
  validators?: Validators;
}

export interface GetOptions {
  accept?: string;
  /** Send the validators kept for this URL, so an unchanged document comes back as a 304 with no body. */
  conditional?: boolean;
}

/** The hosts whose requests count against one allowance, and the allowance. */
export interface Allowance {
  hosts: readonly string[];
  perHour: number;
}

export interface GitHubLimit {
  limit: number;
  remaining: number;
  reset: number;
}

export interface RequestStats {
  lastHour: number;
  total: number;
  notModified: number;
}

const HOUR_MS = 3_600_000;
const REQUEST_MS = 20_000;
/** A host that refuses without saying for how long is left alone this long, then twice as long, up to `MAX_REFUSED_MS`. */
export const FIRST_REFUSED_MS = 60_000;
export const MAX_REFUSED_MS = HOUR_MS;
/** A host that has not refused for this long starts again from `FIRST_REFUSED_MS`; one that refuses sooner waits twice as long as last time. */
export const QUIET_MS = 15 * 60_000;
/** A host that answers 451, which says it does not serve the address the watcher reads from, is left alone this long. */
export const REGION_MS = 6 * HOUR_MS;
/** GitHub requests the watcher leaves unused in each hour, for the MCP server and anything else on the same address or token. */
export const GITHUB_RESERVE = { withToken: 500, withoutToken: 10 };

const GITHUB_API = "api.github.com";

export interface RequestsOptions {
  fetch?: typeof fetch;
  clock?: () => number;
  allowances?: readonly Allowance[];
  validators?: Record<string, Validators>;
}

/**
 * Every request the watcher makes goes through here: counted by the source that made it, held to the allowance of its
 * host, and refused at once while a host that turned the watcher away has not said it is ready again. GitHub's API is
 * read with the token useGitHubToken set, as the MCP server reads it; no other host is sent a key.
 */
export class Requests {
  private readonly fetchImpl: typeof fetch;
  private readonly clock: () => number;
  private readonly allowances: readonly Allowance[];
  private readonly sent = new Map<Allowance, number[]>();
  private readonly blocked = new Map<string, { until: number; message: string; refusals: number; at: number }>();
  private readonly counts = new Map<string, { times: number[]; total: number; notModified: number }>();
  readonly validators: Record<string, Validators>;
  github?: GitHubLimit;

  constructor({ fetch: fetchImpl = fetch, clock = Date.now, allowances = [], validators = {} }: RequestsOptions = {}) {
    this.fetchImpl = fetchImpl;
    this.clock = clock;
    this.allowances = allowances;
    this.validators = validators;
  }

  /** A `fetch` for a reader written against it, such as BitGo's or the chain's: its requests count for `source` and keep to the same rules. */
  fetchFor(source: string): typeof fetch {
    return async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const headers = new Headers(init?.headers);
      for (const [name, value] of Object.entries(gitHubAuth(url))) headers.set(name, value);
      return this.send(source, url, { ...init, headers });
    };
  }

  async get(source: string, url: string, { accept = "application/json", conditional = false }: GetOptions = {}): Promise<Got> {
    const headers: Record<string, string> = { Accept: accept, "User-Agent": "brainchain-mcp", ...gitHubAuth(url) };
    const kept = conditional ? this.validators[url] : undefined;
    if (kept?.etag) headers["If-None-Match"] = kept.etag;
    if (kept?.lastModified) headers["If-Modified-Since"] = kept.lastModified;
    const response = await this.send(source, url, { headers, signal: AbortSignal.timeout(REQUEST_MS) });
    if (response.status === 304) {
      await response.body?.cancel().catch(() => {});
      this.count(source).notModified++;
      return { status: 304, body: "", headers: response.headers };
    }
    const body = await response.text();
    const etag = response.headers.get("etag") ?? undefined;
    const lastModified = response.headers.get("last-modified") ?? undefined;
    return { status: response.status, body, headers: response.headers, ...(conditional && (etag || lastModified) ? { validators: { ...(etag ? { etag } : {}), ...(lastModified ? { lastModified } : {}) } } : {}) };
  }

  /** Keeps a document's validators once what it said has been recorded, so a later request for it can come back unchanged. */
  commit(url: string, got: Got): void {
    if (got.validators) this.validators[url] = got.validators;
  }

  stats(): Record<string, RequestStats> {
    const since = this.clock() - HOUR_MS;
    return Object.fromEntries([...this.counts].map(([source, { times, total, notModified }]) => [source, { lastHour: times.filter((at) => at > since).length, total, notModified }]));
  }

  /** Hosts that are being left alone, and until when. */
  waiting(): Record<string, { until: string; message: string }> {
    const now = this.clock();
    return Object.fromEntries([...this.blocked].filter(([, { until }]) => until > now).map(([host, { until, message }]) => [host, { until: new Date(until).toISOString(), message }]));
  }

  private count(source: string) {
    let count = this.counts.get(source);
    if (!count) this.counts.set(source, (count = { times: [], total: 0, notModified: 0 }));
    return count;
  }

  private async send(source: string, url: string, init: RequestInit): Promise<Response> {
    const host = new URL(url).host;
    const now = this.clock();
    const block = this.blocked.get(host);
    if (block && now < block.until) throw new Backoff(block.message, block.until);
    const allowance = this.allowances.find(({ hosts }) => hosts.includes(host));
    if (allowance) {
      const times = (this.sent.get(allowance) ?? []).filter((at) => at > now - HOUR_MS);
      this.sent.set(allowance, times);
      if (times.length >= allowance.perHour) throw new Backoff(`The watcher has used the ${allowance.perHour} requests an hour it allows itself for ${host}.`, times[0]! + HOUR_MS);
      times.push(now);
    }
    const count = this.count(source);
    count.times = count.times.filter((at) => at > now - HOUR_MS);
    count.times.push(now);
    count.total++;
    const response = await this.fetchImpl(url, init);
    if (host === GITHUB_API) this.readGitHubLimit(response);
    // Binance answers 418 to an address that went on after a 429.
    if (response.status === 403 || response.status === 429 || response.status === 418) {
      await response.body?.cancel().catch(() => {});
      throw this.refused(host, response);
    }
    if (response.status === 451) {
      await response.body?.cancel().catch(() => {});
      const until = now + REGION_MS;
      const message = `${host} answered 451: it does not serve the region the watcher reads from, so the watcher leaves it alone until ${new Date(until).toISOString()}.`;
      this.blocked.set(host, { until, message, refusals: 0, at: now });
      throw new Backoff(message, until);
    }
    return response;
  }

  private readGitHubLimit(response: Response): void {
    const [limit, remaining, reset] = ["limit", "remaining", "reset"].map((name) => Number(response.headers.get(`x-ratelimit-${name}`) ?? NaN));
    if ([limit, remaining, reset].some((value) => Number.isNaN(value))) return;
    this.github = { limit: limit!, remaining: remaining!, reset: reset! * 1000 };
    const reserve = hasGitHubToken() ? GITHUB_RESERVE.withToken : GITHUB_RESERVE.withoutToken;
    if (remaining! <= reserve && response.status < 400) {
      const message = `GitHub has ${remaining} requests left this hour, which the watcher leaves for other use.`;
      this.blocked.set(GITHUB_API, { until: reset! * 1000, message, refusals: 0, at: this.clock() });
    }
  }

  /** How long a host that answered 403, 418 or 429 is left alone: as long as it said, or longer each time it does not say. */
  private refused(host: string, response: Response): Backoff {
    const now = this.clock();
    const retryAfter = Number(response.headers.get("retry-after"));
    const reset = Number(response.headers.get("x-ratelimit-reset"));
    const before = this.blocked.get(host);
    const refusals = before && now - before.at < QUIET_MS ? before.refusals + 1 : 1;
    let until: number;
    if (retryAfter > 0) until = now + retryAfter * 1000;
    else if (response.headers.get("x-ratelimit-remaining") === "0" && reset > 0) until = reset * 1000;
    else until = now + Math.min(FIRST_REFUSED_MS * 2 ** (refusals - 1), MAX_REFUSED_MS);
    const message = `${host} answered ${response.status}; the watcher leaves it alone until ${new Date(until).toISOString()}.`;
    this.blocked.set(host, { until, message, refusals, at: now });
    return new Backoff(message, until);
  }
}
