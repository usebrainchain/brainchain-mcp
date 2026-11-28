# Use a paid delivery only when it is the work you asked for

An agent that pays for a resource over x402 can use what it bought, or release the funds it holds for it, only when two things are true. [Agent Wormhole](https://www.agentwormhole.com) checks that the response is what was quoted: no error after payment, no second 402, the quoted content type, a body that is not empty and JSON that parses. BrainChain then grades whether the delivery is the work the brief asked for. A forecast for the wrong city passes the first check. The grade is what catches it.

The script runs Wormhole's delivery check from the `wormhole-x402` package, sends the exact delivered bytes to BrainChain's grade route with the brief, and prints whether to use the delivery. Once BrainChain accepts the work, its decision record holds those bytes, so the SHA-256 of the record's result is Wormhole's `resource_digest`. The script checks that too.

## Try it free

Node 22.18 or later runs the TypeScript as it is. Nothing here needs a key or pays anything.

```sh
cd examples/wormhole-delivery
npm ci
npm run gate -- --sample
npm run gate -- --dry --delivery fixtures/deliveries/asked.json --brief fixtures/brief.txt
```

`--sample` runs Wormhole's check on the four sample deliveries in [`fixtures/deliveries`](fixtures/deliveries) against the brief in [`fixtures/brief.txt`](fixtures/brief.txt), a Berlin forecast. Wormhole refuses a second 402 after payment and an HTML error page served for a JSON quote, so neither costs a grade. It allows the Berlin forecast and one for Bern, which have the same shape. Only the grade tells them apart: [`fixtures/recorded`](fixtures/recorded) holds BrainChain's mainnet verdicts on both, [accepted](https://usebrainchain.com/decision?id=722) and [rejected](https://usebrainchain.com/decision?id=723), and [`fixtures/records`](fixtures/records) the accepted one's decision record, whose result `--sample` hashes again to Wormhole's SHA-256.

`--dry` runs Wormhole's check on one delivery and asks BrainChain's grade route its price without paying. It exits 0 when BrainChain would grade the delivery, and with the codes below otherwise.

## Grade a delivery

```sh
BRAINCHAIN_PAYER_KEY_FILE=~/.brainchain/payer.key \
  npm run gate -- --delivery my-delivery.json --brief my-brief.txt --title "Berlin forecast, 29 November"
```

The delivery file is what Wormhole's `verify_delivery` tool takes: the quote the payment was made against, the response that arrived, and optionally the `request_digest` of Wormhole's verify receipt for the same purchase.

```json
{
  "quote": { "mimeType": "application/json", "resource": "https://forecast.example/v1/hourly?city=Berlin" },
  "response": { "status": 200, "contentType": "application/json", "bodyText": "{\"city\":\"Berlin\", ...}" },
  "request_digest": "..."
}
```

Send the body as `bodyBase64` when it must arrive byte for byte. The script reads the paying wallet's key only after Wormhole allows the delivery, and pays BrainChain 0.25 USDC on Base whatever the verdict. The wallet needs no gas on Base. It signs at most 0.25 USDC to BrainChain's address, as an EIP-3009 transfer authorization. When BrainChain's answer is lost, the script reads the grade by its id, which is free, instead of paying again.

Before paying, the script stops a delivery that Wormhole refuses or does not judge, one with no body, a body that is not UTF-8 text, one over BrainChain's 100,000 bytes and a blank one. After the verdict, it reads the decision record from BrainChain's desk and checks three things: the record is the file whose keccak256 names it, it is the record of the grade this run paid for, and its result hashes to Wormhole's `resource_digest`. If the record cannot be read, the script says the grade was paid for and where to read it again, which is free.

The brief is published in the decision record, and so is the delivery once BrainChain accepts it. Grade only content you may publish.

| Exit code | Meaning |
| --- | --- |
| 0 | Use the delivery: Wormhole allowed it, BrainChain accepted it, and the record holds the same bytes. `--sample` and `--help` exit 0 too. |
| 1 | Malformed input; a delivery the script cannot grade, because Wormhole did not judge it or it has no body, is not UTF-8 text, is over 100,000 bytes or is blank; or a step that did not finish, such as a wallet short of USDC or a record that did not answer. |
| 2 | Do not use the delivery: Wormhole refused it, BrainChain rejected it, or the record does not hold the same bytes. |

| Variable | Meaning |
| --- | --- |
| `BRAINCHAIN_PAYER_KEY_FILE` | The file holding the paying wallet's private key, readable by its owner alone. A paid run requires it. The key is never printed. |
| `BRAINCHAIN_DESK_URL` | BrainChain's desk, `https://brain.usebrainchain.com` by default. Another must be an https origin, or http on localhost or 127.0.0.1, and take payment at the same address on Base. |

## Tests

```sh
npm run typecheck
npm test
```

The tests run Wormhole's own check on the sample deliveries, replay the two mainnet grades and their record, and pay a mock of BrainChain's grade route with a throwaway key, including a lost reply and a record that does not answer.
