// The licence exam, as the desk's GET /exams describes it: an agent pays for a
// sitting of five items, delivers each once inside the sitting's time, and
// holds a licence when four are accepted. Every message is signed with
// personal_sign by the wallet that holds the agent's ERC-8004 id.
import { keccak256, toBytes } from "viem";

/** How many of a record's entries one read returns, counted from the first. */
export const RECORD_PAGE = 20;
/** The desk's cap on the work for one item of a sitting, as GET /exams states it. */
export const MAX_WORK_BYTES = 48_000;

export const sittingMessage = (chainId: number, agent: { chainId: number; id: string }, examClass: string, at: number): string =>
  `BrainChain exam v1\nchain ${chainId}\nagent ${agent.chainId}:${agent.id}\nclass ${examClass}\nat ${at}`;

export const resultMessage = (chainId: number, sitting: string, index: number, text: string): string =>
  `BrainChain exam result v1\nchain ${chainId}\nsitting ${sitting.toLowerCase()}\nitem ${index}\nhash ${keccak256(toBytes(text))}`;

export const briefsMessage = (chainId: number, sitting: string, at: number): string => `BrainChain exam briefs v1\nchain ${chainId}\nsitting ${sitting.toLowerCase()}\nat ${at}`;

interface Guidance {
  done: boolean;
  next: string;
  retryAfterSeconds?: number;
}

const utc = (seconds: number) => new Date(seconds * 1000).toISOString().replace(".000Z", "Z");
const list = (numbers: number[]) => (numbers.length < 2 ? numbers.join("") : `${numbers.slice(0, -1).join(", ")} and ${numbers.at(-1)}`);

/**
 * Why an item that answered every hidden case right was not accepted: the judges' answer, and how sure they were
 * of it. An answer to accept counts only at the exam's bar or above, which is named when the sitting carries it.
 * Said for a closed sitting, so a refusal with every case right explains itself. An item judged before the answer
 * was kept has only how sure the judges were, and one judged before that has nothing to give.
 */
function doubted(items: { index?: unknown; accepted?: unknown; right?: unknown; of?: unknown; judges?: unknown; confidenceBps?: unknown }[], bar: number | undefined): string {
  return items
    .flatMap((item) => (item.accepted === false && typeof item.right === "number" && item.right === item.of && typeof item.confidenceBps === "number" ? [{ ...item, confidenceBps: item.confidenceBps }] : []))
    .map(({ index, judges, confidenceBps }) => {
      const sure = `${confidenceBps / 100}%`;
      const said =
        judges === "refuse"
          ? `the judges refused it, ${sure} sure`
          : judges === "accept"
            ? `the judges accepted it at ${sure}${bar !== undefined && confidenceBps < bar ? `, under the ${bar / 100}% bar` : ""}`
            : `the judges were ${sure} sure of their answer`;
      return ` Item ${String(index)} answered every hidden case right and was not accepted: ${said}.`;
    })
    .join("");
}

/** What a sitting's state means for the agent sitting it, and when to look again. */
export function sittingGuidance(view: Record<string, unknown>, now = Date.now()): Guidance {
  const items = Array.isArray(view.items) ? (view.items as { index?: unknown; state?: unknown; accepted?: unknown }[]) : [];
  const accepted = `${items.filter((item) => item.accepted === true).length} of ${items.length} accepted`;
  const bar = typeof view.barBps === "number" ? view.barBps : undefined;
  if (view.state === "passed") {
    const expiresAt = (view.licence as { licence?: { expiresAt?: unknown } } | undefined)?.licence?.expiresAt;
    const until = typeof expiresAt === "number" ? ` It is valid until ${utc(expiresAt)}, for as long as the agent's id keeps its controller and its build.` : "";
    return { done: true, next: `Passed, with ${accepted}. The licence is in licence.${until}${doubted(items, bar)}` };
  }
  if (view.state === "failed") {
    const mark = typeof view.passMark === "number" ? `, and a pass takes ${view.passMark}` : "";
    return { done: true, next: `Failed, with ${accepted}${mark}. brainchain_exam_info says how long the agent waits before it may sit again.${doubted(items, bar)}` };
  }
  if (view.state === "void") {
    const id = typeof view.sitting === "string" ? ` ${view.sitting}` : "";
    return {
      done: true,
      next:
        "BrainChain could not run this sitting, so it is void. It does not count against the agent, which may sit again now with brainchain_sit_exam, and BrainChain refunds the payment to the address that paid it. " +
        `If the refund has not arrived, write to hello@usebrainchain.com with the sitting id${id}.`,
    };
  }
  if (view.state !== "open") return { done: false, next: "The sitting is in progress.", retryAfterSeconds: 60 };
  const open = items.flatMap((item) => (item.state === "open" && typeof item.index === "number" ? [item.index] : []));
  const deadline = typeof view.deadline === "number" ? view.deadline : undefined;
  if (open.length === 0) return { done: false, next: "Every item is delivered or missed, and the desk is judging what was delivered. Read the sitting again after retryAfterSeconds.", retryAfterSeconds: 30 };
  if (deadline !== undefined && now / 1000 > deadline) {
    return { done: false, next: `The sitting's time ran out at ${utc(deadline)}, so ${open.length === 1 ? `item ${list(open)} was` : `items ${list(open)} were`} missed. Read the sitting again after retryAfterSeconds for the outcome.`, retryAfterSeconds: 60 };
  }
  const by = deadline === undefined ? "" : ` before ${utc(deadline)}`;
  return { done: false, next: `Deliver ${open.length === 1 ? "item" : "items"} ${list(open)} with brainchain_exam_submit${by}. Each item takes one delivery, so send the finished work.` };
}
