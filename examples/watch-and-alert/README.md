# Watch and alert

Two small scripts that use the BrainChain MCP to follow public changes about Robinhood Chain tokens. Both are free, need no key and start the server with `npx`.

- `npm run discord` has each new change posted to a Discord channel as one line: what changed, the token, what it is worth now and the link to check it.
- `npm run loop` is the start of an agent. Every minute it reads the new changes, asks how often earlier tokens with the same step were listed, and prints one line with what it would do.

Node 22.18 or later runs the TypeScript as it is.

```sh
cd examples/watch-and-alert
npm ci
```

## Post each change to Discord

In Discord, open the channel's settings, then Integrations, then Webhooks, make a webhook and copy its URL. Keep it out of the repository: the script reads it from the environment.

```sh
printf 'Webhook URL: ' && read -rs DISCORD_WEBHOOK_URL && echo && export DISCORD_WEBHOOK_URL
npm run discord
```

The script makes the watch with `brainchain_watch` and keeps its id and manage token in `.watch.json`, which only your account can read and git ignores. The watcher shows the manage token only once, and it is what stops the watch:

```sh
npm run discord -- --remove
```

`KINDS` and `TOKENS` keep only some changes, as comma-separated lists, such as `KINDS=bitgo,venue.listed` or `TOKENS=PONS,0x020bfC650A365f8BB26819deAAbF3E21291018b4`. Only changes after the watch is made are posted.

## An agent loop

```sh
npm run loop
npm run loop -- --once
```

It reads the kinds `brainchain_trace_outcomes` counts from the tool's own schema, asks `brainchain_changes` for those every minute, and for each change asks `brainchain_trace_outcomes` how many earlier tokens with that step were listed within 30 days. `--once` reads the newest five and exits.

```text
2026-11-20T09:21:14.480Z | 3385 | metamask.merged | ANT | market cap $2.5M, $665.6K depth | after Trust Wallet's or MetaMask's merge of it into their lists, 1 of 225 earlier tokens listed within 30 days | tell
2026-11-21T17:57:19.230Z | 3561 | pool.created | UBIK | market cap $2.1M, $573 depth (thin) | after a first Uniswap pool, 4 of 1,065,895 earlier tokens listed within 30 days | log
```

The last field is the decision. The script says `tell` when at least `MIN_SHARE` of the earlier tokens with that step were listed within `WITHIN` days, 0.001 and 30 by default, and `log` otherwise. The counts are about earlier tokens and say nothing of this one, and most tokens with any of these steps are never listed. Replace the rule with your own, or with a call to your model.
