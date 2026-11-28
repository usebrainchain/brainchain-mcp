# Contributing

Bug reports and pull requests are welcome. For a change larger than a fix, open an issue first so we can agree on the approach. Security issues go through [SECURITY.md](SECURITY.md), never a public issue.

## Development

Requires Node 22 or later.

```bash
npm ci
npm run build
npm test
```

The tests need no key and no wallet. To try a change in a client, run your build in place of the `npx` command, for example `node /path/to/brainchain-mcp/dist/index.js`, and set `BRAINCHAIN_NETWORK=testnet` to pay with test tokens. The README's testnet section says how to fund a test wallet.

The reference seller has its own suite:

```bash
cd examples/reference-seller
npm ci
npm run typecheck
npm test
```

So does the pre-trade check, whose tests run its Python checks in Pyodide:

```bash
cd examples/pretrade-check
npm ci
npm run typecheck
npm test
```

So does the delivery gate with Agent Wormhole:

```bash
cd examples/wormhole-delivery
npm ci
npm run typecheck
npm test
```

## Pull requests

- One change per pull request, saying what it does and why.
- A test for every change in behaviour. Several tests read the README, the tool descriptions and the manifests side by side, so a change to what a tool does or says updates all three.
- CI must pass: the tests on Node 22 and 24, the reference seller, the pre-trade check, the delivery gate with Agent Wormhole, and the agent framework samples on Linux and Windows.

## Releases

A release moves the version in `package.json`, `package-lock.json`, `server.json`, `mcp.json`, `.cursor-plugin/plugin.json` and every pinned install command together, the pins inside install links included. `npm version <new> --no-git-tag-version` does all of it, through `scripts/pin.mjs`; a test fails if one is left behind. Maintainers publish to npm and the MCP Registry, tag the commit and add a GitHub release.

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
