import { main } from "./serviceLauncher.ts";

// Entry for the boot service's launcher-only executable. The process that
// supervises every server version must not load the server bundle, so its
// build packages just this graph; `t3 __service-launcher` stays in service for
// runtimes installed before this executable existed and for downgrades to
// them.
main().catch((cause: unknown) => {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  process.stderr.write(`[service-launcher] ${error.message}\n`);
  process.exitCode = 1;
});
