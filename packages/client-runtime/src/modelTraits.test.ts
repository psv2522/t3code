import { expect, it } from "vite-plus/test";
import { modelEffortPreferenceKey, selectableProviderOptionChoices } from "./modelTraits.ts";

it("filters disabled reasoning levels without hiding unrelated model options", () => {
  const descriptor = {
    id: "reasoningEffort",
    label: "Reasoning",
    type: "select" as const,
    options: ["high", "max", "ultra"].map((id) => ({ id, label: id })),
  };
  expect(
    selectableProviderOptionChoices(descriptor, ["max", "ultra"]).map((option) => option.id),
  ).toEqual(["high"]);
  expect(selectableProviderOptionChoices(descriptor).map((option) => option.id)).toEqual([
    "high",
    "max",
    "ultra",
  ]);
  expect(
    selectableProviderOptionChoices({ ...descriptor, id: "serviceTier" }, ["max", "ultra"]),
  ).toEqual(descriptor.options);
  expect(modelEffortPreferenceKey("a/b", "c")).not.toBe(modelEffortPreferenceKey("a", "b/c"));
});
