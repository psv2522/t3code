import Constants from "expo-constants";
import { requireOptionalNativeModule } from "expo";
import { Linking, Platform } from "react-native";

interface AndroidAgentNotifications {
  configure(deviceId: string, userId: string, scheme: string, ongoingEnabled: boolean): void;
  clear(): void;
  setThreadOnScreen?(path: string | null): void;
  openLiveUpdateSettings?(): boolean;
  showShowcaseActivity?(scheme: string, data: Record<string, string>): void;
  setLocalUpdatesEnabled?(enabled: boolean, scheme: string): void;
  showLocalActivity?(scheme: string, data: Record<string, string>): void;
  startBackgroundWatch?(): boolean;
  stopBackgroundWatch?(): void;
  isIgnoringBatteryOptimizations?(): boolean;
  requestIgnoreBatteryOptimizations?(): boolean;
  addListener?(event: "onWatchTick", listener: () => void): { remove(): void };
}

const native =
  Platform.OS === "android"
    ? requireOptionalNativeModule<AndroidAgentNotifications>("T3AgentNotifications")
    : null;

export function supportsAndroidAgentNotifications(): boolean {
  return typeof native?.configure === "function" && typeof native?.clear === "function";
}

function appScheme(): string {
  const scheme = Constants.expoConfig?.scheme;
  return (Array.isArray(scheme) ? scheme[0] : scheme) ?? "t3code";
}

export function configureAndroidAgentNotifications(
  deviceId: string,
  userId: string,
  ongoingEnabled: boolean,
): void {
  native?.configure?.(deviceId, userId, appScheme(), ongoingEnabled);
}

export function showAndroidShowcaseAgentActivity(data: Record<string, string>): boolean {
  if (!native?.showShowcaseActivity) return false;
  native.showShowcaseActivity(appScheme(), data);
  return true;
}

export function clearAndroidAgentNotifications(): void {
  native?.clear?.();
}

export function setAndroidThreadOnScreen(path: string | null): void {
  native?.setThreadOnScreen?.(path);
}

export function supportsAndroidLiveUpdateSettings(): boolean {
  return Platform.OS === "android" && Number(Platform.Version) >= 36;
}

export async function openAndroidLiveUpdateSettings(): Promise<void> {
  if (!native?.openLiveUpdateSettings?.()) {
    await Linking.openSettings();
  }
}

export function supportsAndroidBackgroundWatch(): boolean {
  return typeof native?.startBackgroundWatch === "function";
}

export function setAndroidLocalUpdatesEnabled(enabled: boolean): void {
  native?.setLocalUpdatesEnabled?.(enabled, appScheme());
}

export function showAndroidLocalActivity(data: Record<string, string>): void {
  native?.showLocalActivity?.(appScheme(), data);
}

export function startAndroidBackgroundWatch(): boolean {
  return native?.startBackgroundWatch?.() ?? false;
}

export function stopAndroidBackgroundWatch(): void {
  native?.stopBackgroundWatch?.();
}

export function androidIgnoresBatteryOptimizations(): boolean {
  return native?.isIgnoringBatteryOptimizations?.() ?? true;
}

export function requestAndroidBatteryOptimizationExemption(): boolean {
  return native?.requestIgnoreBatteryOptimizations?.() ?? false;
}

export function onAndroidBackgroundWatchTick(listener: () => void): () => void {
  const subscription = native?.addListener?.("onWatchTick", listener);
  return () => subscription?.remove();
}
