import { cloudSpeechDisclosure } from "@t3tools/shared/speech";
import { setCloudSpeechEndpoint } from "@t3tools/client-runtime/voice-input";
import {
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  CLOUD_SPEECH_LABELS,
  CloudSpeechEndpoint,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useId, useState } from "react";
import { runEnvironmentSpeech } from "../../speech/runEnvironmentSpeech";
import { chooseAudioDestination, pendingCloudAudioChoice } from "../../speech/voiceConsent";
import type { EnvironmentPresentation } from "../../state/environments";
import { useEnvironmentScope, usePreparedConnection } from "../../state/session";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

const isEndpoint = Schema.is(CloudSpeechEndpoint);

export function CustomVoiceConfiguration({
  environment,
  active,
  close,
}: {
  environment: Pick<EnvironmentPresentation, "environmentId" | "label" | "serverConfig">;
  active: boolean;
  close: () => void;
}) {
  const id = environment.environmentId;
  const formId = useId();
  const prepared = Option.getOrNull(usePreparedConnection(id));
  const canUse = useEnvironmentScope(id, AuthOrchestrationOperateScope);
  const canManage = useEnvironmentScope(id, AuthSettingsWriteScope);
  const stored = environment.serverConfig?.settings?.cloudSpeechCustomUrl ?? "";
  const [draft, setDraft] = useState(stored);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const url = draft.trim();
  const connected = canUse && prepared !== null;
  const valid = isEndpoint(url);
  const destination = { kind: "cloud", provider: "custom", environmentId: id } as const;

  const save = async (next: string | null) => {
    if (!connected || !canManage || busy) return;
    setError("");
    setBusy(true);
    try {
      const commit = next !== null && !active ? pendingCloudAudioChoice(destination) : null;
      await runEnvironmentSpeech(setCloudSpeechEndpoint(prepared, next));
      commit?.();
      close();
    } catch {
      setError("Couldn’t save this change. Check your connection and try again.");
    }
    setBusy(false);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
    >
      <DialogPopup className="max-w-md" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>
            {active ? `Manage ${CLOUD_SPEECH_LABELS.custom}` : `Use ${CLOUD_SPEECH_LABELS.custom}?`}
          </DialogTitle>
          <DialogDescription>
            {cloudSpeechDisclosure("custom", environment.label)}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {!connected ? (
            <p>Connect to {environment.label} with dictation access to continue.</p>
          ) : canManage ? (
            <form
              id={formId}
              className="grid gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (valid) void save(url);
              }}
            >
              <Label htmlFor="voice-custom-url">Server URL</Label>
              <Input
                id="voice-custom-url"
                aria-label="Speech server URL"
                placeholder="http://127.0.0.1:8765/v1"
                value={draft}
                disabled={busy}
                autoFocus
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setDraft(event.target.value)}
              />
              <p className="text-sm text-muted-foreground">
                An OpenAI-compatible server reachable from {environment.label}. T3 Code posts
                recordings to its <code>/audio/transcriptions</code> endpoint.
              </p>
            </form>
          ) : stored ? (
            <p className="text-sm text-muted-foreground">
              Uses the speech server set up on {environment.label}. This choice applies only to this
              device.
            </p>
          ) : (
            <p>Ask an administrator on {environment.label} to set a speech server URL.</p>
          )}
        </DialogPanel>
        {error && (
          <p className="px-6 text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        <DialogFooter>
          {connected && canManage && stored && (
            <div className="sm:mr-auto">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void save(null)}
              >
                Remove URL
              </Button>
            </div>
          )}
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={close}>
            Cancel
          </Button>
          {connected && canManage ? (
            <Button
              type="submit"
              form={formId}
              size="sm"
              disabled={busy || !valid || (active && url === stored)}
            >
              {active ? "Save" : "Save and enable"}
            </Button>
          ) : connected && stored && !active ? (
            <Button
              type="button"
              size="sm"
              onClick={() => {
                chooseAudioDestination(destination);
                close();
              }}
            >
              Use {CLOUD_SPEECH_LABELS.custom}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
