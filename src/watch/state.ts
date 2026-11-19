import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
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

/** The state folder, made if missing, held by this process alone. Returns the release. */
export function lockStateDir(dir: string, pid = process.pid): () => void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, "watch.lock");
  const take = () => {
    const fd = openSync(lock, "wx");
    writeSync(fd, String(pid));
    closeSync(fd);
  };
  try {
    take();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const holder = Number(readFileSync(lock, "utf8"));
    if (holder > 0 && alive(holder)) throw new Error(`Another watcher (process ${holder}) is using ${dir}. Stop it, or pass another --state.`);
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
