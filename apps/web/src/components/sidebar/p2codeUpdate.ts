import { useAtomValue } from "@effect/atom-react";
import {
  createP2codeUpdateWatcher,
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
import { environmentPresentations, useEnvironmentPresentation } from "../../state/presentation";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { serverEnvironment } from "../../state/server";
import { stackedThreadToast, toastManager } from "../ui/toast";

const p2codeUpdateProgressAtom = Atom.family((environmentId: EnvironmentId | null) =>
  Atom.make<P2codeUpdateResult | null>(null).pipe(
    Atom.keepAlive,
    Atom.withLabel(`web-p2code-update-progress:${environmentId}`),
  ),
);
const activeWatches = new Map<EnvironmentId, ReturnType<typeof createP2codeUpdateWatcher>>();

export function useP2codeUpdateProgress(): P2codeUpdateResult | null {
  const primaryId = usePrimaryEnvironmentId();
  const configs = useServerConfigs();
  const environmentId = resolveP2codeEnvironmentId(configs, primaryId);
  const { presentation } = useEnvironmentPresentation(environmentId);
  const connectionPhase = presentation?.connection.phase;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- observes the selected server's update job while the client is visible
  useEffect(() => {
    if (environmentId === null) return;
    const watcher = createP2codeUpdateWatcher({
      call: makeCall(environmentId),
      active: document.visibilityState !== "hidden",
      onProgress: (progress) => {
        if (isP2codeUpdateRunning(progress.phase)) {
          rememberReportedFailure(environmentId, null);
        }
        appAtomRegistry.set(p2codeUpdateProgressAtom(environmentId), progress);
      },
      onComplete: (result) => {
        if (
          result.phase !== "failed" ||
          readReportedFailure(environmentId) !== failureKey(result)
        ) {
          reportOutcome(environmentId, result);
        }
      },
    });
    activeWatches.set(environmentId, watcher);
    const onVisibility = () => watcher.setActive(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      watcher.dispose();
      if (activeWatches.get(environmentId) === watcher) activeWatches.delete(environmentId);
    };
  }, [environmentId]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- checks for an update immediately after the server reconnects
  useEffect(() => {
    if (environmentId !== null && connectionPhase === "connected") {
      activeWatches.get(environmentId)?.refresh();
    }
  }, [environmentId, connectionPhase]);
  const progress = useAtomValue(p2codeUpdateProgressAtom(environmentId));
  return progress !== null && isP2codeUpdateRunning(progress.phase) ? progress : null;
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

function makeCall(environmentId: EnvironmentId): P2codeUpdateCall {
  return async (action) => {
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

function readReportedFailure(environmentId: EnvironmentId): string | null {
  try {
    return window.localStorage.getItem(`${REPORTED_FAILURE_KEY}:${environmentId}`);
  } catch {
    return null;
  }
}

function rememberReportedFailure(environmentId: EnvironmentId, key: string | null) {
  try {
    const storageKey = `${REPORTED_FAILURE_KEY}:${environmentId}`;
    if (key === null) window.localStorage.removeItem(storageKey);
    else window.localStorage.setItem(storageKey, key);
  } catch {
    return;
  }
}

function reportOutcome(environmentId: EnvironmentId, result: P2codeUpdateResult) {
  if (result.phase === "failed") {
    rememberReportedFailure(environmentId, failureKey(result));
    report("error", "Update failed", describeP2codeUpdate(result) ?? "The update failed.");
  } else {
    report("success", "p2code updated", result.message ?? "T3 Code is up to date.");
  }
}

const inFlight = new Set<EnvironmentId>();

/** Checks for updates, asks once, then runs the whole update in the background. */
export async function checkAndStartP2codeUpdate(): Promise<void> {
  const environmentId = resolveP2codeEnvironmentId(
    appAtomRegistry.get(environmentPresentations.serverConfigsAtom),
    appAtomRegistry.get(primaryEnvironmentIdAtom),
  );
  if (environmentId === null) {
    report("error", "Could not update", "No T3 Code server is connected.");
    return;
  }
  if (inFlight.has(environmentId)) return;
  inFlight.add(environmentId);
  const call = makeCall(environmentId);
  const publish = (progress: P2codeUpdateResult) => {
    const watcher = activeWatches.get(environmentId);
    if (watcher) watcher.update(progress);
    else appAtomRegistry.set(p2codeUpdateProgressAtom(environmentId), progress);
  };
  try {
    const checked = await call("check");
    const outcome = resolveP2codeCheck(checked);
    if (outcome.kind === "running") {
      publish(checked);
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
      publish(await call("start"));
    }
    if (activeWatches.has(environmentId)) return;
    const final = await watchP2codeUpdate({
      call,
      onProgress: publish,
      signal: new AbortController().signal,
    });
    if (final !== null) reportOutcome(environmentId, final);
  } catch (error) {
    report(
      "error",
      "Could not update",
      error instanceof Error ? error.message : "The update failed.",
    );
  } finally {
    inFlight.delete(environmentId);
  }
}
