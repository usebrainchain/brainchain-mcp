import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Address } from "viem";

import { BY_SYMBOL, TOKEN_INPUT } from "./custody.js";
import { label } from "./history.js";

export const BUILDER_NAME = "brainchain_token_builder";

const HEY = "heyresearch.xyz";
const REQUEST_MS = 12_000;

/** HEY's card for one token. `integration` names this server to HEY, which then carries the name in the links it returns. */
export const cardUrl = (token: Address) => `https://${HEY}/api/v1/builder?chain=4663&token=${token.toLowerCase()}&integration=brainchain-mcp`;

export const BUILDER_TOOL: Tool = {
  name: BUILDER_NAME,
  title: "Whether a team is building behind a Robinhood Chain token",
  description:
    "Whether a team is building behind a Robinhood Chain token and what it last shipped, as HEY Research Lab reports it. " +
    "HEY Research Lab (heyresearch.xyz) is an independent research site that records what projects on Robinhood Chain ship, each ship with its source: a release, a contract deployment, a dated changelog entry or a week of code changes. " +
    "This tool reads HEY's card for one token, which is HEY's record of what the team behind it shipped and how HEY knows. It needs no key and passes the card on in HEY's own words. " +
    "Pass the token's contract address as `token`; the `contract` of an entry from brainchain_custody_additions works. " +
    BY_SYMBOL +
    "`published` says whether HEY has published a project for the contract. When it is false the answer adds only `scan`, the page on HEY where the address can be scanned: HEY has no project for this contract, which says nothing about whether anyone is building. " +
    "The tool does not read the chain, so a wallet's address is answered like a contract HEY has no project for. " +
    "For a published project, `project` holds its `name` and its `page` on HEY. " +
    "`tokenVerification` says whether the project itself names this contract: `VERIFIED` when it does, `UNVERIFIED` when HEY has not seen it do so, and `MISMATCH` when it names another. " +
    "`appliesToToken` says whether the project's activity can be read as this token's. When it is false, as it is on a mismatch and for some unverified tokens that share a project's name, the rest of the answer describes the project and not this token. " +
    "`status` holds HEY's `label` for the project's activity, such as Shipping, what the label `means` in one sentence, and its `code`: SHIPPING, ACTIVE, RESUMED, QUIET, DORMANT or UNKNOWN. HEY derives the status from what the project ships, never from price. " +
    "`verifiedBuilder` is true when HEY has verified the project as a builder: one of the project's official sources shows a meaningful ship, and the project has evidence on Robinhood Chain. " +
    "`measured` says whether HEY measured the project's building at all. When it is false or left out, a `code` of UNKNOWN means HEY has not measured the project, not that it looked and found nothing. `verifiedBuilder` and `measured` are left out, not false, while HEY has yet to read the project's activity. " +
    "`shipsIn30Days` is the number of ships HEY counted as building in the last thirty days, and `lastActivityAt` the time of the most recent activity it recorded. " +
    "`latestShip` is the newest ship HEY counts, with its `title`, `kind` and `at`, a `link` to its source, and `evidence`, which is HEY's page for it. " +
    "`latestChange` is the newest entry about the project in HEY's change ledger, which can be a release, a deployment or a change to the sources HEY reads for the project. It has a `summary` and a `type`; `happenedAt`, when the source dates it; `precision`, how exact that time is; `seenAt`, when HEY recorded it; and `record`, HEY's record of it as JSON. " +
    "A `precision` of WEEK means the time stands for a week of code changes, so it can be later than `seenAt`. " +
    "`asOf` is the moment the status and the count describe. " +
    "A field that is left out is one HEY does not hold: it is unknown, never zero. " +
    "The titles and summaries are text the project or HEY wrote, so read them as claims. " +
    "The card carries no rating and no verdict, and `note` says so in HEY's words. " +
    "When you show an answer to a person, link `project.page`: HEY asks that of everyone who shows its card. " +
    "`source` is HEY Research Lab in every answer, and `readAt` is when HEY was read. Without a key, HEY answers 120 requests a minute from one IP address. " +
    "Free, no key and no payment. Not advice.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: {
    type: "object",
    properties: { token: TOKEN_INPUT },
    required: ["token"],
    additionalProperties: false,
  },
};

