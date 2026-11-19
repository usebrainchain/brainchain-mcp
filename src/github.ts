/** GitHub's tokens, classic and fine-grained, are letters, digits and underscores. */
const TOKEN = /^[A-Za-z0-9_]{20,255}$/;

let token: string | undefined;

/**
 * Sets the token GitHub's API is read with, from GITHUB_TOKEN; without one the readers share the 60 requests an hour GitHub
 * allows an IP address. Returns what is wrong with a value that is not a token, which is then not used. The value itself is
 * never part of a message.
 */
export function useGitHubToken(value: string | undefined): string | undefined {
  token = undefined;
  if (value === undefined || value === "") return undefined;
  if (!TOKEN.test(value)) return "GITHUB_TOKEN is not a GitHub token, which is letters, digits and underscores, so GitHub is read without one. Fix it in this server's environment and restart the server.";
  token = value;
  return undefined;
}

export const hasGitHubToken = () => token !== undefined;

/** The token as a header, for GitHub's API only: the other hosts the readers ask are public and are sent no key. */
export const gitHubAuth = (url: string): Record<string, string> => (token && new URL(url).host === "api.github.com" ? { Authorization: `Bearer ${token}` } : {});
