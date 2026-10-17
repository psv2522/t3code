import { useAtomValue } from "@effect/atom-react";
import {
  attachP2codeUpdate,
  describeP2codeUpdate,
  resolveP2codeCheck,
  watchP2codeUpdate,
  type P2codeUpdateCall,
} from "@t3tools/client-runtime/p2codeUpdate";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  isP2codeUpdateRunning,
  type EnvironmentId,
  type P2codeUpdateResult,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useEffect } from "react";

import { isElectron } from "../../env";
import { ensureLocalApi } from "../../localApi";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useServerConfigs } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { environmentPresentations } from "../../state/presentation";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { serverEnvironment } from "../../state/server";
import { stackedThreadToast, toastManager } from "../ui/toast";

const p2codeUpdateProgressAtom = Atom.make<P2codeUpdateResult | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("web-p2code-update-progress"),
);

export function useP2codeUpdateProgress(): P2codeUpdateResult | null {
  const primaryId = usePrimaryEnvironmentId();
  const configs = useServerConfigs();
  const environmentId = resolveP2codeEnvironmentId(configs, primaryId);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows a server-side update until unmount
  useEffect(() => {
    if (environmentId === null || inFlight) return;
    inFlight = true;
    const controller = new AbortController();
    activeWatch = controller;
    let wasRunning = false;
    void attachP2codeUpdate({
      call: makeCall(environmentId),
      onProgress: (progress) => {
        if (isP2codeUpdateRunning(progress.phase)) {
          wasRunning = true;
          rememberReportedFailure(null);
        }
        appAtomRegistry.set(p2codeUpdateProgressAtom, progress);
      },
      signal: controller.signal,
    })
      .then((result) => {
        if (
          result !== null &&
          (result.phase === "failed" || (wasRunning && result.phase === "done"))
        ) {
          if (result.phase !== "failed" || readReportedFailure() !== failureKey(result)) {
            reportOutcome(result);
          }
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (activeWatch === controller) {
          activeWatch = null;
          appAtomRegistry.set(p2codeUpdateProgressAtom, null);
          inFlight = false;
        }
      });
    return () => {
      controller.abort();
      if (activeWatch === controller) {
        activeWatch = null;
        appAtomRegistry.set(p2codeUpdateProgressAtom, null);
        inFlight = false;
      }
    };
  }, [environmentId]);
  return useAtomValue(p2codeUpdateProgressAtom);
}

function resolveP2codeEnvironmentId(
  configs: ReturnType<typeof useServerConfigs>,
  primaryId: EnvironmentId | null,
): EnvironmentId | null {
  const supports = (id: EnvironmentId) =>
    configs.get(id)?.environment.capabilities.p2codeUpdate === true;
  if (primaryId !== null && supports(primaryId)) return primaryId;
  for (const id of configs.keys()) {
    if (supports(id)) return id;
  }
  return null;
}

export function useP2codeAvailable(): boolean {
  const primaryId = usePrimaryEnvironmentId();
  const serverConfigs = useServerConfigs();
  return resolveP2codeEnvironmentId(serverConfigs, primaryId) !== null;
}

const report = (type: "info" | "error" | "success", title: string, description: string) =>
  toastManager.add(stackedThreadToast({ type, title, description }));

function makeCall(fixedEnvironmentId?: EnvironmentId): P2codeUpdateCall {
  return async (action) => {
    const environmentId =
      fixedEnvironmentId ??
      resolveP2codeEnvironmentId(
        appAtomRegistry.get(environmentPresentations.serverConfigsAtom),
        appAtomRegistry.get(primaryEnvironmentIdAtom),
      );
    if (environmentId === null) throw new Error("No T3 Code server is connected.");
    const result = await serverEnvironment.p2codeUpdate.run(appAtomRegistry, {
      environmentId,
      input: action === "start" && isElectron ? { action, relaunchApp: true } : { action },
    });
    if (result._tag !== "Success") throw squashAtomCommandFailure(result);
    return result.value;
  };
}

const REPORTED_FAILURE_KEY = "p2code-update-reported-failure";

const failureKey = (result: P2codeUpdateResult) =>
  JSON.stringify([result.message, result.threadId]);

function readReportedFailure(): string | null {
  try {
    return window.localStorage.getItem(REPORTED_FAILURE_KEY);
  } catch {
    return null;
  }
}

function rememberReportedFailure(key: string | null) {
  try {
    if (key === null) window.localStorage.removeItem(REPORTED_FAILURE_KEY);
    else window.localStorage.setItem(REPORTED_FAILURE_KEY, key);
  } catch {
    return;
  }
}

function reportOutcome(result: P2codeUpdateResult) {
  if (result.phase === "failed") {
    rememberReportedFailure(failureKey(result));
    report("error", "Update failed", describeP2codeUpdate(result) ?? "The update failed.");
  } else {
    report("success", "p2code updated", result.message ?? "T3 Code is up to date.");
  }
}

let inFlight = false;
let activeWatch: AbortController | null = null;

/** Checks for updates, asks once, then runs the whole update in the background. */
export async function checkAndStartP2codeUpdate(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  const call = makeCall();
  try {
    const checked = await call("check");
    const outcome = resolveP2codeCheck(checked);
    if (outcome.kind === "running") {
      appAtomRegistry.set(p2codeUpdateProgressAtom, checked);
    } else if (outcome.kind === "up-to-date") {
      report(
        "info",
        "p2code is up to date",
        "No new upstream changes, and nothing new in p2code since the last install.",
      );
      return;
    } else if (outcome.kind === "dirty") {
      report(
        "info",
        "Commit your p2code changes first",
        "The p2code repo has uncommitted changes, so an update cannot start.",
      );
      return;
    } else {
      const confirmed = await ensureLocalApi().dialogs.confirm(
        `Update p2code?\n\n${outcome.changes.map((change) => `• ${change}`).join("\n")}\n\nThis syncs, builds and installs in the background. T3 Code restarts when the install finishes.`,
      );
      if (!confirmed) return;
      appAtomRegistry.set(p2codeUpdateProgressAtom, await call("start"));
    }
    const final = await watchP2codeUpdate({
      call,
      onProgress: (progress) => appAtomRegistry.set(p2codeUpdateProgressAtom, progress),
      signal: new AbortController().signal,
    });
    if (final !== null) reportOutcome(final);
  } catch (error) {
    report(
      "error",
      "Could not update",
      error instanceof Error ? error.message : "The update failed.",
    );
  } finally {
    appAtomRegistry.set(p2codeUpdateProgressAtom, null);
    inFlight = false;
  }
}
