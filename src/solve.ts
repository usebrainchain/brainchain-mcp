// brainchain-mcp solve: answer a problem on BrainChain's problem board. A problem there is a brief with an exact
// checker as its checks, so an answer is a paid grade like any other: BrainChain runs the checker on it, the decision
// is recorded, and an accepted answer is published in the record.
import type { Desk } from "./tools.js";

export const BOARD_URL = "https://usebrainchain.com/problems.json";

export const SOLVE_USAGE = `brainchain-mcp solve

Answer an open problem on BrainChain's problem board, https://usebrainchain.com/problems.

Usage:
  brainchain-mcp solve                      List the problems with the record each answer has to beat.
  brainchain-mcp solve <problem> <file>     Send the answer in <file> to be checked. The file holds JSON in the
                                            problem's format, such as {"words": [[0, 2, 0, 2, 0], ...]}.

BrainChain runs the problem's checker on the answer and records the decision. Each answer costs one grade from the
paying wallet, whatever the verdict: run brainchain-mcp init to create that wallet, and brainchain-mcp wallet to check it.
An accepted answer is published in its decision record, so send only what may be public.

Exits 0 when the answer is accepted, 1 when it is refused, and 2 when it could not be sent or the verdict is not in yet.

Environment:
  BRAINCHAIN_PROBLEMS_URL   Where the board is read from (default ${BOARD_URL}).
`;

export class SolveUsageError extends Error {}

interface BoardProblem {
  problem: string;
  name: string;
  record: { display: string; holder: string };
  bounty: { amount: number; asset: string } | null;
  /** The accepted answer the board shows for the problem, when it shows one. */
  claim: { wallet: string; decision: string; at: string; windowEnds: string } | null;
  answer: { format: string; note: string };
  briefId: string;
  request: { title: string; brief: string; levels: string[]; pass: number };
}

