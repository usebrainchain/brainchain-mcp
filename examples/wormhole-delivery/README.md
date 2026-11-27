# Use a paid delivery only when it is the work you asked for

An agent that pays for a resource over x402 can now use what it bought, or release the funds it holds for it, only when two things are true. [Agent Wormhole](https://www.agentwormhole.com) checks that the response is what was quoted: no error after payment, no second 402, the quoted content type, a body that is not empty and JSON that parses. BrainChain then grades whether the delivery is the work the brief asked for. A forecast for the wrong city passes the first check. The grade is what catches it.

The script runs Wormhole's delivery check from the `wormhole-x402` package, sends the exact delivered bytes to BrainChain's grade route with the brief, and prints whether to use the delivery. Once BrainChain accepts the work, its decision record holds those bytes, so the SHA-256 of the record's result is Wormhole's `resource_digest`. The script checks that too.

## Try it free

Node 22.18 or later runs the TypeScript as it is. Nothing here needs a key or pays anything.

```sh
cd examples/wormhole-delivery
npm ci
npm run gate -- --sample
npm run gate -- --dry --delivery fixtures/deliveries/asked.json --brief fixtures/brief.txt
```

`--sample` runs Wormhole's check on the four sample deliveries in [`fixtures/deliveries`](fixtures/deliveries) against the brief in [`fixtures/brief.txt`](fixtures/brief.txt), a Berlin forecast. Wormhole refuses a second 402 after payment and an HTML error page served for a JSON quote, so neither costs a grade. It allows the Berlin forecast and one for Bern, which have the same shape. Only the grade tells them apart: [`fixtures/recorded`](fixtures/recorded) holds BrainChain's mainnet verdicts on both, [accepted](https://usebrainchain.com/decision?id=722) and [rejected](https://usebrainchain.com/decision?id=723), and the accepted one's decision record, whose result `--sample` hashes again to Wormhole's SHA-256.

`--dry` runs Wormhole's check on one delivery and asks BrainChain's grade route its price without paying.

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

Before paying, the script stops a delivery that Wormhole refuses or abstains on, a body that is not UTF-8 text, one over BrainChain's 100,000 bytes and a blank one. After the verdict, it reads the decision record and checks that the record is published under its own keccak256, the hash BrainChain records on chain, and that its result hashes to Wormhole's `resource_digest`.

The brief is published in the decision record, and so is the delivery once BrainChain accepts it. Grade only content you may publish.

| Exit code | Meaning |
| --- | --- |
| 0 | Use the delivery: Wormhole allowed it, BrainChain accepted it, and the record holds the same bytes. `--sample`, `--dry` and `--help` exit 0 too. |
| 1 | Malformed input, or a step that did not finish, such as a wallet short of USDC or a record that did not answer. |
| 2 | Do not use the delivery: Wormhole refused it, BrainChain rejected it, or the record holds other bytes. |

| Variable | Meaning |
| --- | --- |
| `BRAINCHAIN_PAYER_KEY_FILE` | The file holding the paying wallet's private key, readable by its owner alone. A paid run requires it. The key is never printed. |
| `BRAINCHAIN_DESK_URL` | BrainChain's desk, `https://brain.usebrainchain.com` by default. Another must be an https origin, or http on localhost or 127.0.0.1, and take payment at the same address on Base. |

```sh
npm test
npm run typecheck
```
