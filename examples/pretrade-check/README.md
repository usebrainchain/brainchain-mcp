# Check a trade against its mandate before signing

An agent that trades through 0x can now have each trade checked against its written mandate before it signs. The agent buys a signed quote from 0x's keyless gateway for 0.01 USDC and pays BrainChain 0.25 USDC to grade it, both from the same wallet on Base. BrainChain's sandbox verifies 0x's signature on the quote and tests the transaction against each rule of the mandate. Two models then read the run, and BrainChain records the decision with a public page. The script prints the transaction to sign only when BrainChain accepts the trade. It never sends one.

This example is for anyone who runs an agent with a wallet: an owner who wants a record that every trade stayed inside its limits, or a framework that wants a gate in front of the signer. The sample mandate trades USDG, WETH and ETH on Robinhood Chain.

## What it checks

The mandate is a short JSON file. Each rule below prints one line in the run, pass or FAIL with the reason, and a trade passes only when every line does.

| Rule | Passes when |
| --- | --- |
| delivery | The delivery's code only assigns `DELIVERY`, with every field the checks read. |
| signature | 0x's key `0x-signing-key-prod-24092026` signed the response with Ed25519, over its status, its body's SHA-256 and the exact request: `GET api.0x.org/swap/allowance-holder/quote` with the query the agent sent. |
| fresh | The agent received the quote within 60 seconds of the time its signature names, by the agent's clock. |
| chain | The quote is for the mandate's chain. |
| wallet | The quote is for the mandate's wallet, the one that signs the trade. |
| contract | The transaction calls AllowanceHolder (`0x0000000000001fF3684f28c67538d4D072C22734`), which lets the Settler that 0x's registry named at the quote's block take the sell amount for that one call. |
| tokens | The mandate lists both the token sold and the token bought. |
| size | The trade sells no more of the token than the mandate allows, and exactly the amount the agent asked for. |
| minimum out | The trade's guaranteed minimum is within the mandate's slippage of 0x's quoted amount. Settler reverts the trade if it would pay out less. |
| recipient | The bought tokens go to the mandate's recipient. |
| fees | The quote pays no fee to anyone but 0x. |
| deadline | The signature is dated no later than the mandate's `validUntil`. |

The checks read the trade from the calldata, the part the wallet signs: AllowanceHolder's `exec` call and the Settler `execute` call inside it, whose recipient, buy token and minimum Settler enforces on chain. The quote's own summary fields are compared with it and never trusted alone.

The grade has two levels: every rule passes, or one does not. A run that fails is refused at full confidence, whatever the models say. A run that passes is read by Jev and a second model, and BrainChain accepts the trade when the lower of their two probabilities reaches its bar, 80% today.

## What it cannot check

