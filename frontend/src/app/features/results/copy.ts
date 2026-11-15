import type { Cell, ResultColumn } from '../../core/models';
import { rowsToTSV } from './tsv';

export type CopyFormat = 'tsv' | 'csv' | 'json' | 'markdown';

export const COPY_FORMATS: { id: CopyFormat; label: string }[] = [
  { id: 'tsv', label: 'TSV' },
  { id: 'csv', label: 'CSV' },
  { id: 'json', label: 'JSON' },
  { id: 'markdown', label: 'Markdown' },
];

const cellText = (cell: Cell) => (cell === null || cell === undefined ? '' : String(cell));

function csvCell(cell: Cell): string {
  const text = cellText(cell);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function markdownCell(cell: Cell): string {
  return cellText(cell).replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
}

/** Formats rows for the clipboard in the chosen format. NULL is empty except in JSON (null). */
export function formatRows(format: CopyFormat, columns: ResultColumn[], rows: Cell[][], header = true): string {
  switch (format) {
    case 'csv': {
      const lines = rows.map((row) => row.map(csvCell).join(','));
      if (header) lines.unshift(columns.map((column) => csvCell(column.name)).join(','));
      return lines.join('\n');
    }
    case 'json':
      return JSON.stringify(
        rows.map((row) => (header
          ? Object.fromEntries(columns.map((column, columnIndex) => [column.name, row[columnIndex] ?? null]))
          : row)),
        null,
        2,
      );
    case 'markdown': {
      const lines = rows.map((row) => `| ${row.map(markdownCell).join(' | ')} |`);
      if (header) {
        lines.unshift(`| ${columns.map((column) => markdownCell(column.name)).join(' | ')} |`);
        lines.splice(1, 0, `| ${columns.map(() => '---').join(' | ')} |`);
      }
      return lines.join('\n');
    }
    default:
      return rowsToTSV(columns, rows, header);
  }
}
