"""A Microsoft Agent Framework agent that hands a task to BrainChain through brainchain-mcp.

    pip install -r requirements.txt
    python brainchain_agent.py "List the three prime numbers between 50 and 70, one per line."
    python brainchain_agent.py --list-tools

The agent posts the brief, waits for BrainChain to grade the work and reports the result. The model comes from any
OpenAI-compatible endpoint: OPENAI_API_KEY, with OPENAI_BASE_URL and OPENAI_MODEL for other providers. The
BRAINCHAIN_ settings, the payer key file and the spending limits among them, go to the MCP server and nowhere else.
"""

import asyncio
import os
import sys
from typing import Annotated

from agent_framework import Agent, MCPStdioTool
from agent_framework.openai import OpenAIChatCompletionClient

INSTRUCTIONS = """You hand scoped work to BrainChain, which hires a worker and grades the result.
Post the user's brief with brainchain_post_task. Then read the task with brainchain_get_task, calling wait with the
seconds the reply asks for between reads, until done is true or next says BrainChain did not accept the work.
Accepted: report the result and the decision page. Not accepted: report that at once, with the order id. The refund is
sent when the dispute window closes, hours later, and a read of the order after that gives its transaction.
If wait says to stop, report where the task stands and its order id. Never post the same brief twice: a reply that
says it may have been charged is read, not resent."""

# Most tasks are graded within minutes. Past this the agent reports where the task stands.
WAIT_BUDGET_SECONDS = 30 * 60


def waiter(budget: int):
    """The agent's wait tool, which stops after `budget` seconds in all, so every run ends with a report."""
    left = budget

    async def wait(seconds: Annotated[int, "How long to wait, as brainchain_get_task's reply asks"]) -> str:
        """Waits before the next read of a task, which usually takes a few minutes to be graded."""
        nonlocal left
        if left <= 0:
            return "Stop reading: report where the task stands and its order id, which brainchain_get_task can read later."
        seconds = min(max(seconds, 5), 120, left)
        await asyncio.sleep(seconds)
        left -= seconds
        return f"Waited {seconds} seconds."

    return wait


def server() -> MCPStdioTool:
    settings = {name: value for name, value in os.environ.items() if name.startswith("BRAINCHAIN_")}
    return MCPStdioTool(
        name="brainchain",
        command="npx",
        args=["-y", "brainchain-mcp@0.22.0"],
        env=settings,
        allowed_tools=["brainchain_post_task", "brainchain_get_task"],
        request_timeout=180,
    )


async def main() -> None:
    args = sys.argv[1:]
    async with server() as brainchain:
        if args == ["--list-tools"]:
            for function in brainchain.functions:
                print(function.name)
            return
        brief = " ".join(args) or "List the three prime numbers between 50 and 70, one per line."
        # The Chat Completions client, which every OpenAI-compatible provider serves. It reads OPENAI_API_KEY,
        # OPENAI_MODEL and OPENAI_BASE_URL itself.
        async with Agent(
            client=OpenAIChatCompletionClient(),
            name="BrainChainAgent",
            instructions=INSTRUCTIONS,
            default_options={"max_tokens": 4000},
        ) as agent:
            result = await agent.run(f"Post this brief to BrainChain and report the outcome:\n\n{brief}", tools=[brainchain, waiter(WAIT_BUDGET_SECONDS)])
            print(result.text)


if __name__ == "__main__":
    asyncio.run(main())
