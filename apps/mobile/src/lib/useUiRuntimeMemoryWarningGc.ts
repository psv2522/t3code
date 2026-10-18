import { Image } from "expo-image";
import { AppState, Platform } from "react-native";
import { scheduleOnUI } from "react-native-worklets";

function collectUiRuntimeGarbage() {
  "worklet";
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc === "function") gc();
}

/**
 * iOS memory warnings collect only RN's heap; collect worklets too to release shadow nodes and serializables.
 * Android never emits memoryWarning, so it trims on background instead.
 */
export function installUiRuntimeMemoryWarningGc(): () => void {
  const subscription =
    Platform.OS === "android"
      ? AppState.addEventListener("change", (state) => {
          if (state !== "background") return;
          scheduleOnUI(collectUiRuntimeGarbage);
          void Image.clearMemoryCache().catch(() => undefined);
        })
      : AppState.addEventListener("memoryWarning", () => {
          scheduleOnUI(collectUiRuntimeGarbage);
        });
  return () => subscription.remove();
}
