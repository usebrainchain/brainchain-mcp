import { afterEach, describe, expect, it } from "vitest";

import { useGitHubToken } from "../github.js";

import { Backoff, FIRST_REFUSED_MS, GITHUB_RESERVE, QUIET_MS, REGION_MS, Requests } from "./http.js";

const API = "https://api.github.com/repos/BitGo/BitGoJS/pulls";
const RAW = "https://raw.githubusercontent.com/BitGo/BitGoJS/master/x";

interface Sent {
  url: string;
  headers: Headers;
}

/** A fetch that answers with `answer` and records what it was sent. */
function serving(answer: (sent: Sent) => Response) {
  const sent: Sent[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = { url: String(input), headers: new Headers(init?.headers) };
    sent.push(request);
    return answer(request);
  }) as typeof fetch;
  return { sent, fetchImpl };
}

describe("the watcher's requests", () => {
  afterEach(() => void useGitHubToken(undefined));

  it("ask again with the validators only once what the answer said was recorded, and count a 304 as nothing new", async () => {
    const { sent, fetchImpl } = serving(({ headers }) => (headers.get("if-none-match") === '"v1"' ? new Response(null, { status: 304 }) : new Response("[]", { headers: { etag: '"v1"', "last-modified": "Wed, 18 Nov 2026 17:02:42 GMT" } })));
    const requests = new Requests({ fetch: fetchImpl });
    const first = await requests.get("bitgo-prs", API, { conditional: true });
    expect(first.validators).toEqual({ etag: '"v1"', lastModified: "Wed, 18 Nov 2026 17:02:42 GMT" });
    // Not committed: the answer was not dealt with, so the next request must not come back unchanged.
    expect((await requests.get("bitgo-prs", API, { conditional: true })).status).toBe(200);
    requests.commit(API, first);
    expect(requests.validators[API]).toEqual(first.validators);
    const again = await requests.get("bitgo-prs", API, { conditional: true });
    expect(again).toMatchObject({ status: 304, body: "" });
    expect(sent[2]!.headers.get("if-modified-since")).toBe("Wed, 18 Nov 2026 17:02:42 GMT");
    expect(requests.stats()["bitgo-prs"]).toEqual({ lastHour: 3, total: 3, notModified: 1 });
  });

  it("resume with validators kept from an earlier run", async () => {
    const { sent, fetchImpl } = serving(() => new Response(null, { status: 304 }));
    const requests = new Requests({ fetch: fetchImpl, validators: { [API]: { etag: '"kept"' } } });
    expect((await requests.get("bitgo-prs", API, { conditional: true })).status).toBe(304);
    expect(sent[0]!.headers.get("if-none-match")).toBe('"kept"');
  });

  it("send GITHUB_TOKEN to GitHub's API alone", async () => {
    const { sent, fetchImpl } = serving(() => new Response("[]"));
    useGitHubToken("ghp_0123456789abcdefghij");
    const requests = new Requests({ fetch: fetchImpl });
    await requests.get("bitgo-prs", API);
    await requests.get("bitgo-lists", RAW);
    await requests.fetchFor("bitgo-lists")(API);
    expect(sent.map(({ headers }) => headers.get("authorization"))).toEqual(["Bearer ghp_0123456789abcdefghij", null, "Bearer ghp_0123456789abcdefghij"]);
  });

  it("hold to the allowance they are given, and say when the oldest request leaves the hour", async () => {
    let now = 1_000_000;
    const { sent, fetchImpl } = serving(() => new Response("[]"));
    const requests = new Requests({ fetch: fetchImpl, clock: () => now, allowances: [{ hosts: ["api.github.com"], perHour: 2 }] });
    await requests.get("a", API);
    now += 1000;
    await requests.get("b", API);
    await expect(requests.get("c", API)).rejects.toEqual(expect.objectContaining({ until: 1_000_000 + 3_600_000 }));
    // Another host has no allowance here.
    await requests.get("c", RAW);
    now += 3_600_000;
    await requests.get("c", API);
    expect(sent).toHaveLength(4);
  });

  it("leave a host alone until the time its refusal names, without asking it in between", async () => {
    let now = 1_000_000;
    let refuse = true;
    const { sent, fetchImpl } = serving(() =>
      refuse ? new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "2000", "x-ratelimit-limit": "60" } }) : new Response("[]", { headers: { "x-ratelimit-remaining": "59", "x-ratelimit-limit": "60", "x-ratelimit-reset": "5000" } }),
    );
    const requests = new Requests({ fetch: fetchImpl, clock: () => now });
    const refused = await requests.get("bitgo-prs", API).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(Backoff);
    expect((refused as Backoff).until).toBe(2_000_000);
    await expect(requests.get("bitgo-merges", API)).rejects.toBeInstanceOf(Backoff);
    expect(sent).toHaveLength(1);
    expect(Object.keys(requests.waiting())).toEqual(["api.github.com"]);
    // Other hosts are not held back.
    refuse = false;
    await requests.get("bitgo-lists", RAW);
    now = 2_000_000;
    await requests.get("bitgo-prs", API);
    expect(requests.github).toEqual({ limit: 60, remaining: 59, reset: 5_000_000 });
    expect(requests.waiting()).toEqual({});
  });

  it("wait as long as a 429's retry-after says, and longer each time a refusal says nothing", async () => {
    let now = 0;
    let headers: Record<string, string> = { "retry-after": "120" };
    const { fetchImpl } = serving(() => new Response("{}", { status: 429, headers }));
    const requests = new Requests({ fetch: fetchImpl, clock: () => now });
    expect(((await requests.get("kucoin", "https://api.kucoin.com/api/v3/currencies").catch((error: unknown) => error)) as Backoff).until).toBe(120_000);
    headers = {};
    now = 120_000;
    expect(((await requests.get("kucoin", "https://api.kucoin.com/api/v3/currencies").catch((error: unknown) => error)) as Backoff).until).toBe(120_000 + 2 * FIRST_REFUSED_MS);
    now = 120_000 + 2 * FIRST_REFUSED_MS;
    expect(((await requests.get("kucoin", "https://api.kucoin.com/api/v3/currencies").catch((error: unknown) => error)) as Backoff).until).toBe(now + 4 * FIRST_REFUSED_MS);
  });

  it("stop asking GitHub when it is down to what the watcher leaves for other use", async () => {
    const { sent, fetchImpl } = serving(() => new Response("[]", { headers: { "x-ratelimit-remaining": String(GITHUB_RESERVE.withoutToken), "x-ratelimit-limit": "60", "x-ratelimit-reset": "9000" } }));
    const requests = new Requests({ fetch: fetchImpl, clock: () => 0 });
    expect((await requests.get("bitgo-prs", API)).status).toBe(200);
    await expect(requests.get("bitgo-prs", API)).rejects.toEqual(expect.objectContaining({ until: 9_000_000 }));
    expect(sent).toHaveLength(1);
  });

  it("leave a host that does not serve the watcher's region alone for six hours, and take Binance's 418 as a refusal", async () => {
    let status = 451;
    const { sent, fetchImpl } = serving(() => new Response("{}", { status, headers: status === 418 ? { "retry-after": "300" } : {} }));
    const requests = new Requests({ fetch: fetchImpl, clock: () => 0 });
    const URL = "https://fapi.binance.com/fapi/v1/exchangeInfo";
    const refused = (await requests.get("binance-futures-markets", URL).catch((error: unknown) => error)) as Backoff;
    expect(refused).toBeInstanceOf(Backoff);
    expect(refused.until).toBe(REGION_MS);
    expect(refused.message).toContain("does not serve the region");
    await expect(requests.get("binance-futures-markets", URL)).rejects.toBeInstanceOf(Backoff);
    expect(sent).toHaveLength(1);
    status = 418;
    expect(((await requests.get("binance-markets", "https://data-api.binance.vision/api/v3/exchangeInfo").catch((error: unknown) => error)) as Backoff).until).toBe(300_000);
  });

  it("keep waiting longer for a host that refuses again soon after answering, and start over once it has been quiet", async () => {
    let now = 0;
    let refuse = true;
    const { fetchImpl } = serving(() => (refuse ? new Response("{}", { status: 429 }) : new Response("[]")));
    const requests = new Requests({ fetch: fetchImpl, clock: () => now });
    const URL = "https://rpc.mainnet.chain.robinhood.com/";
    const wait = async () => ((await requests.get("chain", URL).catch((error: unknown) => error)) as Backoff).until - now;
    expect(await wait()).toBe(FIRST_REFUSED_MS);
    now += FIRST_REFUSED_MS;
    refuse = false;
    await requests.get("chain", URL);
    refuse = true;
    expect(await wait()).toBe(2 * FIRST_REFUSED_MS);
    now += 2 * FIRST_REFUSED_MS + QUIET_MS;
    expect(await wait()).toBe(FIRST_REFUSED_MS);
  });
});
