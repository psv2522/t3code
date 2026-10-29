import { expect, it } from "vite-plus/test";
import { selectableProviderOptionChoices } from "./modelTraits.ts";

it("toggles the highest reasoning levels together without hiding unrelated model options", () => {
  const descriptor = {
    id: "reasoningEffort",
    label: "Reasoning",
    type: "select" as const,
    options: ["high", "xhigh", "max", "ultra", "ultracode", "ultrathink"].map((id) => ({
      id,
      label: id,
    })),
  };
  for (const id of [
    "reasoningEffort",
    "effort",
    "reasoning",
    "variant",
    "reasoning_effort",
    "thinking",
  ]) {
    expect(
      selectableProviderOptionChoices({ ...descriptor, id }, false).map((option) => option.id),
    ).toEqual(["high", "xhigh"]);
    expect(selectableProviderOptionChoices({ ...descriptor, id }, true)).toEqual(
      descriptor.options,
    );
  }
  expect(selectableProviderOptionChoices(descriptor)).toEqual(descriptor.options);
  expect(selectableProviderOptionChoices({ ...descriptor, id: "serviceTier" }, false)).toEqual(
    descriptor.options,
  );
});
