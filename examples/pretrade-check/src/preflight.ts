// What can be read for free before anything is paid: the mandate's tokens as the chain has them, and whether the
// wallet can pay for a check.
import { basename } from "node:path";

import { erc20Abi, formatUnits, type Address, type PublicClient } from "viem";

import type { Mandate } from "./mandate.ts";
import { messageOf, same, USDC_BASE } from "./shared.ts";

/** 0x's placeholder for a chain's native token, which has no contract to read. */
const NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
/** One check in USDC's units: 0.01 to 0x and 0.25 to BrainChain. */
export const CHECK_COST = 260_000n;

/** Each token's decimals and symbol as the chain has them, refused where the mandate says otherwise. */
export async function checkTokens(mandate: Mandate, client: PublicClient, file: string): Promise<string[]> {
  const name = basename(file);
  return Promise.all(
    mandate.tokens.map(async (token) => {
      if (same(token.address, NATIVE)) {
        if (token.decimals !== 18) throw new Error(`The mandate ${name} gives ${token.symbol}, the chain's native token, ${token.decimals} decimals; it has 18.`);
        return `${token.symbol}, the native token, 18 decimals`;
      }
      const read = <F extends "decimals" | "symbol">(functionName: F) =>
        client.readContract({ address: token.address, abi: erc20Abi, functionName }).catch((error: unknown) => {
          throw new Error(`The mandate ${name} lists ${token.symbol} at ${token.address}, which answers no ${functionName}() on chain ${mandate.chain}: ${messageOf(error)}`, { cause: error });
        });
      const [decimals, symbol] = await Promise.all([read("decimals"), read("symbol")]);
      if (decimals !== token.decimals) throw new Error(`The mandate ${name} gives ${token.symbol} ${token.decimals} decimals; the token at ${token.address} on chain ${mandate.chain} has ${decimals}.`);
      if (symbol !== token.symbol) throw new Error(`The mandate ${name} calls the token at ${token.address} ${token.symbol}; on chain ${mandate.chain} it is ${symbol}.`);
      return `${symbol}, ${decimals} decimals`;
    }),
  );
}

/** Whether the wallet's USDC on Base covers one check, said with what is missing when it does not. */
export async function checkFunds(wallet: Address, base: PublicClient): Promise<string> {
  const held = await base.readContract({ address: USDC_BASE, abi: erc20Abi, functionName: "balanceOf", args: [wallet] }).catch((error: unknown) => {
    throw new Error(`The wallet's USDC on Base could not be read: ${messageOf(error)}`, { cause: error });
  });
  if (held < CHECK_COST) {
    throw new Error(`The wallet ${wallet} holds ${formatUnits(held, 6)} USDC on Base, and a check takes 0.26: 0.01 to 0x and 0.25 to BrainChain. Add ${formatUnits(CHECK_COST - held, 6)} USDC on Base. Nothing was paid.`);
  }
  return `${formatUnits(held, 6)} USDC on Base, enough for ${held / CHECK_COST} ${held / CHECK_COST === 1n ? "check" : "checks"}`;
}

/** Whether the wallet holds what the trade sells, so a quote is never bought for a trade that would revert. */
export async function checkHolding(mandate: Mandate, sell: Mandate["tokens"][number], amount: bigint, wallet: Address, client: PublicClient): Promise<string> {
  const read = same(sell.address, NATIVE) ? client.getBalance({ address: wallet }) : client.readContract({ address: sell.address, abi: erc20Abi, functionName: "balanceOf", args: [wallet] });
  const held = await read.catch((error: unknown) => {
    throw new Error(`The wallet's ${sell.symbol} could not be read on chain ${mandate.chain}: ${messageOf(error)}`, { cause: error });
  });
  const shown = (units: bigint) => `${formatUnits(units, sell.decimals)} ${sell.symbol}`;
  if (held < amount) throw new Error(`The wallet ${wallet} holds ${shown(held)} on chain ${mandate.chain}, and the trade sells ${shown(amount)}. Nothing was paid.`);
  return `${shown(held)} on chain ${mandate.chain}, enough to sell ${shown(amount)}`;
}
