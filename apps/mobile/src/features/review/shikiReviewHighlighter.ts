import type { ReviewRenderableLineRow } from "./reviewModel";
import type { ReviewHighlightedToken } from "./reviewHighlightedToken.types";
import { applyDiffRangesToTokens, computeWordAltDiffRanges } from "./reviewWordDiffs";
import { tokenizeOnWorker } from "./shikiWorker";

export type ReviewDiffTheme = "light" | "dark";

export type { ReviewHighlightedToken } from "./reviewHighlightedToken.types";

const SHIKI_THEME_NAME_BY_SCHEME = {
  light: "github-light-default",
  dark: "github-dark-default",
} as const;

function stripTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value.slice(0, -1) : value;
}

function joinPatchLines(lines: ReadonlyArray<string>): string {
  return lines.map(stripTrailingNewline).join("\n");
}

function applyWordAltDiffHighlightsToSelectedLines(input: {
  readonly lines: ReadonlyArray<ReviewRenderableLineRow>;
  readonly tokenMap: Record<string, ReadonlyArray<ReviewHighlightedToken>>;
}): Record<string, ReadonlyArray<ReviewHighlightedToken>> {
  const additionLineByTokenIndex = new Map<number, ReviewRenderableLineRow>();
  const deletionLineByTokenIndex = new Map<number, ReviewRenderableLineRow>();

  input.lines.forEach((line) => {
    if (line.change === "add" && line.additionTokenIndex !== null) {
      additionLineByTokenIndex.set(line.additionTokenIndex, line);
    }
    if (line.change === "delete" && line.deletionTokenIndex !== null) {
      deletionLineByTokenIndex.set(line.deletionTokenIndex, line);
    }
  });

  const nextTokenMap = { ...input.tokenMap };
  const processedPairs = new Set<string>();

  input.lines.forEach((line) => {
    if (line.change === "context" || !line.comparison) {
      return;
    }

    const pairedDeletionLine =
      line.change === "delete"
        ? line
        : line.comparison.change === "delete"
          ? deletionLineByTokenIndex.get(line.comparison.tokenIndex)
          : undefined;
    const pairedAdditionLine =
      line.change === "add"
        ? line
        : line.comparison.change === "add"
          ? additionLineByTokenIndex.get(line.comparison.tokenIndex)
          : undefined;

    if (
      !pairedDeletionLine ||
      !pairedAdditionLine ||
      pairedDeletionLine.deletionTokenIndex === null ||
      pairedAdditionLine.additionTokenIndex === null
    ) {
      return;
    }

    const pairKey = `${pairedDeletionLine.deletionTokenIndex}:${pairedAdditionLine.additionTokenIndex}`;
    if (processedPairs.has(pairKey)) {
      return;
    }
    processedPairs.add(pairKey);

    const ranges = computeWordAltDiffRanges({
      deletionLine: pairedDeletionLine.content,
      additionLine: pairedAdditionLine.content,
    });

    if (ranges.deletion.length > 0) {
      nextTokenMap[pairedDeletionLine.id] = applyDiffRangesToTokens(
        nextTokenMap[pairedDeletionLine.id] ?? [],
        ranges.deletion,
      );
    }
    if (ranges.addition.length > 0) {
      nextTokenMap[pairedAdditionLine.id] = applyDiffRangesToTokens(
        nextTokenMap[pairedAdditionLine.id] ?? [],
        ranges.addition,
      );
    }
  });

  return nextTokenMap;
}

async function highlightLines(input: {
  readonly code: string;
  readonly path: string;
  readonly languageHint: string | null;
  readonly theme: ReviewDiffTheme;
}): Promise<ReadonlyArray<ReadonlyArray<ReviewHighlightedToken>>> {
  if (input.code.length === 0) {
    return [];
  }
  return tokenizeOnWorker({
    code: input.code,
    path: input.path,
    languageHint: input.languageHint,
    theme: SHIKI_THEME_NAME_BY_SCHEME[input.theme],
  });
}

export function highlightCodeSnippet(input: {
  readonly code: string;
  readonly language?: string | null;
  readonly theme: ReviewDiffTheme;
}): Promise<ReadonlyArray<ReadonlyArray<ReviewHighlightedToken>>> {
  const languageHint = input.language?.trim() || "text";
  return highlightLines({
    code: input.code,
    path: `snippet.${languageHint}`,
    languageHint,
    theme: input.theme,
  });
}

export function highlightSourceFile(input: {
  readonly path: string;
  readonly contents: string;
  readonly theme: ReviewDiffTheme;
}): Promise<ReadonlyArray<ReadonlyArray<ReviewHighlightedToken>>> {
  return highlightLines({
    code: input.contents,
    path: input.path,
    languageHint: null,
    theme: input.theme,
  });
}

export async function highlightReviewSelectedLines(input: {
  readonly filePath: string;
  readonly lines: ReadonlyArray<ReviewRenderableLineRow>;
  readonly theme: ReviewDiffTheme;
  readonly languageHint?: string | null;
}): Promise<Record<string, ReadonlyArray<ReviewHighlightedToken>>> {
  if (input.lines.length === 0) {
    return {};
  }

  const additionLikeLines: string[] = [];
  const deletionLines: string[] = [];
  for (const line of input.lines) {
    if (line.change === "delete") {
      deletionLines.push(`${line.content}\n`);
    } else {
      additionLikeLines.push(`${line.content}\n`);
    }
  }
  const request = {
    path: input.filePath,
    languageHint: input.languageHint ?? null,
    theme: input.theme,
  };
  const [additionTokens, deletionTokens] = await Promise.all([
    highlightLines({ ...request, code: joinPatchLines(additionLikeLines) }),
    highlightLines({ ...request, code: joinPatchLines(deletionLines) }),
  ]);

  const tokenMap: Record<string, ReadonlyArray<ReviewHighlightedToken>> = {};
  let additionIndex = 0;
  let deletionIndex = 0;

  input.lines.forEach((line) => {
    if (line.change === "delete") {
      tokenMap[line.id] = deletionTokens[deletionIndex] ?? [];
      deletionIndex += 1;
      return;
    }

    tokenMap[line.id] = additionTokens[additionIndex] ?? [];
    additionIndex += 1;
  });

  return applyWordAltDiffHighlightsToSelectedLines({
    lines: input.lines,
    tokenMap,
  });
}