- **Whether the trade is a good one.** The mandate bounds the minimum out against 0x's own quote, so a poor price that 0x quotes still passes within the slippage. A price floor would need a market price, and the sandbox has no network.
- **The registry read and the time of receipt.** Before the grade, the agent reads `ownerOf(2)` and `prev(2)` on 0x's Settler registry (`0x00000000000004533Fe15556B1E086BB1A72cEae`) at the block 0x quoted at, and records when the quote arrived. The checks hold both to the signed quote but cannot repeat the read. Anyone can repeat it from the record, at that block.
- **Freshness at grading time.** 0x asks verifiers to reject a signature more than 60 seconds old. The checks give the same answer whenever they run, so anyone can run them again from the record, which rules out the grading clock. The agent's client enforces the 60 seconds when the quote arrives instead. If a verdict outlasts the quote, the transaction can revert; it cannot pay out less than the checked minimum.
- **A key 0x has rotated.** 0x's signing key is written into the checks and the client. When 0x rotates it, every quote is refused until both are updated from [0x's docs](https://docs.0x.org/docs/developer-resources/response-signatures).
- **Delivery code that tries to mislead the checks.** The delivery runs first, in the same interpreter. The checks refuse a delivery that defines anything but `DELIVERY`, test their own Ed25519 verifier against RFC 8032's first test vector before using it, and an accepted trade's delivery is published in its record for anyone to read.
- **Other kinds of 0x trade.** Only AllowanceHolder quotes are read: no Permit2, gasless or cross-chain quotes. The checks were measured on Robinhood Chain.

## Run it

Node 22.18 or later runs the TypeScript as it is.

```sh
cd examples/pretrade-check
npm ci
npm run check -- --sample            # the recorded quotes, checked here as the sandbox checks them
npm run check -- --sample --quote    # also ask the grade route for its price, without paying
BRAINCHAIN_PAYER_KEY_FILE=~/.brainchain/agent.key \
  npm run check -- --sell USDG --buy WETH --amount 5 --slippage-bps 50 --mandate my-mandate.json
```

`--sample` needs no wallet and pays nothing. It runs the checks in Pyodide, the interpreter BrainChain's sandbox uses, on the six deliveries from the measurement below, one of them tampered.

A live check reads the wallet's key from `BRAINCHAIN_PAYER_KEY_FILE` and never prints it. It buys the quote, checks 0x's signature and the 60 seconds on arrival, reads the registry at the quote's block, pays for the grade and prints the verdict with its decision page. For an accepted trade it then prints the approval the wallet still needs, if any, and the transaction to sign, and exits 0. For a refused trade it prints the rules that failed and exits 2. `--sell` takes a token the mandate lists; `--buy` takes a listed token or any address, so that a trade outside the list reaches the checks and is refused there. `CHAIN_RPC` replaces the public node the registry is read from.

Both payments are capped in the client: it signs at most 0.01 USDC to 0x's payee and 0.25 USDC to BrainChain's, on Base, as EIP-3009 transfer authorizations. The wallet needs USDC on Base and no gas there.

## The mandate

```json
{
  "chain": 4663,
  "wallet": "0xd937E50Ee21E66f7640F1a7887399e63055290fe",
  "recipient": "0xd937E50Ee21E66f7640F1a7887399e63055290fe",
  "tokens": [
    { "symbol": "USDG", "address": "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", "decimals": 6, "maxSell": "25" },
    { "symbol": "WETH", "address": "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", "decimals": 18, "maxSell": "0.01" },
    { "symbol": "ETH", "address": "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", "decimals": 18, "maxSell": "0.01" }
  ],
  "maxSlippageBps": 100,
  "validUntil": "2026-12-31T23:59:59Z"
}
```

| Field | Meaning |
| --- | --- |
| `chain` | The chain the agent trades on. |
| `wallet` | The wallet that signs the trade, 0x's `taker`. |
| `recipient` | Where the bought tokens must go. |
| `tokens` | The only tokens the agent may sell or buy. `maxSell` is the most one trade may sell, in whole tokens; `"0"` lets a token be bought but never sold. ETH is 0x's placeholder address. |
| `maxSlippageBps` | How far under 0x's quoted amount the guaranteed minimum may be, in basis points. |
| `validUntil` | The last moment 0x may have signed a quote under this mandate, in UTC. |

The checks read this JSON as it is written into them, and [`src/mandate.ts`](src/mandate.ts) refuses a mandate with a field they would not read, so a typo cannot drop a rule.

## The request

`pretradeCheck` in [`src/request.ts`](src/request.ts) builds the grade route's request:

- `brief`: what the check is, the mandate in plain sentences for the models, and the instruction to judge the trade by the mandate alone, never by its price or timing.
- `result`: one Python block that assigns `DELIVERY`: 0x's response byte for byte with its signature headers, the request the signature covers, when the agent received it and the registry read.
- `checks`: [`src/checks.py`](src/checks.py), Python with the mandate written in, sent in the request's `checks` field.
- `levels` and `pass`: the two levels above, with only the first passing.

A delivery is about 6 KB and the checks are about 17,000 characters, inside the route's 32,000 for checks and the sandbox's 64,000 for both together.

## What a check costs

0.01 USDC to 0x for the quote, which 0x charges even when it refuses the request, and 0.25 USDC to BrainChain whatever the verdict. A trade checked once costs 0.26 USDC, from the trading wallet on Base.

## What is public

Every check is recorded on BrainChain with a public decision page. The brief and the checks are published at once, so the mandate, its wallet and its recipient are public from the first check. The delivery, with 0x's signed quote and the transaction, is published once BrainChain accepts the trade, which is before the agent signs it. A refused trade's record shows the mandate, the checks and the verdict, with the delivery withheld.

## Measured

On 2026-11-21 we ran eight checks through the grade route and paid for each: 0.25 USDC to BrainChain per grade and 0.01 USDC to 0x for each of seven quotes, all on Base, 2.07 USDC in all. Every quote was bought through 0x's gateway minutes before it was graded. The requests, the full replies and what the checks printed are in [`measured.json`](measured.json), and each delivery is in [`fixtures/quotes`](fixtures/quotes).

| Case | Trade | Expected | Verdict | Jev | Second model | Verdict in | Record |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Probe | Sell 5 USDG for WETH, with a probe of the sandbox in front of the checks | Accepted | Accepted, 96% | 96% | 100% | 42.3 s | [995](https://usebrainchain.com/decision?id=995) |
| Inside | Sell 5 USDG for WETH at 50 bps slippage | Accepted | Accepted, 90% | 90% | 100% | 6.6 s | [996](https://usebrainchain.com/decision?id=996) |
| Native | Sell 0.001 ETH for USDG at 50 bps slippage | Accepted | Accepted, 89% | 89% | 100% | 6.5 s | [1000](https://usebrainchain.com/decision?id=1000) |
| Command line | The inside trade again, through `npm run check` | Accepted | Accepted, 95% | 95% | 100% | 7.0 s | [1002](https://usebrainchain.com/decision?id=1002) |
| Outside | Sell 5 USDG for BRAIN, which the mandate does not list | Refused on tokens | Refused on tokens | 0% | 0% | 14.6 s | [997](https://usebrainchain.com/decision?id=997) |
| Minimum | Sell 5 USDG for WETH at 300 bps slippage, over the mandate's 100 | Refused on minimum out | Refused on minimum out | 0% | 2% | 21.1 s | [998](https://usebrainchain.com/decision?id=998) |
| Size | Sell 30 USDG for WETH, over the mandate's 25 | Refused on size | Refused on size | 0% | 1% | 9.0 s | [1001](https://usebrainchain.com/decision?id=1001) |
| Tampered | The inside quote with one byte of its route changed and its body digest recomputed | Refused on signature | Refused on signature | 0% | 1% | 25.4 s | [999](https://usebrainchain.com/decision?id=999) |

*Jev* and *Second model* are each one's probability that the trade passes. *Verdict in* runs from the paid request to the verdict. On the command line, buying the quote and reading the registry added about 8 seconds, for 14.9 seconds in all.

Every trade inside the mandate was accepted, at 89% to 96% from Jev and 100% from the second model. Every trade that broke it was refused at full confidence by the checks, on the one rule it broke. The tampered quote kept every rule of the mandate, so only 0x's signature caught the change.

The probe ran the same checks with a few lines in front, which printed Python 3.14.2 on Pyodide (wasm32), no `fetch` or `WebSocket` in reach, both `urlopen` and `pyfetch` failing, and 3.2 seconds for the whole run of the checks. The checks were tidied after the measurement without changing a rule, and `npm test` gets the same result from them on every recorded quote.

To measure again, which costs 0.26 USDC a case and 0.25 for the tampered one, since it reuses the inside quote:

```sh
BRAINCHAIN_PAYER_KEY_FILE=... npm run measure -- inside outside minimum tampered
```

## Tests

`npm test` runs the checks in Pyodide 314.0.7, the version BrainChain's sandbox runs, on the recorded quotes: the six trades above, then each one changed to break one more rule in turn. It also covers the mandate parser, the request's limits, the signature check on arrival and both payment clients against stubs. No test pays.
