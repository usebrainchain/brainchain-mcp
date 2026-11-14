import { randomUUID } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

import { readJson, writeJson } from "./files.ts";
import { deliverable, gradeRequest, JOB, prompt, type OrderRequest } from "./job.ts";
import type { Judge, Paid, Verdict } from "./judge.ts";

export type OrderState = "working" | "grading" | "accepted" | "not accepted" | "failed" | "dry";

export interface Attempt {
  delivery: string;
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
}): Promise<Seller> {
  const { judge, work, policy = DEFAULT_POLICY, log = console.error } = options;
  const dir = join(options.dir, "orders");
  const orders = new Map<string, Order>();
  const save = (order: Order) => writeJson(join(dir, `${order.id}.json`), order);

  async function deliver(order: Order, last?: Attempt): Promise<Attempt> {
    order.state = "working";
    await save(order);
    const attempt = { delivery: deliverable(await work(prompt(order.request, last))) };
    order.attempts.push(attempt);
    return attempt;
  }

  async function run(order: Order): Promise<void> {
    for (;;) {
      const last = order.attempts.at(-1);
      const attempt = last && !last.verdict ? last : await deliver(order, last);
      order.state = "grading";
      await save(order);
      const verdict = attempt.paid
        ? await judge.read(attempt.paid)
        : await judge.grade(gradeRequest(order.request, attempt.delivery), (paid) => {
            attempt.paid = paid;
            return save(order);
          });
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
  // An order the last run left open picks up where it stopped. A grade it paid for is read, never paid again. One it
  // was still paying for is sent again, and BrainChain answers the same request from the same wallet from the first grade.
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
  };
}
