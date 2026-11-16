import { themeQuartz } from 'ag-grid-community';
import type { Cell } from '../core/models';

/** AG Grid themed from the app's CSS tokens, so light/dark follow automatically. */
export const gridTheme = themeQuartz.withParams({
  backgroundColor: 'var(--bg-panel)',
  foregroundColor: 'var(--text)',
  headerBackgroundColor: 'var(--bg)',
  headerTextColor: 'var(--text-muted)',
  borderColor: 'var(--border)',
  accentColor: 'var(--accent)',
  chromeBackgroundColor: 'var(--bg)',
  oddRowBackgroundColor: 'var(--bg-hover)',
  selectedRowBackgroundColor: 'var(--accent-soft)',
  rowHoverColor: 'var(--bg-hover)',
  fontFamily: 'var(--font-mono)',
  headerFontFamily: 'var(--font-ui)',
  headerFontWeight: 600,
  cellFontWeight: 400,
  fontSize: 12,
  rowHeight: 26,
  headerHeight: 30,
  spacing: 4,
  cellHorizontalPadding: 10,
  wrapperBorder: false,
  wrapperBorderRadius: 0,
  columnBorder: true,
});

export interface ColumnWidthOptions {
  /** Extra characters added to the header text. */
  headerPadding?: number;
  sampleSize?: number;
  minimum?: number;
  maximum?: number;
}

/** Estimates a column width from its header and a sample of its values. */
export function estimateColumnWidth(
  name: string,
  rows: Cell[][],
  columnIndex: number,
  { headerPadding = 2, sampleSize = 60, minimum = 70, maximum = 420 }: ColumnWidthOptions = {},
): number {
  let characters = name.length + headerPadding;
  for (let rowIndex = 0; rowIndex < Math.min(rows.length, sampleSize); rowIndex++) {
    const value = rows[rowIndex][columnIndex];
    characters = Math.max(characters, value === null ? 4 : String(value).length);
  }
  return Math.min(maximum, Math.max(minimum, characters * 7.4 + 24));
}
