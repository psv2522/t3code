import { tokenizeOnWorker } from "../review/shikiWorker";
import type { NativeReviewDiffFile } from "./nativeReviewDiffTypes";
import type { NativeReviewDiffRow, NativeReviewDiffToken } from "./nativeReviewDiffSurface";

export type NativeReviewDiffHighlightScheme = "light" | "dark";

interface NativeReviewDiffLineRow extends NativeReviewDiffRow {
  readonly kind: "line";
  readonly fileId: string;
  readonly content: string;
}

interface IndexedNativeReviewDiffLineRow {
  readonly row: NativeReviewDiffLineRow;
  readonly rowIndex: number;
}

export interface HighlightNativeReviewDiffVisibleRowsInput {
  readonly rows: ReadonlyArray<NativeReviewDiffRow>;
  readonly files: ReadonlyArray<NativeReviewDiffFile>;
  readonly scheme: NativeReviewDiffHighlightScheme;
  readonly firstRowIndex: number;
  readonly lastRowIndex: number;
  readonly overscanRows?: number;
  readonly maxRows?: number;
  readonly alreadyHighlightedRowIds?: ReadonlySet<string>;
  readonly signal?: AbortSignal;
}

const NATIVE_REVIEW_DIFF_VISIBLE_OVERSCAN_ROWS = 160;
const NATIVE_REVIEW_DIFF_VISIBLE_MAX_ROWS = 360;

const NATIVE_REVIEW_DIFF_THEME_NAME_BY_SCHEME = {
  dark: "t3-pierre-dark",
  light: "t3-pierre-light",
} as const;

function isHighlightableLineRow(row: NativeReviewDiffRow): row is NativeReviewDiffLineRow {
  return row.kind === "line" && typeof row.fileId === "string" && typeof row.content === "string";
}

function hasConsecutiveLineNumbers(
  previous: number | null | undefined,
  next: number | null | undefined,
): boolean {
  return typeof previous === "number" && typeof next === "number" && next === previous + 1;
}

function hasOnlyCommentRowsBetween(
  rows: ReadonlyArray<NativeReviewDiffRow>,
  previousRowIndex: number,
  nextRowIndex: number,
): boolean {
  for (let rowIndex = previousRowIndex + 1; rowIndex < nextRowIndex; rowIndex += 1) {
    if (rows[rowIndex]?.kind !== "comment") {
      return false;
    }
  }
  return true;
}

function canShareGrammarContext(
  previous: IndexedNativeReviewDiffLineRow,
  next: IndexedNativeReviewDiffLineRow,
  rows: ReadonlyArray<NativeReviewDiffRow>,
): boolean {
  if (
    next.row.fileId !== previous.row.fileId ||
    !hasOnlyCommentRowsBetween(rows, previous.rowIndex, next.rowIndex)
  ) {
    return false;
  }

  if (previous.row.change === "delete" || next.row.change === "delete") {
    return (
      previous.row.change !== "add" &&
      next.row.change !== "add" &&
      hasConsecutiveLineNumbers(previous.row.oldLineNumber, next.row.oldLineNumber)
    );
  }

  if (previous.row.change === "add" || next.row.change === "add") {
    return hasConsecutiveLineNumbers(previous.row.newLineNumber, next.row.newLineNumber);
  }

  return (
    previous.row.change === "context" &&
    next.row.change === "context" &&
    hasConsecutiveLineNumbers(previous.row.oldLineNumber, next.row.oldLineNumber) &&
    hasConsecutiveLineNumbers(previous.row.newLineNumber, next.row.newLineNumber)
  );
}

function createFileMap(files: ReadonlyArray<NativeReviewDiffFile>) {
  return new Map(files.map((file) => [file.id, file]));
}

function clampRowIndex(index: number, rows: ReadonlyArray<NativeReviewDiffRow>) {
  if (rows.length === 0) {
    return 0;
  }

  return Math.min(rows.length - 1, Math.max(0, Math.floor(index)));
}

function makePlainTokenFallback(
  row: NativeReviewDiffLineRow,
): ReadonlyArray<NativeReviewDiffToken> {
  return [{ content: row.content || " ", color: null, fontStyle: null }];
}

export async function highlightNativeReviewDiffVisibleRows(
  input: HighlightNativeReviewDiffVisibleRowsInput,
): Promise<{
  readonly tokensByRowId: Record<string, ReadonlyArray<NativeReviewDiffToken>>;
  readonly rowCount: number;
  readonly durationMs: number;
}> {
  if (input.signal?.aborted) {
    return { tokensByRowId: {}, rowCount: 0, durationMs: 0 };
  }

  const startedAt = performance.now();
  const theme = NATIVE_REVIEW_DIFF_THEME_NAME_BY_SCHEME[input.scheme];
  const fileMap = createFileMap(input.files);
  const overscanRows = input.overscanRows ?? NATIVE_REVIEW_DIFF_VISIBLE_OVERSCAN_ROWS;
  const maxRows = input.maxRows ?? NATIVE_REVIEW_DIFF_VISIBLE_MAX_ROWS;
  const startIndex = clampRowIndex(input.firstRowIndex - overscanRows, input.rows);
  const endIndex = clampRowIndex(input.lastRowIndex + overscanRows, input.rows);
  const selectedRows: IndexedNativeReviewDiffLineRow[] = [];

  for (
    let rowIndex = startIndex;
    rowIndex <= endIndex && selectedRows.length < maxRows;
    rowIndex += 1
  ) {
    const row = input.rows[rowIndex];
    if (
      row &&
      isHighlightableLineRow(row) &&
      !input.alreadyHighlightedRowIds?.has(row.id) &&
      fileMap.has(row.fileId)
    ) {
      selectedRows.push({ row, rowIndex });
    }
  }

  const tokensByRowId: Record<string, ReadonlyArray<NativeReviewDiffToken>> = {};
  let segmentRows: IndexedNativeReviewDiffLineRow[] = [];
  let segmentFile: NativeReviewDiffFile | undefined;

  const flushSegment = async () => {
    if (!segmentFile || segmentRows.length === 0 || input.signal?.aborted) {
      segmentRows = [];
      segmentFile = undefined;
      return;
    }

    const tokenLines = await tokenizeOnWorker(
      {
        code: segmentRows.map(({ row }) => row.content).join("\n"),
        path: segmentFile.path,
        languageHint: segmentFile.language,
        theme,
      },
      input.signal,
    );
    segmentRows.forEach(({ row }, rowIndex) => {
      tokensByRowId[row.id] = tokenLines[rowIndex] ?? makePlainTokenFallback(row);
    });
    segmentRows = [];
    segmentFile = undefined;
  };

  for (const selectedRow of selectedRows) {
    if (input.signal?.aborted) break;
    const { row } = selectedRow;
    const file = fileMap.get(row.fileId);
    if (!file) {
      continue;
    }

    const previousRow = segmentRows.at(-1);
    if (
      segmentFile &&
      (segmentFile.id !== file.id ||
        (previousRow !== undefined &&
          !canShareGrammarContext(previousRow, selectedRow, input.rows)))
    ) {
      await flushSegment();
    }

    segmentFile = file;
    segmentRows.push(selectedRow);
  }
  await flushSegment();

  if (input.signal?.aborted) {
    return { tokensByRowId: {}, rowCount: 0, durationMs: 0 };
  }

  return {
    tokensByRowId,
    rowCount: selectedRows.length,
    durationMs: Math.round(performance.now() - startedAt),
  };
}
