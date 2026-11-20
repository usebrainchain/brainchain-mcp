import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

import type { Validators } from "./http.js";

export interface SourceState {
  /** Set once the source's first full read is recorded as the baseline. */
  baselined?: boolean;
  [key: string]: unknown;
}

export interface WatchState {
  startedAt: string;
  sources: Record<string, SourceState>;
  validators: Record<string, Validators>;
}

/** The watcher's state beside its log: where each source stopped, and the validators of the documents it last read. */
export class StateFile {
  readonly path: string;
  readonly state: WatchState;

  constructor(dir: string, now = new Date()) {
    this.path = join(dir, "state.json");
    this.state = existsSync(this.path) ? (JSON.parse(readFileSync(this.path, "utf8")) as WatchState) : { startedAt: now.toISOString(), sources: {}, validators: {} };
  }

  source(name: string): SourceState {
    return (this.state.sources[name] ??= {});
  }

  /** Written to a file beside it and renamed over it, so a crash leaves the old state or the new one, never half of one. */
  save(): void {
    const next = `${this.path}.next`;
    writeFileSync(next, `${JSON.stringify(this.state)}\n`);
    renameSync(next, this.path);
  }
}

/**
 * The state folder, made if missing, held by this process alone. Returns the release. A lock is stale when its process is
 * gone, when it names this process's own id, as after a container restarts with the same id, or when it was taken on
 * another host, as a container's disk is after a redeploy.
 */
export function lockStateDir(dir: string, pid = process.pid, host = hostname(), holder = { file: "watch.lock", busy: (owner: number, dir: string) => `Another watcher (process ${owner}) is using ${dir}. Stop it, or pass another --state.` }): () => void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, holder.file);
  const take = () => {
    const fd = openSync(lock, "wx");
    writeSync(fd, `${pid} ${host}`);
    closeSync(fd);
  };
  try {
    take();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const [held, on] = readFileSync(lock, "utf8").trim().split(" ");
    const owner = Number(held);
    if (owner > 0 && owner !== pid && (on === undefined || on === host) && alive(owner)) throw new Error(holder.busy(owner, dir));
    unlinkSync(lock);
    take();
  }
  return () => {
    try {
      unlinkSync(lock);
    } catch {
      // Already gone: nothing holds the folder.
    }
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
