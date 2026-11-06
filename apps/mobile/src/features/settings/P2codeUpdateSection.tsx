import {
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
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow as SettingsActionRow } from "../../components/ui/ListActionRow";
import { appAtomRegistry } from "../../state/atom-registry";
import { serverEnvironment } from "../../state/server";
import { SettingsSection } from "./components/SettingsSection";

function makeCall(environmentId: EnvironmentId): P2codeUpdateCall {
  return async (action) => {
    const result = await serverEnvironment.p2codeUpdate.run(appAtomRegistry, {
      environmentId,
      input: { action },
    });
    if (result._tag !== "Success") throw squashAtomCommandFailure(result);
    return result.value;
  };
}

async function startAndWatch(
  environmentId: EnvironmentId,
  onProgress: (result: P2codeUpdateResult) => void,
  signal: AbortSignal,
): Promise<string | null> {
  try {
    const call = makeCall(environmentId);
    onProgress(await call("start"));
    await watchP2codeUpdate({ call, onProgress, signal });
    return null;
  } catch (cause) {
    return cause instanceof Error ? cause.message : "The update could not start.";
  }
}

export function P2codeUpdateSection({
  environmentId,
  label,
  version,
  connected,
  allowed,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly version: string | undefined;
  readonly connected: boolean;
  readonly allowed: boolean;
}) {
  const [progress, setProgress] = useState<P2codeUpdateResult | null>(null);
  const [checked, setChecked] = useState<P2codeUpdateResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const watching = useRef<AbortController | null>(null);

  // Attaches to an update another client started, and stops following when the screen leaves.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows a server-side job and aborts on unmount
  useEffect(() => {
    if (!connected || !allowed) return;
    const call = makeCall(environmentId);
    const controller = new AbortController();
    watching.current = controller;
    void call("status").then(
      (status) => {
        if (controller.signal.aborted) return;
        setProgress(status);
        if (isP2codeUpdateRunning(status.phase)) {
          void watchP2codeUpdate({ call, onProgress: setProgress, signal: controller.signal });
        }
      },
      () => undefined,
    );
    return () => controller.abort();
  }, [environmentId, connected, allowed]);

  const running =
    progress?.phase === "syncing" ||
    progress?.phase === "building" ||
    progress?.phase === "installing";
  const outcome = checked === null ? null : resolveP2codeCheck(checked);
  const statusText = progress === null ? null : describeP2codeUpdate(progress);
  const disabled = !connected || !allowed || checking || running;

  async function check() {
    if (disabled) return;
    setChecking(true);
    setError(null);
    const outcome = await makeCall(environmentId)("check").then(
      (result) => ({ result }),
      (cause: unknown) => ({ cause }),
    );
    if ("result" in outcome) {
      setChecked(outcome.result);
    } else {
      setError(outcome.cause instanceof Error ? outcome.cause.message : "The update check failed.");
    }
    setChecking(false);
  }

  function requestUpdate() {
    if (disabled || outcome?.kind !== "available") return;
    Dialog.alert(
      `Update ${label}?`,
      `${outcome.changes.map((change) => `• ${change}`).join("\n")}\n\nIt syncs, builds and installs on that machine. T3 Code restarts and reconnects. Running threads may be interrupted.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Update",
          onPress: () => {
            setError(null);
            watching.current?.abort();
            const controller = new AbortController();
            watching.current = controller;
            void startAndWatch(environmentId, setProgress, controller.signal).then(setError);
          },
        },
      ],
    );
  }

  const failure = error ?? (progress?.phase === "failed" ? statusText : null);

  return (
    <SettingsSection title="T3 Code">
      <View className="gap-1 p-4">
        <Text className="text-base text-foreground">
          {version ? `Version ${version}` : "p2code build"}
        </Text>
        <Text className="text-sm text-foreground-muted">
          {running || progress?.phase === "conflict"
            ? statusText
            : progress?.phase === "done" && progress.message
              ? progress.message
              : outcome?.kind === "available"
                ? outcome.changes.join(" and ")
                : outcome?.kind === "up-to-date"
                  ? "You are up to date."
                  : outcome?.kind === "dirty"
                    ? "Commit the changes in the p2code repo on that machine first."
                    : "Updates come from the p2code repo on that machine."}
        </Text>
        {failure ? (
          <Text selectable accessibilityRole="alert" className="text-sm text-danger-foreground">
            {failure}
          </Text>
        ) : null}
      </View>
      <SettingsActionRow
        icon="arrow.clockwise"
        label="Check for updates"
        disabled={disabled}
        loading={checking}
        onPress={() => void check()}
      />
      {outcome?.kind === "available" ? (
        <SettingsActionRow
          icon="arrow.up.circle"
          label="Update now"
          disabled={disabled}
          loading={running}
          onPress={requestUpdate}
        />
      ) : null}
    </SettingsSection>
  );
}
