import type { EventLog, Found, WatchEvent } from "./events.js";
import { Backoff } from "./http.js";
import type { SourceState, StateFile } from "./state.js";

export interface PollContext {
  /** True until the source's first full read is recorded: what it finds until then is the baseline. */
  readonly baseline: boolean;
  readonly state: SourceState;
  /** Records what was found: during the baseline, or marked `baseline`, as rows that are never reported as new. Anything already in the log is dropped. */
  record(found: readonly Found[]): Promise<WatchEvent[]>;
  log(message: string): void;
}

export interface Poller {
  name: string;
  /** Milliseconds between reads. */
  interval: number;
  /** Returns true when there is more to read straight away, as when the chain is behind. */
  poll(context: PollContext): Promise<boolean | void>;
}

export interface SourceStatus {
  interval: number;
  baselined: boolean;
  lastRunAt?: string;
  lastOkAt?: string;
  lastError?: string;
  failures: number;
  nextAt?: string;
}

/** A refusal behind an error, such as one a client library wrapped in its own. */
function backoffIn(error: unknown): Backoff | undefined {
  for (let cause = error, depth = 0; cause instanceof Error && depth < 10; cause = cause.cause, depth++) if (cause instanceof Backoff) return cause;
  return undefined;
}

/** The longest a source that keeps failing waits between tries. */
export const MAX_WAIT_MS = 30 * 60_000;

export interface WatcherOptions {
  log: EventLog;
  state: StateFile;
  pollers: readonly Poller[];
  /**
   * What goes in a new event's `context`. It is read after the event is written, never on a poller's path; a failure is
   * written into the context rather than holding the event back.
   */
  context?: (event: WatchEvent) => Promise<Record<string, unknown>>;
  /** How many contexts are read at once. */
  readers?: number;
  /** Called with each new event once it is published, in id order, never with a baseline row. */
  onEvent?: (event: WatchEvent) => void;
  say?: (message: string) => void;
  /** Takes anything secret out of a message before it is logged or shown, such as a node's address. */
  redact?: (text: string) => string;
  clock?: () => number;
}

export const CONTEXT_READERS = 2;

/** An error in one line: a client library's short message and details rather than its full text, which repeats the request. */
export function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const { shortMessage, details } = error as { shortMessage?: unknown; details?: unknown };
  const text = typeof shortMessage === "string" ? `${shortMessage}${typeof details === "string" && details ? ` ${details}` : ""}` : error.message;
  return text.replace(/\s+/g, " ").trim().slice(0, 400);
}

/** Runs each poller on its own interval and writes what they find to the log. */
export class Watcher {
  readonly status = new Map<string, SourceStatus>();
  private readonly options: WatcherOptions;
  private readonly clock: () => number;
  private stopped = false;
  private readonly wakers = new Set<() => void>();
  private loops: Promise<void>[] = [];
  private readonly queue: WatchEvent[] = [];
  private reading = 0;
  private readonly drained = new Set<() => void>();

  constructor(options: WatcherOptions) {
    this.options = options;
    this.clock = options.clock ?? Date.now;
    for (const { name, interval } of options.pollers) this.status.set(name, { interval, baselined: options.state.source(name).baselined === true, failures: 0 });
  }

  start(): void {
    // Events written before a restart whose context was never read are read now.
    for (const event of this.options.log.pending()) this.enqueue(event);
    this.loops = this.options.pollers.map((poller) => this.loop(poller));
  }

  /** Resolves once every queued context is read and its event published. */
  idle(): Promise<void> {
    if (this.queue.length === 0 && this.reading === 0) return Promise.resolve();
    return new Promise((resolve) => this.drained.add(resolve));
  }

  private enqueue(event: WatchEvent): void {
    this.queue.push(event);
    this.pump();
  }

  private pump(): void {
    const limit = this.options.readers ?? CONTEXT_READERS;
    while (this.reading < limit && this.queue.length > 0) {
      const event = this.queue.shift()!;
      this.reading++;
      void this.read(event).finally(() => {
        this.reading--;
        this.pump();
        if (this.queue.length > 0 || this.reading > 0) return;
        for (const resolve of this.drained) resolve();
        this.drained.clear();
      });
    }
  }

  private async read(event: WatchEvent): Promise<void> {
    const { context, log, onEvent } = this.options;
    // A failure's own message can carry a node's address, so the event says only that its context was not read.
    const extra = context ? await context(event).catch(() => ({ unread: ["The context could not be read."] })) : {};
    for (const published of log.settle(event.id, extra)) if (!published.baseline) onEvent?.(published);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const wake of this.wakers) wake();
    await Promise.all(this.loops);
    this.options.state.save();
  }

  private async loop(poller: Poller): Promise<void> {
    while (!this.stopped) {
      const wait = await this.runOnce(poller);
      if (this.stopped) break;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.wakers.delete(done);
          resolve();
        };
        const timer = setTimeout(done, wait);
        this.wakers.add(done);
      });
    }
  }

  /** One read of one source. Returns how long to wait before the next. */
  async runOnce(poller: Poller): Promise<number> {
    const { state } = this.options;
    const source = state.source(poller.name);
    const status = this.status.get(poller.name)!;
    const baseline = source.baselined !== true;
    status.lastRunAt = new Date(this.clock()).toISOString();
    let wait: number;
    try {
      const more = await poller.poll({
        baseline,
        state: source,
        record: (found) => this.record(found, baseline),
        log: (message) => this.say(`${poller.name}: ${message}`),
      });
      if (baseline) {
        source.baselined = true;
        status.baselined = true;
        this.say(`${poller.name}: baseline recorded.`);
      }
      status.lastOkAt = new Date(this.clock()).toISOString();
      status.failures = 0;
      delete status.lastError;
      wait = more ? 0 : poller.interval;
    } catch (error) {
      const refused = backoffIn(error);
      // A wait for an allowance or a host that asked for one is not a failure: the source is fine and says when it can go on.
      if (!refused) status.failures++;
      status.lastError = (this.options.redact ?? ((text: string) => text))(describe(error));
      wait = refused ? Math.max(refused.until - this.clock(), 1_000) : Math.min(poller.interval * 2 ** status.failures, MAX_WAIT_MS);
      this.say(`${poller.name}: ${status.lastError} Next try in ${Math.round(wait / 1000)} s.`);
    }
    state.save();
    status.nextAt = new Date(this.clock() + wait).toISOString();
    return wait;
  }

  /** Writes what a poller found and returns at once: the context of a new event is read on the queue, off the poller's path. */
  private async record(found: readonly Found[], baseline: boolean): Promise<WatchEvent[]> {
    const observedAt = new Date(this.clock()).toISOString();
    const rows = found.map((row) => ({ ...row, ...(baseline || row.baseline ? { baseline: true as const } : {}), observedAt }));
    const { written, published } = this.options.log.append(rows);
    for (const event of published) if (!event.baseline) this.options.onEvent?.(event);
    for (const event of written) if (!event.baseline) this.enqueue(event);
    return written;
  }

  private say(message: string): void {
    const redact = this.options.redact ?? ((text: string) => text);
    (this.options.say ?? ((line: string) => console.error(line)))(redact(message));
  }
}
