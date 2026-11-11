import type { Cell, ResultColumn } from '../../core/models';

/** Tab-separated text suitable for pasting into a spreadsheet. NULL becomes empty. */
export function rowsToTSV(columns: ResultColumn[], rows: Cell[][], header: boolean): string {
  const clean = (v: Cell) => (v === null ? '' : String(v).replace(/[\t\r\n]+/g, ' '));
  const lines = rows.map((r) => r.map(clean).join('\t'));
  if (header) lines.unshift(columns.map((c) => clean(c.name)).join('\t'));
  return lines.join('\n');
}
