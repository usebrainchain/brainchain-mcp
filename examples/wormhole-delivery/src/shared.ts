import { BaseError } from "viem";

/** USDC on Base, which pays BrainChain. */
export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

export const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** An error's message, viem's short one where it has it. */
export const messageOf = (error: unknown): string => (error instanceof BaseError ? error.shortMessage : error instanceof Error ? error.message : String(error));
