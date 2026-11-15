# Security policy

## Reporting a vulnerability

Report it privately, never in a public issue, discussion or pull request:

- open a report from this repository's [Security tab](https://github.com/usebrainchain/brainchain-mcp/security/advisories/new), or
- email security@usebrainchain.com.

Include the version (`brainchain-mcp --version`), your MCP client, and steps or a test that reproduce the problem. Never send a private key that holds funds.

Response times, the bounty and disclosure terms are in the [BrainChain security policy](https://github.com/usebrainchain/.github/blob/main/SECURITY.md).

## What matters most here

This server holds the key of a wallet that pays. The most valuable reports show it:

- signing a payment its user did not ask for, or paying anyone other than BrainChain's payment desk;
- paying past `BRAINCHAIN_MAX_PRICE_UNITS`, `BRAINCHAIN_BUDGET_UNITS`, `BRAINCHAIN_DAILY_UNITS` or `BRAINCHAIN_MAX_BOND_UNITS`;
- revealing the key in output, logs, errors or a request.

## Supported versions

Fixes ship in the latest release on npm. Pin the newest version in your client's configuration.
