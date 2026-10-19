import { useRef, useState, type CSSProperties } from "react";
import { ImageIcon } from "lucide-react";

import {
  clearMainBackgroundImage,
  DEFAULT_MAIN_BACKGROUND_OPACITY,
  MAX_MAIN_BACKGROUND_OPACITY,
  MIN_MAIN_BACKGROUND_OPACITY,
  setMainBackgroundImage,
  setMainBackgroundOpacity,
  useMainBackground,
} from "../../mainBackground";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { searchableSetting } from "./settingsSearch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";

function reportFailure(title: string, error: unknown) {
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : "An error occurred.",
  });
}

export function BackgroundImageSettings() {
  const { imageUrl, opacity } = useMainBackground();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isLoading, setIsLoading] = useState(false);
  const opacityRatio =
    (opacity - MIN_MAIN_BACKGROUND_OPACITY) /
    (MAX_MAIN_BACKGROUND_OPACITY - MIN_MAIN_BACKGROUND_OPACITY);
  const opacitySliderStyle = {
    "--settings-slider-progress": `${opacityRatio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - opacityRatio}rem`,
  } as CSSProperties;

  const chooseImage = async (file: File) => {
    setIsLoading(true);
    try {
      await setMainBackgroundImage(file);
    } catch (error) {
      reportFailure("Couldn’t use that image", error);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <SettingsSection id="appearance-background" title="Background">
      <SettingsRow
        {...searchableSetting("background-image")}
        description="Show a dithered, grainy image behind new threads until the first message is sent."
        resetAction={
          imageUrl ? (
            <SettingResetButton
              label="background image"
              tooltip="Remove image"
              onClick={() =>
                void clearMainBackgroundImage().catch((error: unknown) =>
                  reportFailure("Couldn’t remove the background image", error),
                )
              }
            />
          ) : null
        }
        control={
          <div className="flex items-center gap-2">
            {imageUrl ? (
              <img
                alt=""
                className="h-7 w-12 rounded-md border border-border/70 object-cover [image-rendering:pixelated]"
                src={imageUrl}
              />
            ) : null}
            <input
              ref={fileInputRef}
              accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
              className="sr-only"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (file) void chooseImage(file);
              }}
              tabIndex={-1}
              type="file"
            />
            <Button
              disabled={isLoading}
              size="sm"
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
            >
              <ImageIcon />
              {isLoading ? "Processing…" : imageUrl ? "Change…" : "Choose image…"}
            </Button>
          </div>
        }
      />

      {imageUrl ? (
        <SettingsRow
          title="Background visibility"
          description="Lower values keep the image subtle behind text."
          resetAction={
            opacity !== DEFAULT_MAIN_BACKGROUND_OPACITY ? (
              <SettingResetButton
                label="background visibility"
                onClick={() => setMainBackgroundOpacity(DEFAULT_MAIN_BACKGROUND_OPACITY)}
              />
            ) : null
          }
          control={
            <div className="flex w-full items-center gap-3 sm:w-52">
              <output
                className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
                htmlFor="background-visibility-slider"
              >
                {opacity}%
              </output>
              <input
                aria-label="Background visibility"
                className="settings-slider min-w-0 flex-1"
                id="background-visibility-slider"
                max={MAX_MAIN_BACKGROUND_OPACITY}
                min={MIN_MAIN_BACKGROUND_OPACITY}
                onChange={(event) => setMainBackgroundOpacity(Number(event.currentTarget.value))}
                step={5}
                style={opacitySliderStyle}
                type="range"
                value={opacity}
              />
            </div>
          }
        />
      ) : null}
    </SettingsSection>
  );
}
