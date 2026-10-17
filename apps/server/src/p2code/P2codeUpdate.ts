// @effect-diagnostics nodeBuiltinImport:off -- The owner's p2code home defaults to ~/.p2code.
import {
  P2codeUpdateError,
  type P2codeUpdateAction,
  type P2codeUpdateResult,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as NodeOS from "node:os";

import * as ProcessRunner from "../processRunner.ts";

const CHECK_TIMEOUT = Duration.seconds(45);
const COMMAND_TIMEOUT = Duration.seconds(20);

const StatusJson = Schema.Struct({
  phase: Schema.Literals([
    "idle",
    "syncing",
    "building",
    "installing",
    "conflict",
    "done",
    "failed",
  ]),
  message: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(Schema.String),
  version: Schema.NullOr(Schema.String),
});
const CheckJson = Schema.Struct({
  upstreamCommits: Schema.Int,
  localChanges: Schema.Boolean,
  dirty: Schema.Boolean,
});
const decodeStatus = Schema.decodeUnknownEffect(Schema.fromJsonString(StatusJson));
const decodeCheck = Schema.decodeUnknownEffect(Schema.fromJsonString(CheckJson));

const lastLine = (text: string) => text.trim().split("\n").at(-1) ?? "";

const failureReason = (stderr: string, fallback: string) =>
  stderr
    .split("\n")
    .map((line) => line.replace(/^ERROR:\s*/, "").trim())
    .findLast((line) => line.length > 0) ?? fallback;

/** The update script of this machine's p2code checkout, or none when p2code is not set up here. */
export const resolveP2codeUpdateScript = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  if (platform !== "darwin") return Option.none<string>();
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = Option.getOrElse(yield* Config.String("P2CODE_OUT").pipe(Config.option), () =>
    path.join(NodeOS.homedir(), ".p2code"),
  );
  const repo = (yield* fs
    .readFileString(path.join(home, "repo"))
    .pipe(Effect.orElseSucceed(() => ""))).trim();
  if (repo === "") return Option.none<string>();
  const script = path.join(repo, "scripts", "p2code-update.sh");
  return (yield* fs.exists(script).pipe(Effect.orElseSucceed(() => false)))
    ? Option.some(script)
    : Option.none<string>();
});

export class P2codeUpdate extends Context.Service<
  P2codeUpdate,
  {
    readonly run: (
      action: P2codeUpdateAction,
      relaunchApp?: boolean,
    ) => Effect.Effect<P2codeUpdateResult, P2codeUpdateError>;
  }
>()("t3/p2code/P2codeUpdate") {}

export const make = Effect.gen(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;
  const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();

  const resolveScript = resolveP2codeUpdateScript.pipe(
    Effect.provideContext(context),
    Effect.orElseSucceed(() => Option.none<string>()),
  );

  const fail = (reason: string) => new P2codeUpdateError({ reason });

  const invoke = Effect.fn("P2codeUpdate.invoke")(function* (
    script: string,
    flag: "--check" | "--status" | "--launch",
    extra: ReadonlyArray<string> = [],
  ) {
    const output = yield* runner
      .run({
        command: "/bin/bash",
        args: [script, flag, ...extra],
        timeout: flag === "--check" ? CHECK_TIMEOUT : COMMAND_TIMEOUT,
      })
      .pipe(Effect.mapError(() => fail("Could not run the p2code update script.")));
    if (output.code !== 0) {
      return yield* fail(failureReason(output.stderr, "The p2code update script failed."));
    }
    return lastLine(output.stdout);
  });

  const status = Effect.fn("P2codeUpdate.status")(function* (script: string) {
    const json = yield* invoke(script, "--status");
    return yield* decodeStatus(json).pipe(
      Effect.mapError(() => fail("The update status was unreadable.")),
    );
  });

  const run: P2codeUpdate["Service"]["run"] = Effect.fn("P2codeUpdate.run")(
    function* (action, relaunchApp) {
      const script = Option.getOrUndefined(yield* resolveScript);
      if (script === undefined) return yield* fail("p2code is not set up on this machine.");
      const noCheck = { upstreamCommits: null, localChanges: null, dirty: null } as const;
      if (action === "status") return { ...(yield* status(script)), ...noCheck };
      if (action === "start") {
        yield* invoke(script, "--launch", relaunchApp === true ? ["--relaunch"] : []);
        return { ...(yield* status(script)), ...noCheck };
      }
      const check = yield* decodeCheck(yield* invoke(script, "--check")).pipe(
        Effect.mapError(() => fail("The update check returned an unreadable result.")),
      );
      return { ...(yield* status(script)), ...check };
    },
  );

  return P2codeUpdate.of({ run });
});

export const layer = Layer.effect(P2codeUpdate, make).pipe(Layer.provide(ProcessRunner.layer));
