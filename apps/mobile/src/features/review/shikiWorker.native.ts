import { TurboModuleRegistry } from "react-native";
import type { Spec } from "react-native-shiki-engine";
import {
  createSynchronizable,
  createWorkletRuntime,
  scheduleOnRN,
  scheduleOnRuntime,
  type WorkletRuntime,
} from "react-native-worklets";

import type { ReviewHighlightedToken } from "./reviewHighlightedToken.types";
import { installNativeRegexEngine, tokenizeCode, type TokenizeRequest } from "./shikiTokenizer";

let runtime: WorkletRuntime | undefined;

function getRuntime(): WorkletRuntime {
  if (runtime) return runtime;
  runtime = createWorkletRuntime({ name: "shiki" });
  // Worker runtimes have no TurboModule registry. Hand over the method host
  // functions rather than the module: resolving a method on the module object
  // caches it on the RN runtime's copy, which the worker thread must not touch.
  const engine = TurboModuleRegistry.get<Spec>("ShikiEngine");
  if (engine) {
    const functions = {
      createScanner: engine.createScanner,
      findNextMatchSync: engine.findNextMatchSync,
      destroyScanner: engine.destroyScanner,
    };
    scheduleOnRuntime(runtime, () => {
      "worklet";
      installNativeRegexEngine(functions);
    });
  }
  return runtime;
}

export function tokenizeOnWorker(
  request: TokenizeRequest,
  signal?: AbortSignal,
): Promise<Array<Array<ReviewHighlightedToken>>> {
  const cancelled = signal ? createSynchronizable(signal.aborted, { fixedType: true }) : undefined;
  signal?.addEventListener("abort", () => cancelled?.setBlocking(true), { once: true });
  return new Promise((resolve, reject) => {
    scheduleOnRuntime(getRuntime(), () => {
      "worklet";
      tokenizeCode(request, () => cancelled?.getDirty() ?? false).then(
        (lines) => scheduleOnRN(resolve, lines),
        (error: unknown) => scheduleOnRN(reject, error),
      );
    });
  });
}
