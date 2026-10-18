import { Image } from "expo-image";
import { useEffect } from "react";
import { AppState, Platform } from "react-native";
import { scheduleOnUI } from "react-native-worklets";

function collectUiRuntimeGarbage() {
  "worklet";
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc === "function") gc();
}

/**
 * React Native only collects the main JS runtime on an iOS memory warning. The
 * worklets UI runtime is a separate Hermes heap that holds native shadow nodes and
 * serializables alive until its own GC runs, so collect it on the same warning.
 * Android never emits memoryWarning, so it trims on background instead.
 */
export function useUiRuntimeMemoryWarningGc() {
  useEffect(() => {
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
  }, []);
}
