import type { ProviderOptionDescriptor } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildTraitsTriggerDisplay,
  getDescriptorStringValue,
  selectableProviderOptionChoices,
  selectableProviderOptionToggles,
} from "./modelTraits.ts";

describe("buildTraitsTriggerDisplay", () => {
  it.each([
    { currentValue: undefined, defaultValue: undefined, value: null, label: "Thinking" },
    { currentValue: undefined, defaultValue: "high", value: "high", label: "High" },
    { currentValue: "low", defaultValue: undefined, value: "low", label: "Low" },
    { currentValue: "max", defaultValue: "high", value: "max", label: "Max" },
    { id: "effort", currentValue: undefined, defaultValue: undefined, value: null, label: "" },
  ])("labels Pi thinking without inventing a selection: $label ($value)", (input) => {
    const descriptor: Extract<ProviderOptionDescriptor, { type: "select" }> = {
      id: input.id ?? "thinking",
      label: "Thinking",
      type: "select",
      options: ["low", "high", "max"].map((id) => ({
        id,
        label: id[0]!.toUpperCase() + id.slice(1),
        ...(id === input.defaultValue ? { isDefault: true } : {}),
      })),
      ...(input.currentValue ? { currentValue: input.currentValue } : {}),
    };

    expect(
      buildTraitsTriggerDisplay({
        descriptors: [descriptor],
        primarySelectDescriptorId: descriptor.id,
        ultrathinkPromptControlled: false,
      }).label,
    ).toBe(input.label);
    expect(getDescriptorStringValue(descriptor)).toBe(input.value);
  });

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
    const toggle = (id: string, currentValue: boolean) => ({ id, currentValue });
    const toggles = [toggle("fastMode", false), toggle("ultracode", false)];
    expect(selectableProviderOptionToggles(toggles, false).map(({ id }) => id)).toEqual([
      "fastMode",
    ]);
    expect(selectableProviderOptionToggles(toggles, true)).toEqual(toggles);
    expect(selectableProviderOptionToggles([toggle("ultracode", true)], false)).toHaveLength(1);
    expect(selectableProviderOptionChoices(descriptor)).toEqual(descriptor.options);
    expect(selectableProviderOptionChoices({ ...descriptor, id: "serviceTier" }, false)).toEqual(
      descriptor.options,
    );
  });
});