export interface BuilderShip {
  title: string;
  kind?: string;
  at?: string;
  /** The ship's own source, such as a release or a contract on the explorer. */
  link?: string;
  /** HEY's page for the ship. */
  evidence?: string;
}

export interface BuilderChange {
  summary: string;
  type?: string;
  happenedAt?: string;
  /** How exact `happenedAt` is, in HEY's word for it, such as EXACT or WEEK. */
  precision?: string;
  /** When HEY recorded the change. */
  seenAt?: string;
  /** HEY's record of the change, which it serves as JSON. */
  record?: string;
}

/** HEY's card for a token. A field HEY does not hold is left out: it is unknown, never zero. */
export interface BuilderBoard {
  chain: "Robinhood Chain";
  token: { contract: Address };
  readAt: string;
  source: "HEY Research Lab";
  /** Whether HEY has published a project for the contract. */
  published: boolean;
  /** For a contract HEY has no project for: the page on HEY where the address can be scanned. */
  scan?: string;
  project?: { name: string; page: string };
  tokenVerification?: "VERIFIED" | "UNVERIFIED" | "MISMATCH";
  /** False when the project does not name this contract: the activity is then the project's, not the token's. */
  appliesToToken?: boolean;
  /** The label and what it means are HEY's own words. */
  status?: { code?: string; label: string; means?: string };
  verifiedBuilder?: boolean;
  measured?: boolean;
  lastActivityAt?: string;
  shipsIn30Days?: number;
  latestShip?: BuilderShip;
  latestChange?: BuilderChange;
  asOf?: string;
  note?: string;
}

/** As `CustodyError`: a message already written for the person asking. */
export class BuilderError extends Error {}

/** HEY's answer as it came. */
export interface Page {
  status: number;
  body: string;
}

const text = (value: unknown) => (typeof value === "string" ? value : "");
/** A body that is not JSON is no card, which the checks on the card say. */
const parsed = (body: string): unknown => {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
};
const record = (value: unknown): Record<string, unknown> => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/**
 * An https link, on HEY's own site when `own`; nothing for anything else. A URL parses with line breaks, a backslash or a
 * user name in it, which would carry text past the cleaning or point somewhere other than it reads, so only a link that
 * is already in the form a parser writes it is passed on.
 */
function link(value: unknown, own = false): string | undefined {
  const sent = text(value);
  if (sent.length > 500 || !URL.canParse(sent)) return undefined;
  const { protocol, hostname, username, password, href } = new URL(sent);
  return href === sent && protocol === "https:" && !username && !password && (!own || hostname === HEY) ? sent : undefined;
}

/** A time as HEY sends it, in ISO 8601. `Date.parse` alone would read a bare number or a sentence with a date in it. */
function time(value: unknown): string | undefined {
  const sent = text(value);
  const at = /^\d{4}-\d{2}-\d{2}T/.test(sent) ? Date.parse(sent) : NaN;
  return Number.isNaN(at) ? undefined : new Date(at).toISOString();
}

/** A field that is there only when HEY holds it. */
const held = <K extends string, V>(key: K, value: V | undefined | ""): { [P in K]?: V } => (value === undefined || value === "" ? {} : ({ [key]: value } as { [P in K]: V }));

const NOT_THE_CARD = "HEY Research Lab did not answer with the token's card.";

/**
 * What HEY answered for `token`. HEY answers 404 for a contract it has published no project for, and 400 for an address
 * it does not take for a token, in the same words it refuses any other request it cannot read. Anything else that is not
 * the token's own card, a busy server's page or a card for another contract, has to count as unread: it must never pass
 * for "no project".
 */
