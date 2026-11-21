import { readFile } from "node:fs/promises";
import { basename } from "node:path";

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

const FIELDS = ["chain", "wallet", "recipient", "tokens", "maxSlippageBps", "validUntil"];
const TOKEN_FIELDS = ["symbol", "address", "decimals", "maxSell"];

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A mandate read strictly: the checks read the same JSON, so a field they would misread is refused here. */
export function parseMandate(value: unknown, source = "The mandate"): Mandate {
  const fail = (why: string): never => {
    throw new Error(`${source} ${why}`);
  };
  const unknownIn = (object: Record<string, unknown>, known: string[], where: string) => {
    const extra = Object.keys(object).filter((key) => !known.includes(key));
    if (extra.length > 0) fail(`has ${extra.length === 1 ? "a field" : "fields"} the checks do not read${where}: ${extra.join(", ")}.`);
  };
  const address = (value: unknown, field: string): Address => (typeof value === "string" && isAddress(value, { strict: false }) ? getAddress(value) : fail(`has no valid ${field} address.`));

  if (!isObject(value)) return fail("is not a JSON object.");
  unknownIn(value, FIELDS, "");
  const { chain, maxSlippageBps, validUntil, tokens } = value;
  if (!Number.isSafeInteger(chain) || (chain as number) <= 0) fail("needs chain, a chain id.");
  if (!Number.isInteger(maxSlippageBps) || (maxSlippageBps as number) < 0 || (maxSlippageBps as number) > 10_000) fail("needs maxSlippageBps, 0 to 10,000.");
  // Date.parse rolls 2026-02-30 over to March and reads 24:00 as the next day; a date that does not come back as written is not one.
  const until = typeof validUntil === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(validUntil) ? Date.parse(validUntil) : Number.NaN;
  if (Number.isNaN(until) || new Date(until).toISOString() !== (validUntil as string).replace("Z", ".000Z")) fail('needs validUntil as a real UTC time, "YYYY-MM-DDTHH:MM:SSZ".');
  if (!Array.isArray(tokens) || tokens.length === 0) fail("lists no tokens.");
  const seen = new Set<string>();
  const list = (tokens as unknown[]).map((t, i) => {
    if (!isObject(t)) return fail(`token ${i + 1} is not an object with symbol, address, decimals and maxSell.`);
    unknownIn(t, TOKEN_FIELDS, ` in token ${i + 1}`);
    const symbol = typeof t.symbol === "string" && /^[A-Za-z0-9.]{1,16}$/.test(t.symbol) ? t.symbol : fail(`token ${i + 1} needs a symbol of 1 to 16 letters, digits or dots.`);
    const decimals = Number.isInteger(t.decimals) && (t.decimals as number) >= 0 && (t.decimals as number) <= 36 ? (t.decimals as number) : fail(`token ${symbol} needs decimals, 0 to 36.`);
    const maxSell = typeof t.maxSell === "string" && /^\d+(\.\d+)?$/.test(t.maxSell) ? t.maxSell : fail(`token ${symbol} needs maxSell as a decimal string, such as "25" or "0.01".`);
    if ((maxSell.split(".")[1]?.length ?? 0) > decimals) fail(`token ${symbol} has more decimals in maxSell than its ${decimals}.`);
    const at = address(t.address, `token ${symbol}`);
    // Tokens are named on the command line by symbol or address, in any case.
    for (const key of [at.toLowerCase(), symbol.toLowerCase()]) {
      if (seen.has(key)) fail(`lists ${key === symbol.toLowerCase() ? symbol : at} twice.`);
      seen.add(key);
    }
    return { symbol, address: at, decimals, maxSell };
  });
  return { chain: chain as number, wallet: address(value.wallet, "wallet"), recipient: address(value.recipient, "recipient"), tokens: list, maxSlippageBps: maxSlippageBps as number, validUntil: validUntil as string };
}

/** The mandate in a file, with the file named in any error. */
export async function readMandate(file: string): Promise<Mandate> {
  const name = basename(file);
  const text = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    throw new Error(`Cannot read the mandate ${file}: ${error.code ?? error.message}.`, { cause: error });
  });
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`The mandate ${name} is not JSON: ${(error as Error).message}.`, { cause: error });
  }
  return parseMandate(value, `The mandate ${name}`);
}

export function tokenOf(mandate: Mandate, symbolOrAddress: string): Mandate["tokens"][number] | undefined {
  const key = symbolOrAddress.toLowerCase();
  return mandate.tokens.find((t) => t.symbol.toLowerCase() === key || t.address.toLowerCase() === key);
}

/** The mandate in plain sentences, for the brief: the judges read these, the checks read the JSON. */
export function describeMandate(mandate: Mandate): string {
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
