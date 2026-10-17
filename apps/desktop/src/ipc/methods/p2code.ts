// @effect-diagnostics nodeBuiltinImport:off -- Runs the owner's local p2code script and opens Terminal from the main process.
import {
  DesktopP2codeCheckResultSchema,
  DesktopP2codeUpdateResultSchema,
  type DesktopP2codeCheckResult,
  type DesktopP2codeUpdateResult,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

const CHECK_TIMEOUT_MS = 30_000;

const p2codeHome = () => process.env.P2CODE_OUT ?? NodePath.join(NodeOS.homedir(), ".p2code");
const updateScript = (repo: string) => NodePath.join(repo, "scripts", "p2code-update.sh");

export const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export const buildUpdateCommandFile = (script: string) =>
  `#!/bin/zsh\nexec /bin/zsh -ilc ${shellQuote(
    `${shellQuote(script)}; code=$?; echo; read -k 1 "?Press any key to close"; exit $code`,
  )}\n`;

const errorResult = (message: string): DesktopP2codeCheckResult => ({
  status: "error",
  upstreamCommits: 0,
  localChanges: false,
  message,
});

export const parseP2codeCheck = (stdout: string): DesktopP2codeCheckResult => {
  try {
    const parsed: unknown = JSON.parse(stdout.trim().split("\n").at(-1) ?? "");
    const { upstreamCommits, localChanges, dirty } = parsed as Record<string, unknown>;
    if (
      typeof upstreamCommits !== "number" ||
      typeof localChanges !== "boolean" ||
      typeof dirty !== "boolean"
    ) {
      throw new Error("unexpected shape");
    }
    return {
      status: dirty ? "dirty" : upstreamCommits > 0 || localChanges ? "available" : "up-to-date",
      upstreamCommits,
      localChanges,
      message: null,
    };
  } catch {
    return errorResult("The update check returned an unreadable result.");
  }
};

const readRepo = async (): Promise<string | null> => {
  try {
    const repo = (await NodeFSP.readFile(NodePath.join(p2codeHome(), "repo"), "utf8")).trim();
    await NodeFSP.access(updateScript(repo));
    return repo;
  } catch {
    return null;
  }
};

const execFile = (command: string, args: ReadonlyArray<string>, timeout: number) =>
  new Promise<{ readonly stdout: string; readonly stderr: string }>((resolve, reject) => {
    NodeChildProcess.execFile(command, [...args], { timeout }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stderr }));
        return;
      }
      resolve({ stdout, stderr });
    });
  });

const failureMessage = (error: unknown, fallback: string): string => {
  const stderr = (error as { stderr?: unknown }).stderr;
  const line =
    typeof stderr === "string"
      ? stderr
          .split("\n")
          .map((entry) => entry.replace(/^ERROR:\s*/, "").trim())
          .findLast((entry) => entry.length > 0)
      : undefined;
  return line ?? (error instanceof Error ? error.message : fallback);
};

const checkUpdate = async (): Promise<DesktopP2codeCheckResult> => {
  const repo = await readRepo();
  if (repo === null) return errorResult("p2code is not set up on this machine.");
  try {
    const { stdout } = await execFile(
      "/bin/bash",
      [updateScript(repo), "--check"],
      CHECK_TIMEOUT_MS,
    );
    return parseP2codeCheck(stdout);
  } catch (error) {
    return errorResult(failureMessage(error, "The update check failed."));
  }
};

const startUpdate = async (platform: NodeJS.Platform): Promise<DesktopP2codeUpdateResult> => {
  if (platform !== "darwin") {
    return { started: false, message: "p2code updates are only supported on macOS." };
  }
  const repo = await readRepo();
  if (repo === null) return { started: false, message: "p2code is not set up on this machine." };
  try {
    const directory = NodePath.join(p2codeHome(), "run");
    await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
    const file = NodePath.join(directory, "update.command");
    await NodeFSP.writeFile(file, buildUpdateCommandFile(updateScript(repo)), { mode: 0o700 });
    await NodeFSP.chmod(file, 0o700);
    await execFile("/usr/bin/open", ["-a", "Terminal", file], CHECK_TIMEOUT_MS);
    return { started: true, message: null };
  } catch (error) {
    return { started: false, message: failureMessage(error, "Could not open Terminal.") };
  }
};

export const isP2codeAvailable = makeIpcMethod({
  channel: IpcChannels.P2CODE_AVAILABLE_CHANNEL,
  payload: Schema.Void,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.p2code.isAvailable")(function* () {
    return (yield* Effect.promise(readRepo)) !== null;
  }),
});

export const checkP2codeUpdate = makeIpcMethod({
  channel: IpcChannels.P2CODE_CHECK_CHANNEL,
  payload: Schema.Void,
  result: DesktopP2codeCheckResultSchema,
  handler: Effect.fn("desktop.ipc.p2code.check")(function* () {
    return yield* Effect.promise(checkUpdate);
  }),
});

export const runP2codeUpdate = makeIpcMethod({
  channel: IpcChannels.P2CODE_UPDATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopP2codeUpdateResultSchema,
  handler: Effect.fn("desktop.ipc.p2code.update")(function* () {
    const platform = yield* HostProcess.Platform;
    return yield* Effect.promise(() => startUpdate(platform));
  }),
});
