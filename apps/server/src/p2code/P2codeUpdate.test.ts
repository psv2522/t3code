import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { expect } from "vite-plus/test";

import * as ProcessRunner from "../processRunner.ts";
import * as P2codeUpdate from "./P2codeUpdate.ts";

const statusJson = (phase: string) =>
  JSON.stringify({ phase, message: null, threadId: "thread-1", version: null, updatedAt: 1 });

const run = (
  flagOutputs: Record<string, { code: number; stdout: string; stderr?: string }>,
  action: Parameters<P2codeUpdate.P2codeUpdate["Service"]["run"]>[0],
  setUp = true,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped();
    if (setUp) {
      const repo = path.join(home, "checkout");
      yield* fs.makeDirectory(path.join(repo, "scripts"), { recursive: true });
      yield* fs.writeFileString(path.join(repo, "scripts", "p2code-update.sh"), "");
      yield* fs.writeFileString(path.join(home, "repo"), `${repo}\n`);
    }
    const calls: Array<string> = [];
    const service = yield* P2codeUpdate.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(ProcessRunner.ProcessRunner, {
            run: (input) => {
              const flag = input.args[1] ?? "";
              calls.push(flag);
              const output = flagOutputs[flag] ?? { code: 1, stdout: "" };
              return Effect.succeed({
                code: output.code,
                stdout: output.stdout,
                stderr: output.stderr ?? "",
              } as never);
            },
          }),
          Layer.succeed(HostProcess.Platform, "darwin"),
          ConfigProvider.layer(ConfigProvider.fromEnv({ env: { P2CODE_OUT: home } })),
        ),
      ),
    );
    return { result: yield* Effect.exit(service.run(action)), calls };
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect("check merges the check result with the running job status", () =>
  Effect.gen(function* () {
    const { result } = yield* run(
      {
        "--check": {
          code: 0,
          stdout: `noise\n${JSON.stringify({ upstreamCommits: 3, localChanges: true, dirty: false })}\n`,
        },
        "--status": { code: 0, stdout: statusJson("idle") },
      },
      "check",
    );
    expect(result._tag).toBe("Success");
    if (result._tag === "Success") {
      expect(result.value).toEqual({
        phase: "idle",
        message: null,
        threadId: "thread-1",
        version: null,
        upstreamCommits: 3,
        localChanges: true,
        dirty: false,
      });
    }
  }),
);

it.effect("start launches the job and reports its status", () =>
  Effect.gen(function* () {
    const { result, calls } = yield* run(
      {
        "--launch": { code: 0, stdout: "" },
        "--status": { code: 0, stdout: statusJson("syncing") },
      },
      "start",
    );
    expect(calls).toEqual(["--launch", "--status"]);
    expect(result._tag === "Success" && result.value.phase).toBe("syncing");
  }),
);

it.effect("surfaces the last ERROR line when the script fails", () =>
  Effect.gen(function* () {
    const { result } = yield* run(
      {
        "--launch": {
          code: 1,
          stdout: "",
          stderr: "\nERROR: The p2code repo has uncommitted changes.\n",
        },
      },
      "start",
    );
    expect(result._tag).toBe("Failure");
    expect(JSON.stringify(result)).toContain("The p2code repo has uncommitted changes.");
  }),
);

it.effect("fails when p2code is not set up on this machine", () =>
  Effect.gen(function* () {
    const { result, calls } = yield* run({}, "status", false);
    expect(calls).toEqual([]);
    expect(JSON.stringify(result)).toContain("p2code is not set up on this machine.");
  }),
);
