import { expect, it } from "vite-plus/test";
import {
  isDesktopRuntimeExternalDependency,
  selectDesktopRuntimeExternalDependencies,
} from "./desktop-external-packages.ts";

it("stages the updater dependency that the main process loads on demand", () => {
  const dependencies = { "electron-updater": "^6.8.9", effect: "catalog:" };
  expect(isDesktopRuntimeExternalDependency("electron-updater")).toBe(true);
  expect(selectDesktopRuntimeExternalDependencies(dependencies)).toEqual({
    "electron-updater": "^6.8.9",
  });
});
