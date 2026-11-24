import { resolveConfig, type Config } from "./config.js";
import { freeSetting, freeUrl, LOGIN_FILE, needsWallet, readLogin, saveLogin, walletNext, type Login } from "./free.js";
import { installCommands } from "./init.js";
import { cliCommand } from "./server.js";

const GITHUB = "https://github.com";
const GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const UNREACHABLE = "BrainChain's free-check service could not be reached, so nothing was used. Try again in a few minutes. If it keeps failing, check your internet connection.";

export interface LoginOptions {
  fetch?: typeof fetch;
  wait?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  now?: () => number;
  read?: () => Login | undefined;
  save?: (login: Login) => void;
  platform?: NodeJS.Platform;
  /** Sign in anew even when the kept sign-in works. */
  again?: boolean;
}

/** GitHub answers the device flow's errors with 200 and an `error` field, and its successes with the fields it names. */
async function post(fetchImpl: typeof fetch, url: string, form: Record<string, string>): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(url, { method: "POST", headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form), signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new Error("GitHub could not be reached, so the sign-in did not start. Try again in a few minutes. If it keeps failing, check your internet connection.");
  }
  const body = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined;
  if (!body) throw new Error(`GitHub answered ${response.status} with nothing readable. Run login again in a minute.`);
  return body;
}

/** What GitHub's error means for the person signing in. */
function signInFailed(code: unknown, description: unknown, init: string): Error {
  if (code === "expired_token") return new Error("The code expired before it was approved. Run login again for a new one.");
  if (code === "access_denied") return new Error("The sign-in was cancelled on GitHub. Run login again to sign in.");
  if (code === "device_flow_disabled" || code === "incorrect_client_credentials" || code === "Not Found") {
    return new Error(`BrainChain's GitHub sign-in is not open right now. Try again later, or set up a wallet with \`${init}\`.`);
  }
  return new Error(`GitHub refused the sign-in${typeof description === "string" && description ? `: ${description.replace(/[.!?]+$/, "")}` : typeof code === "string" ? ` (${code})` : ""}. Run login again.`);
}

/** The account's free checks as the service tells them, and login's exit code: 1 for an account too new to have any yet. */
function standing(status: Record<string, unknown> | undefined, lead: string, config: Config, init: string): { line: string; code: number } {
  const who = typeof status?.login === "string" ? `@${status.login}` : "your GitHub account";
  if (typeof status?.error === "string" && needsWallet(status.reason)) return { line: `${lead} ${who}. ${status.error} ${walletNext(config, init, status.reason)}`, code: status.reason === "young" ? 1 : 0 };
  const left = typeof status?.left === "number" && typeof status.error !== "string" ? status.left : undefined;
  if (left === undefined) {
    return { line: `${lead} ${who}, and the sign-in is saved. BrainChain could not say just now how many free checks you have left: ask your agent to grade work with brainchain_grade, and its reply will say.`, code: 0 };
  }
  return { line: `${lead} ${who}. You have ${left} free ${left === 1 ? "check" : "checks"} left: ask your agent to grade work with brainchain_grade.`, code: 0 };
}

/**
 * Signs in with GitHub's device flow for BrainChain's free checks: GitHub shows the code's page, the person approves it there,
 * and the token GitHub issues is kept in LOGIN_FILE with the checks it was made for. It asks for no scopes, so it reads only
 * the public profile. A working sign-in already kept is reported, not replaced, unless `again` is set. Returns the exit code.
 */
