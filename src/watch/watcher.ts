import { dedupeKey, type EventLog, type Found, type WatchEvent } from "./events.js";
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
  /** What goes in a new event's `context`. A failure leaves it empty rather than holding the event back. */
  context?: (found: Found) => Promise<Record<string, unknown>>;
  /** Called with each new event once it is written, never with a baseline row. */
  onEvent?: (event: WatchEvent) => void;
  say?: (message: string) => void;
  clock?: () => number;
}

/** Runs each poller on its own interval and writes what they find to the log. */
export class Watcher {
  readonly status = new Map<string, SourceStatus>();
  private readonly options: WatcherOptions;
  private readonly clock: () => number;
  private stopped = false;
  private readonly wakers = new Set<() => void>();
  private loops: Promise<void>[] = [];

  constructor(options: WatcherOptions) {
    this.options = options;
    this.clock = options.clock ?? Date.now;
    for (const { name, interval } of options.pollers) this.status.set(name, { interval, baselined: options.state.source(name).baselined === true, failures: 0 });
  }

  start(): void {
    this.loops = this.options.pollers.map((poller) => this.loop(poller));
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
      status.failures++;
      status.lastError = error instanceof Error ? error.message : String(error);
      const refused = backoffIn(error);
      wait = refused ? Math.max(refused.until - this.clock(), 1_000) : Math.min(poller.interval * 2 ** status.failures, MAX_WAIT_MS);
      this.say(`${poller.name}: ${status.lastError} Next try in ${Math.round(wait / 1000)} s.`);
    }
    state.save();
    status.nextAt = new Date(this.clock() + wait).toISOString();
    return wait;
  }

  private async record(found: readonly Found[], baseline: boolean): Promise<WatchEvent[]> {
    const { log, context, onEvent } = this.options;
    const observedAt = new Date(this.clock()).toISOString();
    const seen = new Set<string>();
    const fresh = found.filter((row) => {
      const key = dedupeKey(row);
      if (seen.has(key) || log.has(row)) return false;
      seen.add(key);
      return true;
    });
    const quiet = fresh.filter((row) => baseline || row.baseline).map((row) => ({ ...row, baseline: true as const, observedAt }));
    const written = log.append(quiet);
    for (const row of fresh.filter((row) => !baseline && !row.baseline)) {
      const extra = context ? await context(row).catch((error: unknown) => ({ unread: [error instanceof Error ? error.message : String(error)] })) : {};
      const [event] = log.append([{ ...row, observedAt, context: extra }]);
      if (!event) continue;
      written.push(event);
      onEvent?.(event);
    }
    return written;
  }

  private say(message: string): void {
    (this.options.say ?? ((line: string) => console.error(line)))(message);
  }
}