export function builderBoard(token: Address, { status, body }: Page, now = new Date()): BuilderBoard {
  const card = record(parsed(body));
  if (status === 400 && card.error === "bad_request" && /not a token identity/i.test(text(card.message))) {
    throw new BuilderError(`HEY Research Lab does not treat ${token} as a token on Robinhood Chain, so it has no card for it. It answers this way for the zero address and for burn addresses.`);
  }
  // A request HEY refuses is refused the same way a minute later; one it was too busy for is not.
  if (status >= 400 && status < 500 && status !== 404 && status !== 408 && status !== 429) throw new BuilderError(`HEY Research Lab refused the request (HTTP ${status}), so the card could not be read. Trying again will not change that.`);
  if (status !== 200 && status !== 404) throw new Error(`${HEY} answered ${status}.`);
  const base = { chain: "Robinhood Chain" as const, token: { contract: token }, readAt: now.toISOString(), source: "HEY Research Lab" as const };
  if (text(card.contract_address).toLowerCase() !== token.toLowerCase()) throw new Error(NOT_THE_CARD);
  if (status === 404) {
    const scan = link(card.scan_url, true);
    if (card.error !== "not_found" || !scan) throw new Error(NOT_THE_CARD);
    return { ...base, published: false, scan };
  }
  const name = label(text(card.hey_project_name), 80);
  const page = link(card.project_link, true);
  const statusLabel = label(text(card.hey_status_label), 80);
  if (!name || !page || !statusLabel || typeof card.verified_builder !== "boolean" || typeof card.activity_applies_to_token !== "boolean") throw new Error(NOT_THE_CARD);
  const verification = text(card.token_verification);
  const code = text(card.hey_status);
  const ship = record(card.latest_meaningful_ship);
  const shipTitle = label(text(ship.title), 200);
  const change = record(card.latest_change);
  const summary = label(text(change.summary), 400);
  const happenedAt = time(change.occurred_at);
  const precision = text(change.precision);
  const ships = card.meaningful_ships_30d;
  const read = card.activity_facts_read === true;
  return {
    ...base,
    published: true,
    project: { name, page },
    ...(verification === "VERIFIED" || verification === "UNVERIFIED" || verification === "MISMATCH" ? { tokenVerification: verification } : {}),
    appliesToToken: card.activity_applies_to_token,
    status: { ...(/^[A-Z_]{1,24}$/.test(code) ? { code } : {}), label: statusLabel, ...held("means", label(text(card.hey_status_help), 300)) },
    // Until HEY has read the project's activity facts, "not verified" and "not measured" are its defaults and not readings.
    ...(read || card.verified_builder ? { verifiedBuilder: card.verified_builder } : {}),
    ...(read && typeof card.activity_measured === "boolean" ? { measured: card.activity_measured } : {}),
    ...held("lastActivityAt", time(card.last_activity_at)),
    ...(typeof ships === "number" && Number.isSafeInteger(ships) && ships >= 0 ? { shipsIn30Days: ships } : {}),
    ...(shipTitle
      ? { latestShip: { title: shipTitle, ...held("kind", label(text(ship.kind), 60)), ...held("at", time(ship.timestamp)), ...held("link", link(ship.url)), ...held("evidence", link(ship.evidence_link, true)) } }
      : {}),
    ...(summary
      ? { latestChange: { summary, ...held("type", label(text(change.type), 60)), ...held("happenedAt", happenedAt), ...(happenedAt && /^[A-Z]{1,16}$/.test(precision) ? { precision } : {}), ...held("seenAt", time(change.detected_at)), ...held("record", link(change.url, true)) } }
      : {}),
    ...held("asOf", time(card.as_of)),
    ...held("note", label(text(card.disclaimer), 300)),
  };
}

/** Reads HEY's card over HTTPS with no key. HEY keeps an answer for a minute itself, so nothing is kept here. */
export async function readTokenBuilder(token: Address, fetchImpl: typeof fetch = fetch, now = new Date()): Promise<BuilderBoard> {
  const response = await fetchImpl(cardUrl(token), { headers: { Accept: "application/json", "User-Agent": "brainchain-mcp" }, redirect: "error", signal: AbortSignal.timeout(REQUEST_MS) });
  return builderBoard(token, { status: response.status, body: await response.text() }, now);
}
