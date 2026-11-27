# Check a trade against its mandate before signing

Check each trade an agent gets from 0x against its written mandate before the agent signs it. The agent buys a signed quote from 0x's keyless gateway for 0.01 USDC and pays BrainChain 0.25 USDC to grade it, both from the same wallet on Base. BrainChain's sandbox verifies 0x's signature on the quote and tests the transaction against each rule of the mandate. Two models then read the run, and BrainChain records the decision with a public page. The script prints the transactions to sign only when BrainChain accepts the trade. It never sends one.

This example is for anyone who runs an agent with a wallet: an owner who wants a record that every trade stayed inside its limits, or a framework that wants a gate in front of the signer. The sample mandate trades USDG, WETH and ETH on Robinhood Chain.

## Try it free

Node 22.18 or later runs the TypeScript as it is. Nothing here needs a key or pays anything.

```sh
cd examples/pretrade-check
npm ci
npm run check -- --sample
cp fixtures/mandate.json my-mandate.json    # then set your wallet, recipient and tokens in it
npm run check -- --dry --mandate my-mandate.json --sell USDG --buy WETH --amount 5 --slippage-bps 50
```

`--sample` runs the checks in Pyodide, the interpreter BrainChain's sandbox uses, on the six recorded quotes in [`fixtures/quotes`](fixtures/quotes) against the sample mandate. It exits 0 because it shows six expected verdicts, four of them refusals. With `--quote` it also asks BrainChain's grade route its price without paying.

`--dry` runs every free check and needs no key. It reads the mandate and the trade as a paid check would, then reads on chain each token's decimals and symbol, what the wallet holds of the sell token and of ETH for gas, and its USDC on Base. It checks the size of the checks and asks the grade route its price without paying. Then it runs the checks with your mandate on a quote recorded for the sample wallet, since a fresh quote costs 0.01 USDC. Rules about another wallet, chain or token fail on that quote, as they should. `--dry` takes all three of `--sell`, `--buy` and `--amount`, or none of them to check the mandate alone.

## Run a paid check

```sh
BRAINCHAIN_PAYER_KEY_FILE=~/.brainchain/payer.key \
  npm run check -- --mandate my-mandate.json --sell USDG --buy WETH --amount 5 --slippage-bps 50
```

A paid check reads the wallet's private key from the file `BRAINCHAIN_PAYER_KEY_FILE` names, which only its owner may read, and never prints it. The wallet needs the sell token and some ETH for gas on chain 4663, and USDC on Base to pay for the check.

A check costs 0.26 USDC from that wallet on Base. 0x takes 0.01 USDC for the quote, even when it refuses the request. BrainChain's desk, the service that takes payment for a grade and returns its verdict, takes 0.25 USDC whatever the verdict. A trade the inputs refuse costs nothing, and one the checks refuse on this machine costs only the quote.

