import { describe, expect, it } from "vitest";

import { FREE_URL, type Login } from "./free.js";
import { runLogin, type LoginOptions } from "./login.js";

const CLIENT = "Ov23liAbCdEfGhIjKlMn";
const TOKEN = "gho_16C7e42F292c6912E7710c838347Ae178B4a";
const KEPT = "gho_keptkeptkeptkeptkeptkeptkeptkept0000";
const SIGNED_IN: Login = { token: TOKEN, url: `${FREE_URL}/`, network: "mainnet" };

interface Script {
  /** What the token endpoint answers on each poll, in turn: a body, a whole response, or a failed request. */
  polls?: (Record<string, unknown> | Response | Error)[];
  info?: Response | Error;
  device?: Record<string, unknown>;
  me?: Record<string, unknown> | ((token: string) => Response | Error);
}

/** GitHub's device flow and BrainChain's free checks, as fetch sees them. */
function github({ polls = [{ error: "authorization_pending" }, { access_token: TOKEN, token_type: "bearer", scope: "" }], info, device, me = { login: "octocat", left: 2 } }: Script = {}) {
  const requests: { url: string; form?: Record<string, string>; authorization?: string | null }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const form = req.method === "POST" ? Object.fromEntries(new URLSearchParams(await req.text())) : undefined;
    requests.push({ url: req.url, ...(form ? { form } : {}), ...(req.headers.has("authorization") ? { authorization: req.headers.get("authorization") } : {}) });
    const { pathname } = new URL(req.url);
    if (info instanceof Error && pathname === "/free") throw info;
    if (pathname === "/free") return (info as Response | undefined) ?? Response.json({ network: "mainnet", chain: "Base", clientId: CLIENT, perAccount: 2, open: true });
    if (pathname === "/free/me") {
      const answer = typeof me === "function" ? me(req.headers.get("authorization")!.slice("Bearer ".length)) : Response.json(me);
      if (answer instanceof Error) throw answer;
      return answer;
    }
    if (req.url === "https://github.com/login/device/code") {
      expect(req.headers.get("accept")).toBe("application/json");
      return Response.json(device ?? { device_code: "3584d83530557fdd1f46af8289938c8ef79f9dc5", user_code: "WDJB-MJHT", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 });
    }
    if (req.url === "https://github.com/login/oauth/access_token") {
      const poll = polls.shift() ?? { error: "expired_token" };
      if (poll instanceof Error) throw poll;
      return poll instanceof Response ? poll : Response.json(poll);
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

function run(script: Script = {}, env: Record<string, string | undefined> = {}, options: LoginOptions = {}) {
  const { fetchImpl, requests } = github(script);
  const out: string[] = [];
  const waits: number[] = [];
  const saved: Login[] = [];
  let clock = 0;
  const done = runLogin(env, "0.0.0-test", {
    fetch: fetchImpl,
    wait: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
    now: () => clock,
    log: (line) => out.push(line),
    read: () => undefined,
    save: (login) => saved.push(login),
    platform: "darwin",
    ...options,
  });
  return { done, out, waits, saved, requests };
}

describe("login", () => {
  it("runs GitHub's device flow with the free checks' client id, keeps the token and says what is left", async () => {
    const { done, out, waits, saved, requests } = run();
    expect(await done).toBe(0);
    expect(saved).toEqual([SIGNED_IN]);
    expect(waits).toEqual([5000, 5000]);
    expect(requests.find(({ url }) => url.endsWith("/device/code"))!.form).toEqual({ client_id: CLIENT });
    expect(requests.find(({ url }) => url.endsWith("/access_token"))!.form).toEqual({ client_id: CLIENT, device_code: "3584d83530557fdd1f46af8289938c8ef79f9dc5", grant_type: "urn:ietf:params:oauth:grant-type:device_code" });
    expect(requests.find(({ url }) => url.endsWith("/free/me"))!.authorization).toBe(`Bearer ${TOKEN}`);
    expect(out[0]).toBe("Open https://github.com/login/device and enter the code WDJB-MJHT.");
    expect(out[1]).toBe("Waiting for you to approve BrainChain on GitHub…");
    expect(out[2]).toContain("Signed in as @octocat. You have 2 free checks left: ask your agent to grade work with brainchain_grade.");
    expect(out[2]).toContain("The sign-in is kept in ~/.brainchain/github.token, readable only by your account. BrainChain reads only your public GitHub profile with it, and keeps only your account's id, how many of its 2 free checks it used, and each free grade's id with a hash of its request. Delete the file to sign out.");
    expect(out[2]).toContain("claude mcp add brainchain --scope user -- npx -y brainchain-mcp@0.0.0-test");
    expect(out.join("\n")).not.toContain(TOKEN);
  });

  it("waits longer when GitHub says to slow down", async () => {
    const { done, waits } = run({ polls: [{ error: "slow_down", interval: 10 }, { error: "authorization_pending" }, { access_token: TOKEN }] });
    expect(await done).toBe(0);
    expect(waits).toEqual([5000, 10_000, 10_000]);
  });

  it("waits out a dropped connection or an unreadable answer from GitHub while you approve", async () => {
    const { done, saved, waits } = run({ polls: [new TypeError("fetch failed"), new Response("<html>502</html>", { status: 502 }), { error: "authorization_pending" }, { access_token: TOKEN }] });
    expect(await done).toBe(0);
    expect(saved).toEqual([SIGNED_IN]);
    expect(waits).toEqual([5000, 5000, 5000, 5000]);
    const expired = run({ device: { device_code: "d", user_code: "AAAA-BBBB", verification_uri: "https://github.com/login/device", expires_in: 12, interval: 5 }, polls: Array(5).fill(new TypeError("fetch failed")) });
    await expect(expired.done).rejects.toThrow("The code expired before it was approved. Run login again for a new one.");
  });

  it("stops at a cancelled sign-in or an expired code, and keeps nothing", async () => {
    const denied = run({ polls: [{ error: "access_denied", error_description: "The authorization request was denied." }] });
    await expect(denied.done).rejects.toThrow("The sign-in was cancelled on GitHub. Run login again to sign in.");
    expect(denied.saved).toEqual([]);
    const expired = run({ device: { device_code: "d", user_code: "AAAA-BBBB", verification_uri: "https://github.com/login/device", expires_in: 12, interval: 5 }, polls: Array(5).fill({ error: "authorization_pending" }) });
    await expect(expired.done).rejects.toThrow("The code expired before it was approved. Run login again for a new one.");
    expect(expired.saved).toEqual([]);
  });

  it("tells an account too new for free checks when it qualifies and how to grade today, and exits 1", async () => {
    const young = "Free checks are for GitHub accounts older than 30 days. @fresh was created on 2026-11-10, so it qualifies on 2026-12-10.";
    const { done, out, saved } = run({ me: { login: "fresh", left: 0, reason: "young", error: young } });
    expect(await done).toBe(1);
    expect(saved).toEqual([SIGNED_IN]);
    expect(out[2]).toContain(`Signed in as @fresh. ${young} To grade today, set up a wallet: run \`npx -y brainchain-mcp@0.0.0-test init\` in a terminal.`);
    expect(out.join("\n")).not.toContain("keep grading");
  });

  it("tells an account that used its checks how to keep grading", async () => {
    const { done, out } = run({ me: { login: "octocat", left: 0, reason: "used", error: "@octocat has used its 2 free checks." } });
    expect(await done).toBe(0);
    expect(out[2]).toContain("Signed in as @octocat. @octocat has used its 2 free checks. To keep grading, set up a wallet: run `npx -y brainchain-mcp@0.0.0-test init` in a terminal.");
  });

  it("says the sign-in worked when what is left cannot be read just then", async () => {
    const { done, out, saved } = run({ me: { reason: "unavailable", error: "GitHub could not be reached to check your sign-in, and no free check was used. Try again in a minute." } });
    expect(await done).toBe(0);
    expect(saved).toEqual([SIGNED_IN]);
    expect(out[2]).toContain("Signed in with GitHub, and the sign-in is saved. The number of free checks left could not be read just now; your agent's first brainchain_grade reply will show it.");
    expect(out[2]).not.toMatch(/try again|run login/i);
  });

  it("shows the limits the free checks serve, and stops before GitHub while they are closed", async () => {
    const served = run({ info: Response.json({ network: "mainnet", chain: "Base", clientId: CLIENT, perAccount: 3, minAccountDays: 30, open: true }) });
    expect(await served.done).toBe(0);
    expect(served.out[2]).toContain("how many of its 3 free checks it used");
    for (const info of [{ open: false, paused: true }, { open: false }, {}]) {
      const closed = run({ info: Response.json({ network: "mainnet", chain: "Base", clientId: CLIENT, perAccount: 2, ...info }) });
      await expect(closed.done).rejects.toThrow("BrainChain's free checks are not open right now. To grade now, set up a wallet: run `npx -y brainchain-mcp@0.0.0-test init` in a terminal.");
      expect(closed.requests.map(({ url }) => url)).toEqual([`${FREE_URL}/free`]);
    }
  });

  it("says when the sign-in is not open, and on testnet that free checks are for mainnet", async () => {
    await expect(run({ info: Response.json({ error: "This watcher gives no free checks." }, { status: 404 }) }).done).rejects.toThrow("BrainChain's free checks are not open right now.");
    await expect(run({ device: { error: "device_flow_disabled" } }).done).rejects.toThrow("BrainChain's GitHub sign-in is not open right now.");
    const testnet = run({}, { BRAINCHAIN_NETWORK: "testnet" });
    await expect(testnet.done).rejects.toThrow("Free checks are for BrainChain mainnet, and BRAINCHAIN_NETWORK is testnet. On testnet, pay with test USDC from a wallet: run `BRAINCHAIN_NETWORK=testnet npx -y brainchain-mcp@0.0.0-test init` in a terminal.");
    expect(testnet.requests).toEqual([]);
  });

  it("blames the service before the connection when the free checks cannot be reached", async () => {
    const down = run({ info: new TypeError("fetch failed") });
    await expect(down.done).rejects.toThrow(
      /^BrainChain's free-check service could not be reached, and no free check was used\. Try again in a few minutes\. If it keeps failing, check your internet connection\.$/,
    );
  });

  it("puts a free checks' address other than the network's own in the line that adds the server", async () => {
    const info = Response.json({ network: "testnet", chain: "Base Sepolia", clientId: CLIENT, perAccount: 2, open: true });
    const { done, out, saved, requests } = run({ info }, { BRAINCHAIN_NETWORK: "testnet", BRAINCHAIN_FREE_URL: "http://127.0.0.1:8787" });
    expect(await done).toBe(0);
    expect(requests[0]!.url).toBe("http://127.0.0.1:8787/free");
    expect(saved).toEqual([{ token: TOKEN, url: "http://127.0.0.1:8787/", network: "testnet" }]);
    expect(out[2]).toContain("claude mcp add brainchain --scope user -e BRAINCHAIN_NETWORK=testnet -e BRAINCHAIN_FREE_URL='http://127.0.0.1:8787' -- npx -y brainchain-mcp@0.0.0-test");
    const own = run({}, { BRAINCHAIN_FREE_URL: FREE_URL });
    expect(await own.done).toBe(0);
    expect(own.out[2]).toContain("claude mcp add brainchain --scope user -- npx -y brainchain-mcp@0.0.0-test");
  });
});

describe("login run again", () => {
  const kept = (login: Partial<Login> = {}): LoginOptions => ({ read: () => ({ ...SIGNED_IN, token: KEPT, ...login }) });
  const answers = (byToken: Record<string, Response | Error>) => (token: string) => byToken[token] ?? Response.json({ reason: "login", error: "Your GitHub sign-in has expired or was revoked." }, { status: 401 });

  it("says who is signed in and what is left, and keeps the sign-in", async () => {
    const { done, out, saved, requests } = run({ me: answers({ [KEPT]: Response.json({ login: "octocat", left: 1 }) }) }, {}, kept());
    expect(await done).toBe(0);
    expect(saved).toEqual([]);
    expect(requests.some(({ url }) => url.startsWith("https://github.com/"))).toBe(false);
    expect(out[0]).toContain("Already signed in as @octocat. You have 1 free check left: ask your agent to grade work with brainchain_grade.");
    expect(out[0]).toContain("To sign in with another GitHub account, run `npx -y brainchain-mcp@0.0.0-test login --again`.");
    expect(out[0]).toContain("claude mcp add brainchain --scope user -- npx -y brainchain-mcp@0.0.0-test");
  });

  it("exits 1 for an account still too new", async () => {
    const young = "Free checks are for GitHub accounts older than 30 days. @fresh was created on 2026-11-10, so it qualifies on 2026-12-10.";
    const { done, out } = run({ me: answers({ [KEPT]: Response.json({ login: "fresh", left: 0, reason: "young", error: young }) }) }, {}, kept());
    expect(await done).toBe(1);
    expect(out[0]).toContain(`Already signed in as @fresh. ${young} To grade today, set up a wallet`);
  });

  it("signs in anew with --again, for a sign-in GitHub no longer takes, or one made for other free checks", async () => {
    const me = answers({ [KEPT]: Response.json({ login: "octocat", left: 1 }), [TOKEN]: Response.json({ login: "octocat", left: 1 }) });
    for (const options of [{ ...kept(), again: true }, kept({ token: "gho_revokedrevokedrevokedrevoked0000" }), kept({ url: "http://127.0.0.1:8787/", network: "testnet" })]) {
      const { done, out, saved } = run({ me }, {}, options);
      expect(await done).toBe(0);
      expect(saved).toEqual([SIGNED_IN]);
      expect(out[0]).toBe("Open https://github.com/login/device and enter the code WDJB-MJHT.");
    }
  });

  it("keeps the sign-in when it cannot be checked just now", async () => {
    const limited = Response.json({ error: "Too many free-check requests from your network address." }, { status: 429 });
    const busy = run({ me: answers({ [KEPT]: limited }) }, {}, kept());
    await expect(busy.done).rejects.toThrow("Too many free-check requests from your network address. Your sign-in is kept as it was.");
    const down = run({ me: answers({ [KEPT]: new TypeError("fetch failed") }) }, {}, kept());
    await expect(down.done).rejects.toThrow("BrainChain's free-check service could not be reached, and no free check was used.");
    expect([...busy.saved, ...down.saved]).toEqual([]);
  });

});