export async function runLogin(env: Record<string, string | undefined>, version: string, options: LoginOptions = {}): Promise<number> {
  const { fetch: fetchImpl = fetch, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), log = console.log, now = Date.now, read = readLogin, save = saveLogin, platform = process.platform, again = false } = options;
  const config = resolveConfig(env, { payments: false });
  const init = cliCommand("init", config, version, {}, platform);
  const url = freeUrl(env, config.name);
  if (!url) throw new Error(`Free checks are for BrainChain mainnet, and BRAINCHAIN_NETWORK is ${config.name}. On testnet, pay with test USDC from a wallet: run \`${init}\` in a terminal.`);
  const base = url.href.replace(/\/+$/, "");
  const settings = freeSetting(url, config.name);
  const install = ["If BrainChain is not in your MCP client yet, add it:", ...installCommands(config, version, settings, platform).flatMap(([client, command]) => ["", client, `  ${command}`])];

  let info: Record<string, unknown> | undefined;
  try {
    const response = await fetchImpl(`${base}/free`, { signal: AbortSignal.timeout(20_000) });
    info = response.ok ? ((await response.json().catch(() => undefined)) as Record<string, unknown> | undefined) : undefined;
  } catch {
    throw new Error(UNREACHABLE);
  }
  if (!info || typeof info.clientId !== "string" || typeof info.perAccount !== "number" || info.open !== true) throw new Error(`BrainChain's free checks are not open right now. ${walletNext(config, init, "closed")}`);
  if (info.network !== config.name) throw new Error(`Those free checks pay for grades on BrainChain ${String(info.network)}, and BRAINCHAIN_NETWORK is ${config.name}.`);
  const me = (token: string) => fetchImpl(`${base}/free/me`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) }).then((response) => response.json().catch(() => ({})) as Promise<Record<string, unknown>>);

  const kept = again ? undefined : read();
  if (kept && kept.url === url.href && kept.network === config.name) {
    const status = await me(kept.token).catch(() => {
      throw new Error(UNREACHABLE);
    });
    // Only a sign-in GitHub no longer takes is replaced; any other refusal is said as it is, and the sign-in kept.
    if (typeof status.login === "string") {
      const { line, code } = standing(status, "Already signed in as", config, init);
      log([line, "", `To sign in with another GitHub account, run \`${cliCommand("login --again", config, version, {}, platform, settings)}\`.`, "", ...install].join("\n"));
      return code;
    }
    if (status.reason !== "login") throw new Error(`${typeof status.error === "string" ? status.error : "BrainChain could not check your sign-in just now. Try again in a few minutes."} Your sign-in is kept as it was.`);
  }

  const device = await post(fetchImpl, `${GITHUB}/login/device/code`, { client_id: info.clientId });
  if (typeof device.device_code !== "string" || typeof device.user_code !== "string") throw signInFailed(device.error, device.error_description ?? device.message, init);
  const page = typeof device.verification_uri === "string" && device.verification_uri.startsWith("https://") ? device.verification_uri : `${GITHUB}/login/device`;
  log(`Open ${page} and enter the code ${device.user_code}.`);
  log("Waiting for you to approve BrainChain on GitHub…");

  let interval = 1000 * (Number(device.interval) || 5);
  const deadline = now() + 1000 * (Number(device.expires_in) || 900);
  let token: string | undefined;
  while (!token) {
    await wait(interval);
    if (now() > deadline) throw signInFailed("expired_token", undefined, init);
    // A dropped connection or an unreadable answer is waited out like a pending approval, up to the code's expiry.
    const answer = await post(fetchImpl, `${GITHUB}/login/oauth/access_token`, { client_id: info.clientId, device_code: device.device_code, grant_type: GRANT }).catch(() => ({ error: "authorization_pending" }) as Record<string, unknown>);
    if (typeof answer.access_token === "string") token = answer.access_token;
    else if (answer.error === "slow_down") interval = 1000 * (Number(answer.interval) || interval / 1000 + 5);
    else if (answer.error !== "authorization_pending") throw signInFailed(answer.error, answer.error_description, init);
  }
  save({ token, url: url.href, network: config.name });

  const { line, code } = standing(await me(token).catch(() => undefined), "Signed in as", config, init);
  log(
    [
      line,
      "",
      `The sign-in is kept in ${LOGIN_FILE}${platform === "win32" ? "" : ", readable only by your account"}. BrainChain reads only your public GitHub profile with it, and keeps only your account's id, how many of its ${info.perAccount} free checks it used, and each free grade's id with a hash of its request. Delete the file to sign out.`,
      "",
      ...install,
    ].join("\n"),
  );
  return code;
}
