import { getAddress, isAddress, type Address } from "viem";

/** What an agent may trade, written by whoever answers for its wallet. Every field is a rule the checks enforce. */
export interface Mandate {
  /** The chain the agent trades on. */
  chain: number;
  /** The wallet that signs the trade: 0x's taker. */
  wallet: Address;
  /** Where the bought tokens must go. */
  recipient: Address;
  /** The only tokens the agent may sell or buy. maxSell is the most of a token one trade may sell, in whole tokens; "0" lets it be bought, never sold. */
  tokens: { symbol: string; address: Address; decimals: number; maxSell: string }[];
  /** How far under 0x's quoted amount the trade's guaranteed minimum may be, in basis points. */
  maxSlippageBps: number;
  /** The last moment 0x may have signed a quote for this mandate, ISO 8601 in UTC. */
  validUntil: string;
}

/** 0x's placeholder for a chain's native token. */
export const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

const fail = (why: string): never => {
  throw new Error(`The mandate ${why}`);
};

const address = (value: unknown, field: string): Address => (typeof value === "string" && isAddress(value, { strict: false }) ? getAddress(value) : fail(`has no valid ${field} address.`));

/** A mandate read strictly: the checks read the same JSON, so a field they would misread is refused here. */
export function parseMandate(value: unknown): Mandate {
  const given = (typeof value === "object" && value !== null ? value : fail("is not a JSON object.")) as Record<string, unknown>;
  const known = ["chain", "wallet", "recipient", "tokens", "maxSlippageBps", "validUntil"];
  const unknown = Object.keys(given).filter((key) => !known.includes(key));
  if (unknown.length > 0) fail(`has fields the checks do not read: ${unknown.join(", ")}.`);
  const { chain, maxSlippageBps, validUntil, tokens } = given;
  if (!Number.isSafeInteger(chain) || (chain as number) <= 0) fail("needs chain, a chain id.");
  if (!Number.isInteger(maxSlippageBps) || (maxSlippageBps as number) < 0 || (maxSlippageBps as number) > 10_000) fail("needs maxSlippageBps, 0 to 10,000.");
  if (typeof validUntil !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(validUntil) || Number.isNaN(Date.parse(validUntil))) fail('needs validUntil as "YYYY-MM-DDTHH:MM:SSZ".');
  if (!Array.isArray(tokens) || tokens.length === 0) fail("lists no tokens.");
  const seen = new Set<string>();
  const list = (tokens as Record<string, unknown>[]).map((t, i) => {
    const symbol = typeof t.symbol === "string" && /^[A-Za-z0-9.]{1,16}$/.test(t.symbol) ? t.symbol : fail(`token ${i + 1} needs a symbol of 1 to 16 letters, digits or dots.`);
    const decimals = Number.isInteger(t.decimals) && (t.decimals as number) >= 0 && (t.decimals as number) <= 36 ? (t.decimals as number) : fail(`token ${symbol} needs decimals, 0 to 36.`);
    const maxSell = typeof t.maxSell === "string" && /^\d+(\.\d+)?$/.test(t.maxSell) ? t.maxSell : fail(`token ${symbol} needs maxSell as a decimal string, such as "25" or "0.01".`);
    if ((maxSell.split(".")[1]?.length ?? 0) > decimals) fail(`token ${symbol} has more decimals in maxSell than its ${decimals}.`);
    const at = address(t.address, `token ${symbol}`);
    if (seen.has(at.toLowerCase())) fail(`lists ${at} twice.`);
    seen.add(at.toLowerCase());
    return { symbol, address: at, decimals, maxSell };
  });
  return { chain: chain as number, wallet: address(given.wallet, "wallet"), recipient: address(given.recipient, "recipient"), tokens: list, maxSlippageBps: maxSlippageBps as number, validUntil: validUntil as string };
}

export function tokenOf(mandate: Mandate, symbolOrAddress: string): Mandate["tokens"][number] | undefined {
  const key = symbolOrAddress.toLowerCase();
  return mandate.tokens.find((t) => t.symbol.toLowerCase() === key || t.address.toLowerCase() === key);
}

/** The mandate in plain sentences, for the brief: the judges read these, the checks read the JSON. */
export function describe(mandate: Mandate): string {
  const sells = mandate.tokens.filter((t) => t.maxSell !== "0").map((t) => `${t.maxSell} ${t.symbol}`);
  const buyOnly = mandate.tokens.filter((t) => t.maxSell === "0").map((t) => t.symbol);
  return [
    `- Chain ${mandate.chain}, from wallet ${mandate.wallet}, paying out to ${mandate.recipient}.`,
    `- Tokens: ${mandate.tokens.map((t) => `${t.symbol} (${t.address})`).join(", ")}. No others, on either side of the trade.`,
    `- Most one trade may sell: ${sells.join(", ") || "nothing"}${buyOnly.length ? `; ${buyOnly.join(", ")} may only be bought` : ""}.`,
    `- The guaranteed minimum out may be at most ${mandate.maxSlippageBps} basis points under 0x's quoted amount.`,
    `- No fee to anyone but 0x.`,
    `- 0x must have signed the quote by ${mandate.validUntil}.`,
  ].join("\n");
}
