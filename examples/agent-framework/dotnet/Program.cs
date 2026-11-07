// A Microsoft Agent Framework agent that hands a task to BrainChain through brainchain-mcp.
//
//   dotnet run -- "List the three prime numbers between 50 and 70, one per line."
//   dotnet run -- --list-tools
//
// The model comes from any OpenAI-compatible endpoint: OPENAI_API_KEY and OPENAI_MODEL, with OPENAI_BASE_URL for
// providers other than OpenAI. The BRAINCHAIN_ settings, the payer key file and the spending limits among them, go
// to the MCP server and nowhere else.

using System.ClientModel;
using System.Collections;
using System.ComponentModel;
using Microsoft.Agents.AI;
using Microsoft.Extensions.AI;
using ModelContextProtocol.Client;
using OpenAI;

const string Instructions = """
    You hand scoped work to BrainChain, where Jev, a decision model, hires a worker and grades the result.
    Post the user's brief with brainchain_post_task. Then read the task with brainchain_get_task until it is done,
    calling Wait with the seconds the reply asks for between reads. Report the accepted result, or why it was not
    accepted, and the decision page. Never post the same brief twice: a reply that says it may have been charged is
    read, not resent.
    """;

var settings = Environment.GetEnvironmentVariables()
    .Cast<DictionaryEntry>()
    .Where(entry => ((string)entry.Key).StartsWith("BRAINCHAIN_", StringComparison.Ordinal))
    .ToDictionary(entry => (string)entry.Key, entry => (string?)entry.Value);

// npx is a .cmd script on Windows, which only cmd.exe starts.
string[] server = ["npx", "-y", "brainchain-mcp@0.8.0"];
await using var brainchain = await McpClient.CreateAsync(new StdioClientTransport(new()
{
    Name = "brainchain",
    Command = OperatingSystem.IsWindows() ? "cmd.exe" : server[0],
    Arguments = OperatingSystem.IsWindows() ? ["/c", .. server] : server[1..],
    EnvironmentVariables = settings,
}));

List<AITool> tools = [.. (await brainchain.ListToolsAsync()).Where(tool => tool.Name is "brainchain_post_task" or "brainchain_get_task")];

if (args is ["--list-tools"])
{
    foreach (var tool in tools) Console.WriteLine(tool.Name);
    return;
}

tools.Add(AIFunctionFactory.Create(Wait));

var brief = args.Length > 0 ? string.Join(' ', args) : "List the three prime numbers between 50 and 70, one per line.";
var key = Environment.GetEnvironmentVariable("OPENAI_API_KEY") ?? throw new InvalidOperationException("Set OPENAI_API_KEY.");
var model = Environment.GetEnvironmentVariable("OPENAI_MODEL") ?? throw new InvalidOperationException("Set OPENAI_MODEL.");
var options = new OpenAIClientOptions();
if (Environment.GetEnvironmentVariable("OPENAI_BASE_URL") is { Length: > 0 } baseUrl) options.Endpoint = new Uri(baseUrl);

AIAgent agent = new ChatClientAgent(
    new OpenAIClient(new ApiKeyCredential(key), options).GetChatClient(model).AsIChatClient(),
    instructions: Instructions,
    name: "BrainChainAgent",
    tools: tools);

Console.WriteLine(await agent.RunAsync($"Post this brief to BrainChain and report the outcome:\n\n{brief}"));

[Description("Waits before the next read of a task, since a task takes minutes to be hired, delivered and graded.")]
static async Task<string> Wait([Description("How long to wait, as brainchain_get_task's reply asks")] int seconds)
{
    seconds = Math.Clamp(seconds, 5, 120);
    await Task.Delay(TimeSpan.FromSeconds(seconds));
    return $"Waited {seconds} seconds.";
}
