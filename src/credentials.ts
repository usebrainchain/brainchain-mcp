/** Credentials in formats ordinary text does not take, each matched only as a whole word. */
const KINDS: [string, RegExp][] = [
  ["a private key", /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/],
  ["an AWS access key id", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["a GitHub token", /\b(?:gh[pous]_|github_pat_)[A-Za-z0-9_]{20,}/],
  ["an OpenAI or Anthropic API key", /(?<![\w-])sk-[A-Za-z0-9_-]{20,}/],
  ["a Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["a Stripe live key", /\b[rs]k_live_[A-Za-z0-9]{16,}/],
];

/**
 * Briefs and results are published and cannot be withdrawn, so a request that carries a credential is refused before
 * anything is paid, signed or sent. The error names the field and the kind, never the credential.
 */
export function refuseCredentials(fields: [string, string | undefined][]): void {
  for (const [field, value] of fields) {
    const kind = value === undefined ? undefined : KINDS.find(([, pattern]) => pattern.test(value))?.[0];
    if (kind) {
      throw new Error(`${field} contains ${kind}. Briefs and results are published and cannot be withdrawn, so nothing was sent: nothing was paid and no free check was used. Remove or replace it, then send again.`);
    }
  }
}