| Flag | Meaning |
| --- | --- |
| `--mandate <file>` | The mandate. `--dry` and a paid check require it, and never fall back to the sample. |
| `--sell <token>` | A token the mandate lists and lets be sold, by symbol or address. |
| `--buy <token>` | A token the mandate lists, by symbol or address. |
| `--amount <n>` | How much to sell, in whole tokens, such as `5` or `0.5`, with no more decimals than the token has. |
| `--slippage-bps <n>` | 0x's slippage tolerance, at most the mandate's `maxSlippageBps`. Without it 0x uses 100, which must also be within the mandate. |
| `--dry` | Runs every free check and needs no key. |
| `--sample`, `--quote` | The recorded quotes, as in [Try it free](#try-it-free). |
| `-h`, `--help` | The usage. |

A paid check spends nothing on a trade it can refuse first. Before paying 0x, it:

- refuses a token the mandate does not list;
- refuses an amount over the token's `maxSell`;
- refuses a slippage over the mandate's `maxSlippageBps`;
- reads each token's `decimals()` and `symbol()` on chain, and refuses a mandate that says otherwise, naming its file;
- checks that the wallet holds the amount it sells;
- checks that the wallet holds ETH on the mandate's chain for the gas of the approval and the trade, at the node's current gas price;
- checks that the wallet holds at least 0.26 USDC on Base, and says how much is missing;
- checks that the checks fit the grade route;
- checks that the chain's node answers with the mandate's chain id.

Once the quote arrives, it:

- checks 0x's signature and the 60 seconds;
- refuses a quote 0x has no liquidity for;
- reads 0x's Settler registry at the quote's block;
- runs the checks itself, and pays BrainChain only if every rule passes.

The paid run prints the SHA-256 of the checks' template and of the mandate, which `verify` prints too. After the verdict it prints the trade and every rule line as BrainChain's run printed them, then the transactions to sign. It prints them only when BrainChain accepted the grade this run paid for and printed the same rule lines as the local run. When the wallet has not yet approved the sell token, the first is the approval, to AllowanceHolder for exactly the amount sold, and the second is the trade. Each is JSON with `to`, `data`, `value` and `chainId`, ready to sign. The trade's `gas` and `gasPrice` are 0x's estimates, and a wallet may set its own. A trade whose gas at 0x's price could cost more than 0.0001 ETH is not printed.

| Exit code | `npm run check` | `npm run verify` |
| --- | --- | --- |
| 0 | Accepted: the transactions to sign are printed. `--sample`, `--dry` and `--help` exit 0 too. | The record matches. |
| 1 | Malformed input, such as an amount of 0, the same token on both sides, more decimals than the token has, or an unknown flag; or a check that did not finish, such as for a wallet short of funds. | The record could not be checked, or its delivery is withheld. |
| 2 | The mandate refuses the trade, here or in BrainChain's grade: do not sign. | The record does not match, or is of the earlier form. |

| Variable | Meaning |
| --- | --- |
| `BRAINCHAIN_PAYER_KEY_FILE` | The file holding the paying wallet's private key, readable by its owner alone. A paid check requires it. The key is never printed. |
| `CHAIN_RPC` | A node for the mandate's chain, in place of the public one. Its URL is never printed. |
| `BASE_RPC` | A node for Base, where the wallet's USDC is read, in place of the public one. Its URL is never printed. |
| `BRAINCHAIN_DESK_URL` | BrainChain's desk, `https://brain.usebrainchain.com` by default. Another must be an https origin, or http on localhost or 127.0.0.1, and take payment at the same address on Base. |

Both payments are capped in the client: it signs at most 0.01 USDC to 0x's payee and 0.25 USDC to BrainChain's, on Base, as EIP-3009 transfer authorizations. The wallet needs no gas on Base. Once a payment is signed, every error says what may have been charged. When a payment processor turns a payment down because the wallet is short, the client says so, and that nothing was charged. When BrainChain's answer is lost or unclear, the client reads the grade by its id, which is free, and waits for its verdict. If no grade turns up, it prints where to read it and says not to run the check again, since that would pay again.

Every check is recorded on BrainChain with a public decision page. The brief and the checks are published at once, so the mandate, its wallet and its recipient are public from the first check. The delivery, with 0x's signed quote and the transaction, is published once BrainChain accepts the trade, which is before the agent signs it. A refused trade's record shows the mandate, the checks and the verdict, with the delivery withheld.

## What it checks

The mandate is a short JSON file. Each rule below prints one line in the run, pass or FAIL with the reason, and a trade passes only when every line does.

| Rule | Passes when |
| --- | --- |
| delivery | `DELIVERY` is a string of base64 that decodes to JSON with exactly the fields the checks read. |
| signature | 0x's key `0x-signing-key-prod-24092026` signed the response with Ed25519, over its status, its body's SHA-256 and the exact request: `GET api.0x.org/swap/allowance-holder/quote` with the query the agent sent. |
| fresh | The agent received the quote within 60 seconds of the time its signature names, by the agent's clock. |
| query | The request asks 0x for `chainId`, `sellToken`, `buyToken`, `sellAmount`, `taker` and optionally `slippageBps`, each once, in plain letters and digits. Any other parameter fails the rule by name. |
| chain | The quote is for the mandate's chain. |
| wallet | The quote is for the mandate's wallet, the one that signs the trade. |
| contract | The transaction calls AllowanceHolder (`0x0000000000001fF3684f28c67538d4D072C22734`), which lets the Settler that 0x's registry named at the quote's block take the sell amount for that one call. |
| tokens | The mandate lists both the token sold and the token bought. |
| size | The trade sells no more than the token's `maxSell`, and exactly the amount the agent asked for. |
| minimum out | The trade's guaranteed minimum is within the mandate's slippage of 0x's quoted amount. Settler reverts the trade if it would pay out less. |
| recipient | The bought tokens go to the mandate's recipient. |
| fees | The request names no fee or surplus recipient, and the quote's fee fields show no integrator fee. |
| deadline | The signature is dated no later than the mandate's `validUntil`. |

The checks read the trade from the calldata, the part the wallet signs: AllowanceHolder's `exec` call and the Settler `execute` call inside it, whose recipient, buy token and minimum Settler enforces on chain. The quote's own summary fields are compared with it and never trusted alone. The Settler's actions, the route itself, are covered by 0x's signature and not decoded. 0x's own fee and any surplus are paid inside them, and the recipient is guaranteed the minimum whatever they pay.

The grade has two levels: every rule passes, or one does not. A run that fails is refused at full confidence, whatever the models say. A run that passes is read by BrainChain's grading panel: Jev, the model BrainChain grades with, and other models. BrainChain accepts the trade when the panel's probability reaches its bar, 80% today.

## What it does not check or protect

- **Trades placed ahead of yours.** The accepted quote and its transaction are public from the moment BrainChain accepts the trade, before the agent signs it. Anyone can see the trade and try to trade ahead of it. The minimum out bounds what they can take, since the trade reverts rather than pay out less. Submit the transaction through a private RPC, and keep the slippage tight.
- **Whether the trade is a good one.** The mandate bounds the minimum out against 0x's own quote, so a poor price that 0x quotes still passes within the slippage. A price floor would need a market price, and the sandbox has no network.
- **The registry read and the time of receipt.** Before the grade, the agent reads `ownerOf(2)` and `prev(2)` on 0x's Settler registry (`0x00000000000004533Fe15556B1E086BB1A72cEae`) at the block 0x quoted at, and records when the quote arrived. On a chain with one Settler, `prev(2)` reverts and the previous Settler is recorded as the zero address, which never counts. The checks hold both to the signed quote but cannot repeat the read. Anyone can repeat it from the record, at that block.
- **Freshness at grading time.** 0x asks verifiers to reject a signature more than 60 seconds old. The checks give the same answer whenever they run, so anyone can run them again from the record, which rules out the grading clock. The agent's client enforces the 60 seconds when the quote arrives instead. If a verdict outlasts the quote, the transaction can revert; it cannot pay out less than the checked minimum.
- **A key 0x has rotated.** 0x's signing key is written into the checks and the client. When 0x rotates it, every quote is refused until both are updated from [0x's docs](https://docs.0x.org/docs/developer-resources/response-signatures).
- **The block's form, from inside the run.** The checks require a string and read only that, which stops a delivery that hands them an object of its own. Code that runs before them can still change the modules they import, so the form is confirmed from the record with `verify`.
- **A refused decision, after the fact.** BrainChain publishes the delivery only for work it accepts, so `verify` cannot run a refused decision again. It still confirms the refused decision's checks and mandate.
- **Other kinds of 0x trade.** Only AllowanceHolder quotes are read: no Permit2, gasless or cross-chain quotes. The checks were measured on Robinhood Chain.

## Verify a decision

An accepted decision means the published block passed the published checks in BrainChain's sandbox. The client sends that block as one string of data, `DELIVERY = "<base64>"`, so no code runs before the checks. `verify` confirms both from the public record:

```sh
npm run verify -- 1007 --mandate fixtures/mandate.json
```

It takes a decision id, as the paid run prints it, the decision's page (`https://usebrainchain.com/decision?id=1007`), a grade id, or a decision record's URL on BrainChain's desk, and the mandate file. A decision id is read from its `Recorded` event on BrainChain's chain, through the public node `npx brainchain-verify` uses. `verify` then reads the grade and its record, which is free, and prints one line per step:

```text
Decision 1007, grade 0x8549890944128f83646e02815d35d4eb7cf89eb6be9540fd96a0c21c961e0dfe: accepted at a pass probability of 98%, checks passed, from https://brain.usebrainchain.com/records/0xaeb1b45c40f14cecf15d3fec114cada277e69ff11d13033b032d6f112b79f905.json
  ok    grade: its verdict links this record, as decision 1007
  ok    record: its keccak256 is the hash it is published under
  ok    delivery: one line assigning DELIVERY a string of 7820 base64 characters, which runs no code
  ok    checks: an earlier wording of the same rules, kept in src/templates, template SHA-256 40e7241dc56a4a1a0ec76a2b45df444f53af77c934f73f2d194264731625b0b8
  ok    mandate: the checks carry the mandate in mandate.json, SHA-256 d7bd8c1e1170914cbbc95731957383ed07151d018a90419757d99245bf79b66c
  ok    rerun: passed here, printing exactly what BrainChain's run printed. Trade: sell 5 USDG for at least 0.003077845917344091 WETH (0x quoted 0.003093312479742805 WETH), paid to 0xd937e50ee21e66f7640f1a7887399e63055290fe, on chain 4663, quoted at block 119557541

Verdict: match. The published block is data and nothing else, the checks are an earlier wording of its rules with the mandate in mandate.json, and they pass here as they did on BrainChain.
To confirm the record on chain: npx brainchain-verify mainnet 1007
```

The grade's verdict must link the record, and the record must hash to its name. The delivery must be the result's only Python block, matching `DELIVERY = "[A-Za-z0-9+/]*={0,2}"` exactly. The checks must be byte for byte a template this version knows with the mandate written in: its own, or an earlier wording of the same rules kept in [`src/templates`](src/templates). Only then does `verify` run them, in Pyodide on your machine, and compare what they print with the record. It never runs a block of any other form. [`brainchain-verify`](https://docs.usebrainchain.com/verifying-decisions) then shows the record is the one the chain recorded.

Decisions 995 to 1002 were made with the earlier delivery, a Python dict. `verify` reports them as the earlier form and exits 2, since this version cannot vouch for a block that is not one string.

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
| `tokens` | The only tokens the agent may sell or buy, each with its own symbol and address. `maxSell` is the most one trade may sell, in whole tokens; `"0"` lets a token be bought but never sold. ETH is 0x's placeholder address. |
| `maxSlippageBps` | How far under 0x's quoted amount the guaranteed minimum may be, in basis points. |
| `validUntil` | The last moment 0x may have signed a quote under this mandate, in UTC, as a real date and time. |

Each token's `decimals` and `symbol` must be what the token's contract returns on chain, which `--dry` and every paid check read before anything is paid.

The checks read this JSON as it is written into them, and [`src/mandate.ts`](src/mandate.ts) refuses a mandate with a field they would not read, at any level, so a typo cannot drop a rule. Its errors name the file.

## The request

`pretradeCheck` in [`src/request.ts`](src/request.ts) builds the grade route's request:

- `brief`: what the check is, the mandate in plain sentences for the models, and the instruction to judge the trade by the checks' run against the mandate alone, never by its price or timing.
- `result`: one Python block, `DELIVERY = "<base64>"`. Decoded, it is JSON: 0x's response byte for byte with its signature headers, the request the signature covers, when the agent received it and the registry read.
- `checks`: [`src/checks.py`](src/checks.py) after a line holding the mandate, sent in the request's `checks` field. Without the mandate, this is the template whose SHA-256 the paid run and `verify` print.
- `levels` and `pass`: the two levels above, with only the first passing.

A delivery is about 8,000 characters and the checks are about 20,000, inside the route's 32,000 for checks and the sandbox's 64,000 for both together.

## Measured

Thirteen checks of ours were run through the grade route on 2026-11-21, each paid for: 0.25 USDC to BrainChain per grade and 0.01 USDC to 0x for each quote bought, all on Base. Every quote was bought through 0x's gateway minutes before it was graded. The requests, the full replies and what the checks printed are in [`measured.json`](measured.json), six of the earlier deliveries in [`fixtures/quotes`](fixtures/quotes), and four records in [`fixtures/records`](fixtures/records).

This version's delivery, one base64 string, through `npm run check` and a tampered copy of a quote:

| Case | Trade | Expected | Verdict | Jev | Second model | Verdict in | Record |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Command line | Sell 5 USDG for WETH at 50 bps slippage | Accepted | Accepted, 98% | 98% | 100% | 8.8 s | [1004](https://usebrainchain.com/decision?id=1004) |
| Command line | The same trade again, with the run's rule lines and the approval printed | Accepted | Accepted, 98% | 98% | 100% | 40.1 s | [1007](https://usebrainchain.com/decision?id=1007) |
| At the maximum | The same trade at 100 bps slippage, the mandate's maximum | Accepted | Accepted, 98% | 98% | 100% | 7.4 s | [1017](https://usebrainchain.com/decision?id=1017) |
| Tampered | 1004's quote with one byte of its route changed and its body digest recomputed, sent without the client's own checks, which refuse it | Refused on signature | Refused on signature | 0% | 0% | 5.9 s | [1005](https://usebrainchain.com/decision?id=1005) |

Decision [1003](https://usebrainchain.com/decision?id=1003), the same trade as 1004, passed every rule and was refused at 55% by Jev under an earlier wording of the levels.

The earlier delivery, a Python dict, with twelve rules:

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

*Jev* and *Second model* are each one's probability that the trade passes. *Verdict in* runs from the paid request to the verdict. These runs were measured when the lower of Jev's and the second model's probability decided a grade; the grading panel's probability decides today.

Every trade inside the mandate was accepted, from 89% to 98% from Jev and 100% from the second model, except 1003 above. Every trade that broke it was refused at full confidence by the checks, on the one rule it broke. The tampered quotes kept every rule of the mandate, so only 0x's signature caught the change. Today the client refuses the outside, minimum and size trades itself, before paying 0x, and the tampered ones after buying the quote, before paying BrainChain.

The probe ran the same checks with a few lines in front, which printed Python 3.14.2 on Pyodide (wasm32), no `fetch` or `WebSocket` in reach, both `urlopen` and `pyfetch` failing, and 3.2 seconds for the whole run of the checks.

## Tests

`npm test` runs without paying anything or reaching the network. It runs this version's checks in Pyodide 314.0.7, the version BrainChain's sandbox runs, on the six recorded quotes: the inside and native trades pass every rule, and the outside, minimum, size and tampered trades each fail on their one rule. The inside quote is then changed to break each other rule in turn, the delivery is changed in every way the checks must refuse, and two known bypasses are run: a dict subclass, which the checks refuse, and a patched `hashlib`, which `verify` refuses. The client's query parser is held to the checks' on the same queries.

`verify` is tested on the four recorded records, 996, 997, 1004 and 1005, reached by decision id, page, grade id and URL, and on records built from the recorded quotes with each kind of mismatch. The rest covers the mandate parser, the token and balance reads, the request's limits, the arrival check, the Settler registry read, both payment clients and every answer BrainChain can give a paid request, the rules for trusting a verdict, the dry run, and the command line's exit codes, all against stubs.
