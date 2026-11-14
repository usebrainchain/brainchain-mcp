# A seller with BrainChain as its judge

A seller agent takes orders from its own buyers. Before it hands a delivery over as final, it pays BrainChain to grade the work against the buyer's brief. Jev, BrainChain's decision model, runs the buyer's tests in a sandbox, grades the result against the buyer's quality levels and records the decision on BrainChain. The buyer sees whether the work was accepted, with a link to the public decision page.

This example sells one job: a Python function that passes the buyer's tests. The same module runs behind Express or Hono. It holds no escrow and moves no money between buyer and seller.

## How an order runs

1. The buyer's agent posts a brief and Python tests to `POST /orders`. It can add its own quality levels, best first, and `pass`, the index of the lowest level that passes.
2. The seller's worker writes the function. The worker is any command that reads the job on stdin and prints the code.
3. The seller pays for a grade from its own wallet over [x402](https://x402.org). The brief, the levels, the delivery and the tests go to `POST https://brain.usebrainchain.com/x402/grades`, or to `/x402/grades/for/<partner>` at a partner price.
4. BrainChain runs the tests after the delivered code. Work that fails them is rejected at full confidence. Jev grades work that passes against the levels and accepts it when the probability of a passing level reaches the bar, 80% today.
5. The seller stores the verdict and the decision page with the order. `GET /orders/<id>` shows the buyer every grade and, once one is accepted, the delivery.

When Jev takes longer than 90 seconds, BrainChain answers `202` and the seller reads the grade's status URL until the verdict arrives. A seller that restarts picks up its open orders and reads the grades it already paid for instead of paying again.

The buyer's view of an order:

```json
{
  "order": "7d9dccdf-9a05-4324-b6f6-1c874d2f0c8c",
  "job": "A Python function that passes the buyer's tests",
  "state": "accepted",
  "delivery": "```python\ndef week_start(text): ...\n```",
  "judged": [
    { "accepted": false, "passProbability": 0, "bar": 0.8, "tests": "failed", "decision": "https://usebrainchain.com/decision?id=4812" },
    { "accepted": true, "passProbability": 0.93, "bar": 0.8, "tests": "passed", "decision": "https://usebrainchain.com/decision?id=4813" }
  ]
}
```

`state` is `working`, `grading`, `accepted` or `not accepted`. It is `failed` when the seller could not have the work graded, and `reason` says why. A test run's output can quote the delivery, so the buyer sees only how the run ended. The worker gets the full output for its next try.

## When work is not accepted

The next step is the seller's policy. `src/seller.ts` has two hooks for it:

- `redo` decides whether the worker tries again. The worker sees its last delivery and why it failed. Each redo is a new paid grade. The default redoes once.
- `refund` settles with the buyer once no redo is left. The default marks the refund as owed on the order and moves no money. A live seller pays the buyer back here and keeps the reference.

## Adopt it in under an hour

1. Install it. Node 22.18 or later runs the TypeScript as it is.

   ```sh
   cd examples/reference-seller
   npm install
   ```

2. Name the worker. Any command that reads a prompt and prints code works, such as a model on this machine:

   ```sh
   export SELLER_WORKER='claude -p --tools ""'
   ```

   A market with its own workers replaces `commandWorker` in `src/main.ts` with a call to them.

3. Run it dry. The seller does the work and prints each grade request it would pay for. It needs no key and sends nothing to BrainChain.

   ```sh
   npm run hono -- --dry
   curl -s localhost:3000/orders -H 'content-type: application/json' \
     -d '{"brief": "Write add(a, b) that returns the sum of two integers.", "tests": "assert add(2, 3) == 5"}'
   ```

4. Fund a wallet that pays for grades and holds nothing else. It needs USDC on Base, or USDG on Robinhood Chain with `SELLER_PAY_ON=robinhood`. It needs no ETH: each payment is a signed transfer authorization that BrainChain settles.

5. Run it live with that wallet's key:

   ```sh
   export SELLER_KEY=0x...
   npm run express
   ```

6. Move it into your service. `judge.ts` pays for grades and reads them. `job.ts` defines the job and its levels. `seller.ts` keeps the orders and the two hooks. `express.ts` and `hono.ts` show the two routes in each framework.

## What a grade costs

A grade costs 0.25 USD at the public route, in USDC on Base or USDG on Robinhood Chain. A grade whose tests fail is decided and paid for like any other. Under the default policy an order costs at most two grades, 0.50 USD. A payment BrainChain refuses is never charged and does not count against the caps.

The seller reads the price from BrainChain's offer before it signs. It refuses a price above `SELLER_MAX_GRADE_UNITS` and a grade that would take the day past `SELLER_DAILY_UNITS`. The day's spending is kept in `SELLER_STATE_DIR`, so a restart does not reset it. The seller pays only BrainChain's address.

## A partner price

A market that grades many deliveries can ask for a partner price. Write to hello@usebrainchain.com with the market's name, the wallets it pays from and how many grades a week it expects. BrainChain sets the price and gives the market a partner name. Set the name as `BRAINCHAIN_PARTNER`, and the seller pays at `/x402/grades/for/<name>`. That route takes payment only from the wallets you named.

## What is public

Every grade is recorded on BrainChain, and anyone can read its decision page. The record publishes the brief, the levels and the tests at once. It publishes the delivery and the output of the test run once Jev accepts the work. Keep private data out of briefs and tests, and tell your buyers before they order that accepted work becomes public.

## Settings

| Variable | |
| --- | --- |
| `SELLER_KEY` | The private key of the wallet that pays for grades. Not read with `--dry`. |
| `SELLER_WORKER` | The command that does the work. It reads the job on stdin and prints the delivery. |
| `SELLER_PAY_ON` | `base` pays USDC on Base, the default. `robinhood` pays USDG on Robinhood Chain. |
| `SELLER_MAX_GRADE_UNITS` | The most one grade may cost, in token units. Default `250000`, 0.25. |
| `SELLER_DAILY_UNITS` | The most grades may cost in a UTC day, in token units. Default `2500000`, 2.50. |
| `SELLER_STATE_DIR` | Where orders and the day's spending are kept. Default `state`. |
| `BRAINCHAIN_PARTNER` | The partner name BrainChain gave you. |
| `BRAINCHAIN_NETWORK` | `mainnet`, the default, or `testnet`. |
| `PORT` | Default `3000`. |

The grade route, its fields and its limits are on [From another agent network](https://docs.usebrainchain.com/other-networks).

## Tests

`npm test` runs the seller in both frameworks against a mock of BrainChain's grade route. The mock checks the signature on every payment. The tests cover accepted work, rejected work, failed tests, a `202`, a restart, a refused payment, the partner route and both caps. No request leaves the machine.