interface Board {
  board: string;
  open: boolean;
  windowDays: number;
  problems: BoardProblem[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;

export function readBoard(body: unknown): Board {
  const unreadable = new Error("The problem board could not be read: it is not in the format this version knows. Update brainchain-mcp and try again.");
  if (!isRecord(body) || typeof body.open !== "boolean" || !isText(body.board) || typeof body.windowDays !== "number" || !Array.isArray(body.problems)) throw unreadable;
  const problems = body.problems.map((p): BoardProblem => {
    if (!isRecord(p) || !isText(p.problem) || !isText(p.name) || !isRecord(p.record) || !isText(p.record.display) || !isText(p.record.holder)) throw unreadable;
    if (!isRecord(p.answer) || !isText(p.answer.format) || !isText(p.answer.note) || !isText(p.briefId) || !isRecord(p.request)) throw unreadable;
    const { title, brief, levels, pass } = p.request;
    if (!isText(title) || !isText(brief) || !Array.isArray(levels) || !levels.every(isText) || typeof pass !== "number") throw unreadable;
    const bounty = isRecord(p.bounty) && typeof p.bounty.amount === "number" && isText(p.bounty.asset) ? { amount: p.bounty.amount, asset: p.bounty.asset } : null;
    const c = p.claim;
    const claim = isRecord(c) && isText(c.wallet) && isText(c.decision) && isText(c.at) && isText(c.windowEnds) && !Number.isNaN(Date.parse(c.at)) && !Number.isNaN(Date.parse(c.windowEnds)) ? { wallet: c.wallet, decision: c.decision, at: c.at, windowEnds: c.windowEnds } : null;
    return { problem: p.problem, name: p.name, record: { display: p.record.display, holder: p.record.holder }, bounty, claim, answer: { format: p.answer.format, note: p.answer.note }, briefId: p.briefId, request: { title, brief, levels, pass } };
  });
  return { board: body.board, open: body.open, windowDays: body.windowDays, problems };
}

/**
 * The answer as text that is JSON and a Python literal at once, so the checker reads exactly what the file holds.
 * Whole numbers, plain strings, lists and objects qualify; anything the two languages write differently does not.
 */
export function literal(value: unknown): string {
  const plain = (text: string): boolean => /^[0-9A-Za-z_ .+-]*$/.test(text);
  const check = (v: unknown, at: string): void => {
    if (typeof v === "number") {
      if (!Number.isSafeInteger(v)) throw new SolveUsageError(`${at} is ${v}: numbers in an answer are whole and below 2^53.`);
    } else if (typeof v === "string") {
      if (!plain(v)) throw new SolveUsageError(`${at} is a string with characters other than letters, digits, spaces and _ . + -.`);
    } else if (Array.isArray(v)) v.forEach((item, i) => check(item, `${at}[${i}]`));
    else if (isRecord(v)) {
      for (const [key, item] of Object.entries(v)) {
        if (!plain(key)) throw new SolveUsageError(`${at} has the key ${JSON.stringify(key)}, with characters other than letters, digits, spaces and _ . + -.`);
        check(item, `${at}.${key}`);
      }
    } else throw new SolveUsageError(`${at} is ${JSON.stringify(v) ?? typeof v}: an answer holds whole numbers, strings, lists and objects only.`);
  };
  if (!isRecord(value)) throw new SolveUsageError("The answer file must hold one JSON object, in the problem's format.");
  check(value, "solution");
  return JSON.stringify(value);
}

/** The delivered work: one Python block that assigns the answer and does nothing else. */
export const resultOf = (solution: unknown): string => `\`\`\`python\nsolution = ${literal(solution)}\n\`\`\``;

/** The most BrainChain's sandbox runs as one program: the answer and the checker together. */
const MAX_PROGRAM = 64_000;
const checksIn = (brief: string): string => /```python checks\n([\s\S]*?)```\s*$/.exec(brief)?.[1] ?? "";

export interface SolveOptions {
  boardUrl: string;
  fetch: typeof fetch;
  /** The paying client, made only once an answer is ready to send. */
  desk: () => { desk: Pick<Desk, "grade" | "getGrade">; origin: string; cost: string; wallet?: string; chain: string };
  read: (path: string) => Promise<string>;
  wait: (ms: number) => Promise<void>;
  log: (line: string) => void;
  now: () => number;
}

const utc = (iso: string): string => `${new Date(iso).toISOString().slice(0, 16).replace("T", " ")} UTC`;
const lastLine = (text: string): string => text.trim().split("\n").at(-1)?.trim() ?? "";

async function board(options: SolveOptions): Promise<Board> {
  const response = await options.fetch(options.boardUrl, { signal: AbortSignal.timeout(20_000) }).catch((error: unknown) => {
    throw new Error(`The problem board at ${options.boardUrl} could not be reached (${error instanceof Error ? error.message : String(error)}).`);
  });
  if (!response.ok) throw new Error(`The problem board at ${options.boardUrl} answered ${response.status}.`);
  return readBoard(await response.json().catch(() => undefined));
}

/** What the board shows about a problem's bounty: its amount, and the accepted answer that holds it or beat the record. */
function standing(p: BoardProblem, now: number): string {
  const sum = p.bounty ? `${p.bounty.amount} ${p.bounty.asset}` : undefined;
  if (!p.claim) return sum ? ` Bounty: ${sum}.` : "";
  if (!sum) return ` Beaten on ${utc(p.claim.at)}, in decision ${p.claim.decision}.`;
  return now < Date.parse(p.claim.windowEnds) ? ` Bounty: ${sum}, held for ${p.claim.wallet} until ${utc(p.claim.windowEnds)}.` : ` Bounty: ${sum}, won by ${p.claim.wallet}.`;
}

function list(b: Board, now: number): string {
  const rows = b.problems.map((p) => `  ${p.problem}\n      ${p.name}. Record to beat: ${p.record.display} (${p.record.holder}).${standing(p, now)}\n      Format: ${p.answer.format}`);
  const bounty = b.open ? "The earliest accepted answer to each problem wins its bounty." : "Bounties are not open: answers are checked and recorded, and none is paid.";
  return `Open problems on ${b.board}\n\n${rows.join("\n\n")}\n\n${bounty}\nSend an answer with: brainchain-mcp solve <problem> <file>`;
}

/** Runs the command and returns its exit code. */
export async function runSolve(args: readonly string[], options: SolveOptions): Promise<number> {
  const { log } = options;
  if (args.length !== 0 && args.length !== 2) throw new SolveUsageError("solve takes a problem and a file, or nothing to list the problems.");
  const b = await board(options);
  if (args.length === 0) {
    log(list(b, options.now()));
    return 0;
  }
  const [slug, path] = args as [string, string];
  const problem = b.problems.find((p) => p.problem === slug);
  if (!problem) throw new SolveUsageError(`The board has no problem named ${slug}. It lists: ${b.problems.map((p) => p.problem).join(", ")}.`);
  const text = await options.read(path).catch((error: unknown) => {
    throw new SolveUsageError(`${path} could not be read (${error instanceof Error ? error.message : String(error)}).`);
  });
  let solution: unknown;
  try {
    solution = JSON.parse(text);
  } catch {
    throw new SolveUsageError(`${path} is not JSON. The answer's format is ${problem.answer.format}`);
  }
  const result = resultOf(solution);
  const program = result.length + checksIn(problem.request.brief).length;
  if (program > MAX_PROGRAM) throw new SolveUsageError(`The answer is too long to check: with the checker it comes to ${program.toLocaleString("en-US")} characters, and BrainChain runs at most ${MAX_PROGRAM.toLocaleString("en-US")}.`);

  const { desk, origin, cost, wallet, chain } = options.desk();
  log(`${problem.name}. Record to beat: ${problem.record.display} (${problem.record.holder}).`);
  log(`Sending ${path} to be checked. This costs ${cost}${wallet ? ` from ${wallet}` : ""} on ${chain}, whatever the verdict.`);
  let reply = (await desk.grade({ ...problem.request, result })) as Record<string, unknown>;
  const id = typeof reply.grade === "string" ? reply.grade : undefined;
  // A verdict that takes longer than the desk's first reply is read until it is in, for up to fifteen minutes. That
  // includes a reply that timed out after paying: reading the grade is free, and the desk says when it was never charged.
  if (id && reply.state !== "graded" && reply.done !== true) log("Waiting for the verdict. Checking and grading can take a few minutes.");
  for (const until = options.now() + 15 * 60_000; id && reply.state !== "graded" && reply.done !== true && options.now() < until; ) {
    await options.wait((typeof reply.retryAfterSeconds === "number" ? reply.retryAfterSeconds : 20) * 1000);
    try {
      reply = (await desk.getGrade(id)) as Record<string, unknown>;
    } catch (error) {
      log(error instanceof Error ? error.message : String(error));
      return 2;
    }
  }
  if (reply.state !== "graded") {
    log(typeof reply.error === "string" ? reply.error : `The verdict is not in yet${typeof reply.state === "string" ? ` (state: ${reply.state})` : ""}.`);
    if (id) log(`Do not send the answer again. Read the verdict at ${origin}/x402/grades/${id}`);
    return 2;
  }

  const checks = isRecord(reply.checks) ? reply.checks : {};
  const output = typeof checks.output === "string" ? checks.output : "";
  const printed = output.split("\n").find((line) => line.startsWith("valid "));
  if (printed) log(`Checked: ${printed.trim()}`);
  const decision = isRecord(reply.decision) ? reply.decision : {};
  const record = typeof decision.id === "string" ? ` Decision ${decision.id}${typeof decision.page === "string" ? `: ${decision.page}` : typeof decision.record === "string" ? `: ${decision.record}` : ""}` : "";
  if (reply.accepted !== true) {
    const why =
      checks.outcome === "timed out"
        ? "the checker ran out of time on this answer"
        : checks.outcome === "failed"
          ? lastLine(output).replace(/^AssertionError:\s*/, "") || "the answer failed the checker"
          : `the checker passed, and the graders did not accept the answer${typeof reply.passProbability === "number" ? ` (pass probability ${Math.round(reply.passProbability * 100)}%)` : ""}`;
    log(`Refused: ${why}.${record}`);
    return 1;
  }
  log(`Accepted.${record}`);
  // Which answer came first is BrainChain's to say: the command knows its own answer and what the board showed.
  if (!problem.bounty) {
    log("Bounties are not open, so no bounty is paid for this answer.");
    return 0;
  }
  const sum = `${problem.bounty.amount} ${problem.bounty.asset}`;
  if (problem.claim && problem.claim.decision !== decision.id) {
    log(`The board shows an answer accepted on ${utc(problem.claim.at)} holding the ${sum} bounty (decision ${problem.claim.decision}). Yours is recorded, and takes its place only if that answer is withdrawn in its objection window.`);
  } else log(`The ${sum} bounty goes to the earliest accepted answer. ${b.board} shows the answer that holds it, through its ${b.windowDays}-day objection window.`);
  return 0;
}
