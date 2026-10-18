import type { Wakeups } from "@t3tools/client-runtime/connection";
import type { PlatformOSType } from "react-native";

export const ANDROID_BACKGROUND_PAUSE_AFTER_MS = 10_000;
export const ANDROID_BACKGROUND_RECONNECT_AFTER_MS = 60_000;
export const MOBILE_BACKGROUND_RECONNECT_AFTER_MS = 10_000;

export type MobileApplicationActiveWakeup = Extract<
  Wakeups.ConnectionWakeup,
  "application-active-probe" | "application-active-long"
>;

export function mobileBackgroundReconnectAfterMs(os: PlatformOSType): number {
  return os === "android"
    ? ANDROID_BACKGROUND_RECONNECT_AFTER_MS
    : MOBILE_BACKGROUND_RECONNECT_AFTER_MS;
}

export function mobileApplicationActiveWakeup(
  backgroundedAtMs: number | null,
  activeAtMs: number,
  os: PlatformOSType,
): MobileApplicationActiveWakeup {
  return backgroundedAtMs !== null &&
    activeAtMs - backgroundedAtMs >= mobileBackgroundReconnectAfterMs(os)
    ? "application-active-long"
    : "application-active-probe";
}
