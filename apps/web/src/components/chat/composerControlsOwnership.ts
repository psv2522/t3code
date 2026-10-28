export function resolveComposerControlsOwnership(input: {
  readonly hasTraits: boolean;
  readonly measuredHiddenBlockCount: number;
}) {
  const blockIds = ["mode", ...(input.hasTraits ? ["traits"] : [])];
  const hiddenBlockCount = Math.min(input.measuredHiddenBlockCount, blockIds.length);
  const hiddenBlockIds = blockIds.slice(blockIds.length - hiddenBlockCount);
  return {
    showModeBlock: true,
    hiddenBlockCount,
    hiddenBlockIds,
    traitsHidden: hiddenBlockIds.includes("traits"),
    overflowShowsPermissions: hiddenBlockIds.includes("mode"),
  };
}
