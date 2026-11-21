import { BaseError } from "viem";

/** USDC on Base, which pays both 0x and BrainChain. */
export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

export const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** An error's message, viem's short one where it has it: viem's full message can quote a node's URL. */
export const messageOf = (error: unknown): string => (error instanceof BaseError ? error.shortMessage : error instanceof Error ? error.message : String(error));

/** Items as a sentence lists them: "a", "a and b", "a, b and c". */
export const listOf = (items: string[]): string => (items.length < 3 ? items.join(" and ") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);
