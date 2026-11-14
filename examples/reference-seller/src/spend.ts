import { readJson, writeJson } from "./files.ts";

/** What grades cost in a UTC day, kept on disk so a restart does not reset it. */
export function createSpend(file: string, daily: bigint) {
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work);
    queue = next.catch(() => undefined);
    return next;
  };
  const today = () => new Date().toISOString().slice(0, 10);
  const spent = async () => {
    const saved = await readJson<{ day: string; units: string }>(file);
    return saved?.day === today() ? BigInt(saved.units) : 0n;
  };
  const save = (units: bigint) => writeJson(file, { day: today(), units: units.toString() });

  return {
    /** Counts `units` against today before anything is signed. Returns what today already holds when that would pass the cap. */
    take: (units: bigint) =>
      serial(async () => {
        const before = await spent();
        if (before + units > daily) return before;
        await save(before + units);
        return undefined;
      }),
    /** Gives back a payment that was never charged. */
    give: (units: bigint) =>
      serial(async () => {
        const before = await spent();
        await save(before > units ? before - units : 0n);
      }),
  };
}
