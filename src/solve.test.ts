import { describe, expect, it, vi } from "vitest";

import { literal, readBoard, resultOf, runSolve, SolveUsageError, type SolveOptions } from "./solve.js";

const CHECKS = 'RECORD = 367\nprint("valid set of " + str(len(solution["words"])) + " words; record to beat: " + str(RECORD))\nassert len(solution["words"]) > RECORD, "valid, but not above the record"';
const BRIEF = `Zero-error code, 7-cycle, length 5.\n\n\`\`\`python checks\n${CHECKS}\n\`\`\``;
const SLUG = "shannon-capacity-c7-5";
const GRADE = `0x${"82".repeat(32)}`;
const PAYER = "0x269cd35D2ce871e70221b577e877893fe3fee042";
const CLAIM = { wallet: "0x11aa…22bb", decision: "4990", at: "2026-11-26T08:00:00.000Z", windowEnds: "2026-12-03T08:00:00.000Z" };

const boardBody = (open: boolean, claim: typeof CLAIM | null = null) => ({
  board: "https://usebrainchain.com/problems",
  open,
  asset: "USDC",
  payoutChain: "Base",
  windowDays: 7,
  problems: [
    {
      problem: SLUG,
      name: "Zero-error code, 7-cycle, length 5",
      record: { display: "367 words", holder: "Polak and Schrijver" },
      bounty: open ? { amount: 500, asset: "USDC" } : null,
      claim,
      answer: { format: '{"words": [[0, 2, 0, 2, 0], ...]}', note: "Distinct lists of five integers from 0 to 6." },
      briefId: `0x${"19".repeat(32)}`,
      request: { title: "Fifth power of the 7-cycle: more than 367 words", brief: BRIEF, levels: ["Passes the checks", "Fails the checks"], pass: 0 },
    },
  ],
});

const graded = (accepted: boolean, checks: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  grade: GRADE,
  state: "graded",
  accepted,
  answer: accepted ? "accept" : "reject",
  passProbability: accepted ? 0.97 : 0,
  checks: { language: "python", ...checks },
  decision: { id: "5123", page: "https://usebrainchain.com/decision?id=5123" },
  done: true,
  ...extra,
});

