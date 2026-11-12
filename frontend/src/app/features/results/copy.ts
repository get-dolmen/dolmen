import type { Cell, ResultColumn } from '../../core/models';
import { rowsToTSV } from './tsv';

export type CopyFormat = 'tsv' | 'csv' | 'json' | 'markdown';

export const COPY_FORMATS: { id: CopyFormat; label: string }[] = [
  { id: 'tsv', label: 'TSV' },
  { id: 'csv', label: 'CSV' },
  { id: 'json', label: 'JSON' },
  { id: 'markdown', label: 'Markdown' },
];

const text = (v: Cell) => (v === null || v === undefined ? '' : String(v));

function csvCell(v: Cell): string {
  const s = text(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function markdownCell(v: Cell): string {
  const s = text(v);
  return s.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
}

/** Formats rows for the clipboard in the chosen format. NULL is empty except in JSON (null). */
export function formatRows(format: CopyFormat, columns: ResultColumn[], rows: Cell[][], header = true): string {
  switch (format) {
    case 'csv': {
      const lines = rows.map((r) => r.map(csvCell).join(','));
      if (header) lines.unshift(columns.map((c) => csvCell(c.name)).join(','));
      return lines.join('\n');
    }
    case 'json':
      return JSON.stringify(
        rows.map((r) => header
          ? Object.fromEntries(columns.map((c, i) => [c.name, r[i] ?? null]))
          : r),
        null,
        2,
      );
    case 'markdown': {
      const lines = rows.map((r) => `| ${r.map(markdownCell).join(' | ')} |`);
      if (header) {
        lines.unshift(`| ${columns.map((c) => markdownCell(c.name)).join(' | ')} |`);
        lines.splice(1, 0, `| ${columns.map(() => '---').join(' | ')} |`);
      }
      return lines.join('\n');
    }
    default:
      return rowsToTSV(columns, rows, header);
  }
}
