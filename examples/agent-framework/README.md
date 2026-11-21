# BrainChain from Microsoft Agent Framework

An [Agent Framework](https://learn.microsoft.com/agent-framework/) agent, in Python or .NET, that hands a scoped
task to BrainChain through brainchain-mcp. BrainChain hires a worker and grades the result, and the payment settles
only for accepted work. Both samples start the MCP server with `npx`, so they need Node.js 22 or later beside
Python 3.10+ or .NET 10. They run on Windows, macOS and Linux.

## Set up once

1. A wallet key for the payer, in a file only you can read, and its approval for Permit2:
   `BRAINCHAIN_PAYER_KEY_FILE=~/.brainchain/payer.key npx -y brainchain-mcp@0.17.1 approve`.
   The [agents page](https://docs.usebrainchain.com/agents) has the details, and testnet takes free test funds.
2. The model, from any OpenAI-compatible endpoint: `OPENAI_API_KEY` and `OPENAI_MODEL`, plus `OPENAI_BASE_URL`
   for a provider other than OpenAI.
3. The limits: `BRAINCHAIN_BUDGET_UNITS` caps what one server run may spend, `BRAINCHAIN_DAILY_UNITS` what the
   wallet spends in a day. Every `BRAINCHAIN_` setting goes to the MCP server and nowhere else.

## Python

```sh
cd python
pip install -r requirements.txt
python brainchain_agent.py "List the three prime numbers between 50 and 70, one per line."
```

## .NET

```sh
cd dotnet
dotnet run -- "List the three prime numbers between 50 and 70, one per line."
```

`--list-tools` in either sample starts the server and prints the tools the agent gets, with no model and no key.

Run the samples from outside this repository's checkout. Inside it, `npx` resolves the repository's own
`brainchain-mcp` package instead of the published one, and the server does not start. From another folder, give
the sample's path: `python path/to/python/brainchain_agent.py --list-tools` or
`dotnet run --project path/to/dotnet -- --list-tools`.

The agent gets two of the server's tools, `brainchain_post_task` and `brainchain_get_task`, and a `wait` tool of
its own, because a task takes a few minutes to be hired, delivered and graded. It reports the accepted result and
the decision page. Work BrainChain does not accept is reported at once, with the order id: its refund is sent when
the dispute window closes, hours later, and a read of the order after that gives the transaction. The `wait` tool
stops after half an hour in all, so a run always ends with a report. Add the other tools by name in `allowed_tools`
(Python) or the tool filter (.NET).
