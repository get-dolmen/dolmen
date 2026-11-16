import type { Cell, ResultColumn } from '../../core/models';
import { cellText } from '../../shared/cell';

/** Tab-separated text suitable for pasting into a spreadsheet. NULL becomes empty. */
export function rowsToTSV(columns: ResultColumn[], rows: Cell[][], header: boolean): string {
  const cleanCell = (cell: Cell) => cellText(cell).replace(/[\t\r\n]+/g, ' ');
  const lines = rows.map((row) => row.map(cleanCell).join('\t'));
  if (header) lines.unshift(columns.map((column) => cleanCell(column.name)).join('\t'));
  return lines.join('\n');
}