function world(options: { open?: boolean; claim?: typeof CLAIM; reply?: Record<string, unknown>; later?: Record<string, unknown>[]; file?: string; at?: string } = {}) {
  const lines: string[] = [];
  const grade = vi.fn(async (_request: unknown) => options.reply ?? graded(true, { outcome: "passed", output: "valid set of 368 words; record to beat: 367\n" }));
  const later = [...(options.later ?? [])];
  const getGrade = vi.fn(async (_id: string) => later.shift() ?? {});
  const fetched: string[] = [];
  const clock = { value: Date.parse(options.at ?? "2026-11-27T19:31:00Z") };
  const solve: SolveOptions = {
    boardUrl: "https://usebrainchain.com/problems.json",
    fetch: (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      fetched.push(url);
      if (url.endsWith("/problems.json")) return Response.json(boardBody(options.open ?? true, options.claim ?? null));
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch,
    desk: () => ({ desk: { grade, getGrade }, origin: "https://brain.usebrainchain.com", cost: "0.25 USDC", wallet: PAYER, chain: "Base" }),
    read: async () => options.file ?? JSON.stringify({ words: [[0, 2, 0, 2, 0], [0, 2, 1, 1, 2]] }),
    wait: async (ms) => {
      clock.value += ms;
    },
    log: (line) => lines.push(line),
    now: () => clock.value,
  };
  return { solve, lines, grade, getGrade, fetched };
}

describe("literal", () => {
  it("writes whole numbers, plain strings, lists and objects as text Python reads the same way", () => {
    expect(literal({ words: ["0101", "1010"], matrix: [[1, -1], [-1, 1]] })).toBe('{"words":["0101","1010"],"matrix":[[1,-1],[-1,1]]}');
    expect(resultOf({ words: [[0, 2]] })).toBe('```python\nsolution = {"words":[[0,2]]}\n```');
  });

  it("refuses what JSON and Python write differently, or what could be more than data", () => {
    for (const bad of [{ a: true }, { a: null }, { a: 1.5 }, { a: 2 ** 60 }, { a: 'x"y' }, { a: "x\\y" }, { a: "x\ny" }, { a: "`" }, { 'a"': 1 }, [1, 2], "words", 7]) {
      expect(() => literal(bad), JSON.stringify(bad)).toThrow(SolveUsageError);
    }
  });
});

describe("readBoard", () => {
  it("reads the board, with no bounty while closed and the answer that holds one when the board shows it", () => {
    expect(readBoard(boardBody(false)).problems[0]).toMatchObject({ bounty: null, claim: null });
    expect(readBoard(boardBody(true, CLAIM)).problems[0]).toMatchObject({ bounty: { amount: 500, asset: "USDC" }, claim: CLAIM });
    expect(readBoard(boardBody(true, { ...CLAIM, at: "soon" })).problems[0]!.claim).toBeNull();
  });

  it("says to update when the board is not in a format it knows", () => {
    for (const bad of [undefined, {}, { ...boardBody(true), problems: [{ problem: "x" }] }, { ...boardBody(true), open: "yes" }]) expect(() => readBoard(bad)).toThrow(/could not be read/);
  });
});

describe("runSolve", () => {
  it("lists the problems without making a paying client, naming no amount while bounties are closed", async () => {
    const w = world({ open: false });
    const desk = vi.spyOn(w.solve, "desk");
    expect(await runSolve([], w.solve)).toBe(0);
    const text = w.lines.join("\n");
    expect(text).toContain(`${SLUG}\n      Zero-error code, 7-cycle, length 5. Record to beat: 367 words (Polak and Schrijver).\n      Format:`);
    expect(text).toContain("Bounties are not open");
    expect(text).not.toMatch(/\d+ USDC/);
    expect(desk).not.toHaveBeenCalled();
  });

  it("lists who holds a bounty through its window, and who won it after", async () => {
    const held = world({ claim: CLAIM });
    await runSolve([], held.solve);
    expect(held.lines.join("\n")).toContain("Bounty: 500 USDC, held for 0x11aa…22bb until 2026-12-03 08:00 UTC.");
    const won = world({ claim: CLAIM, at: "2026-12-03T08:00:00Z" });
    await runSolve([], won.solve);
    expect(won.lines.join("\n")).toContain("Bounty: 500 USDC, won by 0x11aa…22bb.");
    const open = world();
    await runSolve([], open.solve);
    expect(open.lines.join("\n")).toContain("(Polak and Schrijver). Bounty: 500 USDC.\n");
  });

  it("sends the answer as one assignment with the problem's own request, and never says it came first", async () => {
    const w = world();
    expect(await runSolve([SLUG, "answer.json"], w.solve)).toBe(0);
    expect(w.grade).toHaveBeenCalledWith({
      title: "Fifth power of the 7-cycle: more than 367 words",
      brief: BRIEF,
      levels: ["Passes the checks", "Fails the checks"],
      pass: 0,
      result: '```python\nsolution = {"words":[[0,2,0,2,0],[0,2,1,1,2]]}\n```',
    });
    // The board file is the only thing read besides the grade itself.
    expect(w.fetched).toEqual(["https://usebrainchain.com/problems.json"]);
    expect(w.lines).toEqual([
      "Zero-error code, 7-cycle, length 5. Record to beat: 367 words (Polak and Schrijver).",
      `Sending answer.json to be checked. This costs 0.25 USDC from ${PAYER} on Base, whatever the verdict.`,
      "Checked: valid set of 368 words; record to beat: 367",
      "Accepted. Decision 5123: https://usebrainchain.com/decision?id=5123",
      "The 500 USDC bounty goes to the earliest accepted answer. https://usebrainchain.com/problems shows the answer that holds it, through its 7-day objection window.",
    ]);
    expect(w.lines.join("\n")).not.toMatch(/first/i);
  });

  it("says an earlier answer holds the bounty when the board shows one", async () => {
    const w = world({ claim: CLAIM });
    expect(await runSolve([SLUG, "answer.json"], w.solve)).toBe(0);
    expect(w.lines.at(-1)).toBe("The board shows an answer accepted on 2026-11-26 08:00 UTC holding the 500 USDC bounty (decision 4990). Yours is recorded, and takes its place only if that answer is withdrawn in its objection window.");
  });

  it("promises no bounty while they are closed", async () => {
    const w = world({ open: false });
    expect(await runSolve([SLUG, "answer.json"], w.solve)).toBe(0);
    expect(w.lines.at(-1)).toBe("Bounties are not open, so no bounty is paid for this answer.");
    expect(w.fetched).toEqual(["https://usebrainchain.com/problems.json"]);
  });

  it("gives the checker's own reason for a refusal, and exits 1", async () => {
    const tie = world({ reply: graded(false, { outcome: "failed", error: "AssertionError", output: "valid set of 367 words; record to beat: 367\nTraceback (most recent call last):\n  File \"<exec>\", line 18, in <module>\nAssertionError: valid, but not above the record\n" }) });
    expect(await runSolve([SLUG, "answer.json"], tie.solve)).toBe(1);
    expect(tie.lines.slice(2)).toEqual(["Checked: valid set of 367 words; record to beat: 367", "Refused: valid, but not above the record. Decision 5123: https://usebrainchain.com/decision?id=5123"]);

    const slow = world({ reply: graded(false, { outcome: "timed out", output: "" }) });
    expect(await runSolve([SLUG, "answer.json"], slow.solve)).toBe(1);
    expect(slow.lines.at(-1)).toContain("Refused: the checker ran out of time on this answer.");

    const judged = world({ reply: graded(false, { outcome: "passed", output: "valid set of 368 words; record to beat: 367\n" }, { passProbability: 0.41 }) });
    expect(await runSolve([SLUG, "answer.json"], judged.solve)).toBe(1);
    expect(judged.lines.at(-1)).toContain("Refused: the checker passed, and the graders did not accept the answer (pass probability 41%).");
  });

  it("reads a verdict that is not in yet until it is, and never sends the answer twice", async () => {
    const w = world({
      reply: { grade: GRADE, state: "paid", done: false, retryAfterSeconds: 20 },
      later: [{ grade: GRADE, state: "paid", done: false, retryAfterSeconds: 20 }, graded(true, { outcome: "passed", output: "valid set of 368 words; record to beat: 367\n" })],
    });
    expect(await runSolve([SLUG, "answer.json"], w.solve)).toBe(0);
    expect(w.grade).toHaveBeenCalledOnce();
    expect(w.getGrade).toHaveBeenCalledTimes(2);
    expect(w.lines).toContain("Accepted. Decision 5123: https://usebrainchain.com/decision?id=5123");
  });

  it("keeps reading a grade whose first reply timed out after paying, and reports its verdict", async () => {
    const timedOut = { grade: GRADE, possiblyCharged: true, done: false, error: "The desk did not confirm the grade (timeout). The payment may have gone through. Read it with brainchain_get_grade." };
    const w = world({ reply: timedOut, later: [{ grade: GRADE, error: "The desk has no grade with this id.", done: false, retryAfterSeconds: 60 }, graded(true, { outcome: "passed", output: "valid set of 368 words; record to beat: 367\n" })] });
    expect(await runSolve([SLUG, "answer.json"], w.solve)).toBe(0);
    expect(w.grade).toHaveBeenCalledOnce();
    expect(w.getGrade).toHaveBeenCalledTimes(2);
    expect(w.lines).toContain("Waiting for the verdict. Checking and grading can take a few minutes.");
    expect(w.lines).toContain("Accepted. Decision 5123: https://usebrainchain.com/decision?id=5123");
  });

  it("exits 2 and says not to send again when the verdict is still not in after fifteen minutes", async () => {
    const w = world({ reply: { grade: GRADE, possiblyCharged: true, done: false, error: "The desk did not confirm the grade (timeout). The payment may have gone through. Read it with brainchain_get_grade." } });
    expect(await runSolve([SLUG, "answer.json"], w.solve)).toBe(2);
    expect(w.grade).toHaveBeenCalledOnce();
    expect(w.lines.slice(-2)).toEqual([
      "The verdict is not in yet.",
      `Do not send the answer again. Read the verdict at https://brain.usebrainchain.com/x402/grades/${GRADE}`,
    ]);
  });

  it("stops when the desk says a timed-out answer was never charged", async () => {
    const w = world({ reply: { grade: GRADE, possiblyCharged: true, done: false, error: "timeout" } });
    w.getGrade.mockRejectedValueOnce(new Error("The desk has no grade with this id. This server sent it more than 10 minutes ago, so it was never charged, and it can be sent again."));
    expect(await runSolve([SLUG, "answer.json"], w.solve)).toBe(2);
    expect(w.lines.at(-1)).toContain("never charged, and it can be sent again");
  });

  it("refuses before paying: an unknown problem, a file that is not JSON, and an answer too long to check", async () => {
    const w = world();
    const desk = vi.spyOn(w.solve, "desk");
    await expect(runSolve(["cap-sets", "answer.json"], w.solve)).rejects.toThrow(`The board has no problem named cap-sets. It lists: ${SLUG}.`);
    await expect(runSolve([SLUG], w.solve)).rejects.toThrow(SolveUsageError);
    await expect(runSolve([SLUG, "answer.json"], world({ file: "words: 0101" }).solve)).rejects.toThrow('answer.json is not JSON. The answer\'s format is {"words": [[0, 2, 0, 2, 0], ...]}');
    await expect(runSolve([SLUG, "answer.json"], world({ file: JSON.stringify({ words: Array.from({ length: 6000 }, () => [0, 2, 0, 2, 0]) }) }).solve)).rejects.toThrow(/too long to check: with the checker it comes to \d{2},\d{3} characters/);
    expect(desk).not.toHaveBeenCalled();
    expect(w.grade).not.toHaveBeenCalled();
  });
});
