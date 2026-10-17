/**
 * Every ACP agent spawns `t3 acp-mcp-bridge` while opening its session, and terminal-fallback
 * agents run `t3 acp-mcp-call` per tool call, so their startup sits on first-message latency.
 * They and Codex's managed-token helper dispatch before the full CLI module graph (seconds
 * of evaluation) loads, as does the boot service launcher, which lives as long as the machine
 * and needs none of it; everything else defers to the real CLI in ./binCli.ts.
 */
import { isEntrypoint } from "./entrypoint.ts";

if (
  isEntrypoint({
    moduleUrl: import.meta.url,
    entryPath: process.argv[1],
    runtimeMain: import.meta.main,
  })
) {
  const command = process.argv[2];
  // Guard sockets before either dispatch path can load outbound-capable modules.
  const { ignoreMacosTypeOfServiceEinval } = await import("./outboundHttp.ts");
  ignoreMacosTypeOfServiceEinval();
  // The service plist sets this for the launcher to pass to the server.
  // libmalloc reads it when a process starts, so dropping it here keeps the
  // server's own savings while its children (agents, terminals, git, the ACP
  // bridges) start without the allocator mode's wall-time cost. The launcher
  // keeps it: it is what starts the server.
  if (command !== "__service-launcher") {
    delete process.env.MallocSpaceEfficient;
  }
  if (command === "__managed-chatgpt-token") {
    const { runManagedChatGptTokenCli } = await import("./cli/managedChatGptToken.ts");
    await runManagedChatGptTokenCli(process.argv.slice(3));
  } else if (command === "acp-mcp-bridge" || command === "acp-mcp-call") {
    const { runAcpMcpCliFastPath } = await import("./mcp/AcpMcpStdioBridge.ts");
    await runAcpMcpCliFastPath(command, process.argv.slice(3));
  } else if (command === "__service-launcher") {
    const { main } = await import("./serviceLauncher.ts");
    main().catch((cause: unknown) => {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      process.stderr.write(`[service-launcher] ${error.message}\n`);
      process.exitCode = 1;
    });
  } else {
    // Before anything reads stdin: the desktop app's Windows launcher starts
    // the CLI without one. Never for the fast paths, whose stdin is a pipe.
    const { attachConsoleStdin } = await import("./cli/consoleStdin.ts");
    attachConsoleStdin();
    const { runCli } = await import("./binCli.ts");
    runCli();
  }
}
