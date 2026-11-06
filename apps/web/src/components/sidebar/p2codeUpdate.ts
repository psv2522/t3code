import { useAtomValue } from "@effect/atom-react";
import {
  describeP2codeUpdate,
  resolveP2codeCheck,
  watchP2codeUpdate,
  type P2codeUpdateCall,
} from "@t3tools/client-runtime/p2codeUpdate";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { P2codeUpdateResult } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { isElectron } from "../../env";
import { ensureLocalApi } from "../../localApi";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useServerConfigs } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { serverEnvironment } from "../../state/server";
import { stackedThreadToast, toastManager } from "../ui/toast";

const p2codeUpdateProgressAtom = Atom.make<P2codeUpdateResult | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("web-p2code-update-progress"),
);

export function useP2codeUpdateProgress(): P2codeUpdateResult | null {
  return useAtomValue(p2codeUpdateProgressAtom);
}

export function useP2codeAvailable(): boolean {
  const environmentId = usePrimaryEnvironmentId();
  const serverConfigs = useServerConfigs();
  return (
    environmentId != null &&
    serverConfigs.get(environmentId)?.environment.capabilities.p2codeUpdate === true
  );
}

const report = (type: "info" | "error" | "success", title: string, description: string) =>
  toastManager.add(stackedThreadToast({ type, title, description }));

function makeCall(): P2codeUpdateCall {
  return async (action) => {
    const environmentId = appAtomRegistry.get(primaryEnvironmentIdAtom);
    if (environmentId === null) throw new Error("No T3 Code server is connected.");
    const result = await serverEnvironment.p2codeUpdate.run(appAtomRegistry, {
      environmentId,
      input: action === "start" && isElectron ? { action, relaunchApp: true } : { action },
    });
    if (result._tag !== "Success") throw squashAtomCommandFailure(result);
    return result.value;
  };
}

function reportOutcome(result: P2codeUpdateResult) {
  if (result.phase === "conflict") {
    report(
      "info",
      "Merge conflicts",
      "A thread is resolving them and will continue the update when it is done.",
    );
  } else if (result.phase === "failed") {
    report("error", "Update failed", describeP2codeUpdate(result) ?? "The update failed.");
  } else {
    report("success", "p2code updated", result.message ?? "T3 Code is up to date.");
  }
}

let inFlight = false;

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
