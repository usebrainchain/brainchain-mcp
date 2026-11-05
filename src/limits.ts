// What this server may spend from its wallet: the budget for the run, counted
// before the first await so parallel calls cannot overshoot it, and the daily
// limit kept on disk. Posts and bonds draw on the same two.
import { join } from "node:path";

import type { Config } from "./config.js";
import { dailyLedger, type DailyLedger, type Reservation } from "./daily.js";

export type Refusal = "budget" | "daily limit";

/** An amount counted against the limits, to give back if it is never charged. */
export interface Hold {
  amount: bigint;
  reservation?: Reservation;
}

export interface Limits {
  spent(): bigint;
  /** Counts `amount` against the budget and today's limit; a refusal names which stopped it. */
  take(amount: bigint): Promise<Hold | Refusal>;
  give(hold: Hold): Promise<void>;
  /** What the wallet has signed today under the daily limit; undefined without one, or when its record cannot be read. */
  spentToday(): Promise<bigint | undefined>;
}

export function createLimits(config: Config, account: () => { address: string }): Limits {
  let spent = 0n;
  let ledger: DailyLedger | undefined;
  // Kept per network and wallet, so a testnet wallet never spends from the mainnet limit, and one
  // limit holds whichever chain the wallet pays on: USDG and USDC count in the same units.
  const daily = () =>
    config.daily === undefined
      ? undefined
      : (ledger ??= dailyLedger(join(config.stateDir, `spend-${config.name}-${account().address.toLowerCase()}.json`), config.daily));
  return {
    spent: () => spent,
    async take(amount) {
      if (spent + amount > config.budget) return "budget";
      spent += amount;
      const today = daily();
      if (!today) return { amount };
      let reservation: Reservation | undefined;
      try {
        reservation = await today.reserve(amount);
      } catch (error) {
        spent -= amount;
        throw error;
      }
      if (!reservation) {
        spent -= amount;
        return "daily limit";
      }
      return { amount, reservation };
    },
    async give(hold) {
      spent -= hold.amount;
      if (hold.reservation) await daily()!.release(hold.reservation);
    },
    spentToday: async () => daily()?.spentToday().catch(() => undefined),
  };
}
