import { randomUUID } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

import { readJson, writeJson } from "./files.ts";
import { deliverable, gradeRequest, JOB, prompt, type OrderRequest } from "./job.ts";
import { Unanswered, type Judge, type Paid, type Signed, type Verdict } from "./judge.ts";

export type OrderState = "working" | "grading" | "accepted" | "not accepted" | "failed" | "dry";

export interface Attempt {
  delivery: string;
  /** The payment signed for this delivery's grade, written here before it is sent. */
  signed?: Signed;
  paid?: Paid;
  verdict?: Verdict;
}

export interface Order {
  id: string;
  createdAt: string;
  state: OrderState;
  request: OrderRequest;
  attempts: Attempt[];
  /** What became of the buyer's payment for work that was not accepted, as the refund hook records it. */
  refund?: string;
  reason?: string;
}

/** What the seller does with a delivery BrainChain did not accept. This is the seller's policy, not BrainChain's. */
export interface Policy {
  /** Whether to do the work again. Each redo is a new delivery and a new paid grade. */
  redo(order: Order): boolean;
  /** Settles with the buyer once no redo is left. */
  refund(order: Order): Promise<void>;
}

export const DEFAULT_POLICY: Policy = {
  redo: (order) => order.attempts.length < 2,
  // A live seller pays the buyer back here, from wherever it took the payment, and keeps the reference in
  // order.refund. This example moves no money.
  refund: async (order) => {
    order.refund = "owed";
  },
};

export interface Seller {
  order(request: OrderRequest): Promise<{ order: string } & Record<string, unknown>>;
  view(id: string): ({ order: string } & Record<string, unknown>) | undefined;
  /** Resolves once every order record being written is on disk. Call it before the folder is removed or the process stops. */
  flush(): Promise<void>;
}

/** What the buyer sees: the delivery only once BrainChain accepted it, and the decision page of every grade. */
function view(order: Order) {
  const last = order.attempts.at(-1);
  const judged = order.attempts.flatMap(({ verdict }) =>
    verdict
      ? [{ accepted: verdict.accepted, passProbability: verdict.passProbability, bar: verdict.bar, ...(verdict.checks ? { tests: verdict.checks.outcome } : {}), decision: verdict.decision }]
      : [],
  );
  return {
    order: order.id,
    job: JOB.title,
    state: order.state,
    ...(order.state === "accepted" && last ? { delivery: last.delivery } : {}),
    ...(judged.length ? { judged } : {}),
    ...(order.refund ? { refund: order.refund } : {}),
    ...(order.reason ? { reason: order.reason } : {}),
  };
}

export async function createSeller(options: {
  dir: string;
  judge: Judge;
  /** The seller's worker: takes the job as text and returns the delivery. */
  work: (prompt: string) => Promise<string>;
  policy?: Policy;
  log?: (line: string) => void;
  /** How long an order waits before it sends a payment BrainChain did not answer again. */
  retryMs?: number;
}): Promise<Seller> {
  const { judge, work, policy = DEFAULT_POLICY, log = console.error, retryMs = 60_000 } = options;
  const dir = join(options.dir, "orders");
  const orders = new Map<string, Order>();
  // An order's state changes in memory first, so a reader can see it settled while its record is still being written.
  const writing = new Set<Promise<void>>();
  const save = (order: Order) => {
    const write = writeJson(join(dir, `${order.id}.json`), order);
    writing.add(write);
    const done = () => void writing.delete(write);
    write.then(done, done);
    return write;
  };

  async function deliver(order: Order, last?: Attempt): Promise<Attempt> {
    order.state = "working";
    await save(order);
    const attempt = { delivery: deliverable(await work(prompt(order.request, last))) };
    order.attempts.push(attempt);
    return attempt;
  }

  /**
   * A signed payment is on disk before it is sent, and only that payment is ever sent for the attempt, however often.
   * The one exception is a payment that expired before it reached BrainChain, which can never be charged.
   */
  async function grade(order: Order, attempt: Attempt): Promise<Verdict | undefined> {
    if (attempt.paid) return judge.read(attempt.paid);
    if (attempt.signed && (await judge.lapsed(attempt.signed))) {
      log(`order ${order.id}: the payment signed for grade ${attempt.signed.grade} expired before it reached BrainChain and can never be charged; signing a new one.`);
      delete attempt.signed;
    }
    if (!attempt.signed) {
      const signed = await judge.sign(gradeRequest(order.request, attempt.delivery));
      if (!signed) return undefined;
      attempt.signed = signed;
      await save(order);
    }
    return judge.send(attempt.signed, (paid) => {
      attempt.paid = paid;
      return save(order);
    });
  }

  async function run(order: Order): Promise<void> {
    for (;;) {
      const last = order.attempts.at(-1);
      const attempt = last && !last.verdict ? last : await deliver(order, last);
      order.state = "grading";
      await save(order);
      const verdict = await grade(order, attempt);
      if (!verdict) {
        order.state = "dry";
        return save(order);
      }
      attempt.verdict = verdict;
      if (verdict.accepted) {
        order.state = "accepted";
        return save(order);
      }
      if (policy.redo(order)) continue;
      order.state = "not accepted";
      await policy.refund(order);
      return save(order);
    }
  }

  function start(order: Order): void {
    run(order).catch(async (error: unknown) => {
      if (error instanceof Unanswered) {
        log(`order ${order.id}: ${error.message} Sending the same payment again in ${retryMs / 1000} s.`);
        setTimeout(() => start(order), retryMs);
        return;
      }
      order.state = "failed";
      order.reason = error instanceof Error ? error.message : String(error);
      log(`order ${order.id} failed: ${order.reason}`);
      await save(order);
    });
  }

  await mkdir(dir, { recursive: true });
  for (const name of await readdir(dir)) {
    if (!name.endsWith(".json")) continue;
    const order = await readJson<Order>(join(dir, name));
    if (order) orders.set(order.id, order);
  }
  // An order the last run left open picks up where it stopped: a grade it paid for is read, and a payment it signed is
  // sent again as it was.
  for (const order of orders.values()) if (order.state === "working" || order.state === "grading") start(order);

  return {
    async order(request) {
      const order: Order = { id: randomUUID(), createdAt: new Date().toISOString(), state: "working", request, attempts: [] };
      orders.set(order.id, order);
      await save(order);
      start(order);
      return view(order);
    },
    view(id) {
      const order = orders.get(id);
      return order && view(order);
    },
    async flush() {
      // A write that finishes can be followed at once by the next save of the same order.
      while (writing.size > 0) await Promise.allSettled([...writing]);
    },
  };
}
