import { describe, expect, it } from "vite-plus/test";

import { resolveComposerControlsOwnership } from "./composerControlsOwnership";

describe("resolveComposerControlsOwnership", () => {
  it("keeps permissions visible while effort overflows, then moves permissions to overflow", () => {
    const resolve = (count: number) =>
      resolveComposerControlsOwnership({
        hasTraits: true,
        measuredHiddenBlockCount: count,
      });
    expect(resolve(0)).toMatchObject({
      showModeBlock: true,
      hiddenBlockIds: [],
      overflowShowsPermissions: false,
    });
    expect(resolve(1)).toMatchObject({
      hiddenBlockIds: ["traits"],
      traitsHidden: true,
      overflowShowsPermissions: false,
    });
    expect(resolve(2)).toMatchObject({
      hiddenBlockIds: ["mode", "traits"],
      overflowShowsPermissions: true,
    });
  });

  it("keeps a permissions control for models without effort", () => {
    expect(
      resolveComposerControlsOwnership({ hasTraits: false, measuredHiddenBlockCount: 0 }),
    ).toMatchObject({ showModeBlock: true, hiddenBlockIds: [] });
    expect(
      resolveComposerControlsOwnership({ hasTraits: false, measuredHiddenBlockCount: 1 }),
    ).toMatchObject({ hiddenBlockIds: ["mode"], overflowShowsPermissions: true });
  });
});
