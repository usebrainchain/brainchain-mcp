import { LOGIN_COMMAND } from "./free.js";
import { firstLine } from "./payments.js";

export const GITHUB_API = "https://api.github.com";

/** A watcher route's answer: the status and the JSON body. */
export interface Answer {
  status: number;
  body: Record<string, unknown>;
}

export const answer = (status: number, reason: string, error: string): Answer => ({ status, body: { reason, error } });

export const SIGN_IN = answer(401, "login", `Sign in with GitHub first: run \`${LOGIN_COMMAND}\` in a terminal.`);

/** A GitHub account signed in through `brainchain-mcp login`. */
export interface GitHubAccount {
  id: string;
  login: string;
  createdAt: number;
}

export interface SignInOptions {
  /** The client id of BrainChain's GitHub OAuth app. */
  clientId: string;
  fetch: typeof fetch;
  /** What each refusal says was left untouched, such as "no free check was used". */
  untouched: string;
  /** The log line's lead, such as "free checks". */
  label: string;
  say: (line: string) => void;
}

/** The account a GitHub sign-in belongs to, read once from GitHub and never kept, or why it cannot be used. */
export async function signedIn(token: string | undefined, { clientId, fetch: fetchImpl, untouched, label, say }: SignInOptions): Promise<GitHubAccount | Answer> {
  if (!token) return SIGN_IN;
  let response: Response;
  try {
    response = await fetchImpl(`${GITHUB_API}/user`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "brainchain-watch" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    say(`${label}: GitHub did not answer (${firstLine(error)})`);
    return answer(503, "unavailable", `GitHub could not be reached to check your sign-in, and ${untouched}. Try again in a minute.`);
  }
  if (response.status === 401) return answer(401, "login", `Your GitHub sign-in has expired or was revoked. Run \`${LOGIN_COMMAND}\` again.`);
  // GitHub names the app that issued a token in X-OAuth-Client-Id (seen on /user for a device-flow token from BrainChain's
  // app on 25 Nov 2026), so a personal token or another app's token is refused.
  if (response.ok && response.headers.get("x-oauth-client-id") !== clientId) {
    return answer(401, "login", `That GitHub sign-in was not made through brainchain-mcp login. Run \`${LOGIN_COMMAND}\` to sign in, then try again.`);
  }
  const user = response.ok ? ((await response.json().catch(() => undefined)) as Record<string, unknown> | undefined) : undefined;
  const createdAt = Date.parse(String(user?.created_at));
  if (!user || typeof user.id !== "number" || typeof user.login !== "string" || Number.isNaN(createdAt)) {
    say(`${label}: GitHub answered ${response.status}`);
    return answer(503, "unavailable", `GitHub did not confirm your sign-in just now, and ${untouched}. Try again in a minute.`);
  }
  return { id: String(user.id), login: user.login, createdAt };
}
