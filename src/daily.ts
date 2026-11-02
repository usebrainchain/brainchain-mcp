// The daily limit is kept on disk, so restarting the server, or a second server
// paying from the same wallet, does not reset what the wallet may spend today.
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 5_000;

export interface Reservation {
  day: string;
  amount: bigint;
}

export interface DailyLedger {
  /** Reserves `amount` against today's limit, or returns undefined when it would pass it. */
  reserve(amount: bigint): Promise<Reservation | undefined>;
  /** Returns a reservation that was never charged; one from an earlier day is already spent. */
  release(reservation: Reservation): Promise<void>;
  spentToday(): Promise<bigint>;
}

/** The UTC date, which is when the limit resets. */
export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function dailyLedger(path: string, limit: bigint, now: () => number = Date.now): DailyLedger {
  const lockPath = `${path}.lock`;

  async function locked<T>(work: () => Promise<T>): Promise<T> {
    await mkdir(dirname(path), { recursive: true });
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        await (await open(lockPath, "wx")).close();
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        // A lock left by a process that died mid-write.
        const age = await stat(lockPath).then((s) => Date.now() - s.mtimeMs, () => 0);
        if (age > LOCK_STALE_MS) await rm(lockPath, { force: true });
        else if (Date.now() > deadline) throw new Error(`The daily spending record at ${path} is locked by another process; try again`);
        else await new Promise((r) => setTimeout(r, 50));
      }
    }
    try {
      return await work();
    } finally {
      await rm(lockPath, { force: true });
    }
  }

  async function read(): Promise<bigint> {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0n;
      throw error;
    }
    // An unreadable record must not reset the limit to zero.
    const record = (() => {
      try {
        return JSON.parse(raw) as { day?: unknown; units?: unknown };
      } catch {
        return undefined;
      }
    })();
    if (typeof record?.day !== "string" || typeof record.units !== "string" || !/^\d+$/.test(record.units)) {
      throw new Error(`The daily spending record at ${path} cannot be read; fix or delete it to pay again`);
    }
    return record.day === utcDay(now()) ? BigInt(record.units) : 0n;
  }

  async function write(units: bigint): Promise<void> {
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({ day: utcDay(now()), units: units.toString() }), { mode: 0o600 });
    await rename(temporary, path);
  }

  return {
    reserve: (amount) =>
      locked(async () => {
        const spent = await read();
        if (spent + amount > limit) return undefined;
        await write(spent + amount);
        return { day: utcDay(now()), amount };
      }),
    release: (reservation) =>
      locked(async () => {
        if (reservation.day !== utcDay(now())) return;
        const spent = await read();
        await write(spent > reservation.amount ? spent - reservation.amount : 0n);
      }),
    spentToday: () => locked(read),
  };
}
