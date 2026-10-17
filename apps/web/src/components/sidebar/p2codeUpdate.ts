import type { DesktopBridge, DesktopP2codeCheckResult } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { ensureLocalApi } from "../../localApi";
import { stackedThreadToast, toastManager } from "../ui/toast";

type P2codeBridge = NonNullable<DesktopBridge["p2code"]>;

export type P2codeCheckOutcome =
  | {
      readonly kind: "toast";
      readonly type: "info" | "error";
      readonly title: string;
      readonly description: string;
    }
  | { readonly kind: "confirm"; readonly message: string };

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

export function resolveP2codeCheckOutcome(result: DesktopP2codeCheckResult): P2codeCheckOutcome {
  switch (result.status) {
    case "up-to-date":
      return {
        kind: "toast",
        type: "info",
        title: "p2code is up to date",
        description: "No new upstream changes, and nothing new in p2code since the last install.",
      };
    case "dirty":
      return {
        kind: "toast",
        type: "info",
        title: "Commit your p2code changes first",
        description: "The p2code repo has uncommitted changes, so an update cannot start.",
      };
    case "error":
      return {
        kind: "toast",
        type: "error",
        title: "Could not check for updates",
        description: result.message ?? "The p2code update check failed.",
      };
    case "available": {
      const changes = [
        ...(result.upstreamCommits > 0
          ? [`${plural(result.upstreamCommits, "new upstream commit")}`]
          : []),
        ...(result.localChanges ? ["p2code changes made since the last install"] : []),
      ];
      return {
        kind: "confirm",
        message: `Update p2code?\n\n${changes.map((change) => `• ${change}`).join("\n")}\n\nThis opens Terminal to sync, build, and install. T3 Code restarts when the install finishes.`,
      };
    }
  }
}

export async function checkAndStartP2codeUpdate(p2code: P2codeBridge): Promise<void> {
  const report = (type: "info" | "error", title: string, description: string) =>
    toastManager.add(stackedThreadToast({ type, title, description }));
  try {
    const outcome = resolveP2codeCheckOutcome(await p2code.check());
    if (outcome.kind === "toast") {
      report(outcome.type, outcome.title, outcome.description);
      return;
    }
    if (!(await ensureLocalApi().dialogs.confirm(outcome.message))) return;
    const started = await p2code.update();
    if (started.started) {
      report(
        "info",
        "Update started in Terminal",
        "Follow the prompts there to finish installing.",
      );
      return;
    }
    report("error", "Could not start the update", started.message ?? "Terminal did not open.");
  } catch (error) {
    report(
      "error",
      "Could not check for updates",
      error instanceof Error ? error.message : "Update check failed.",
    );
  }
}

export function useP2codeAvailable(): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    const p2code = window.desktopBridge?.p2code;
    if (!p2code) return;
    let cancelled = false;
    p2code.isAvailable().then(
      (value) => {
        if (!cancelled) setAvailable(value);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, []);
  return available;
}
