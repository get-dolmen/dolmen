import type { Cell } from '../core/models';

/** A cell never shows more than this: long text would be laid out in full on every scroll. */
const MAX_SHOWN_CHARACTERS = 500;

/** Plain text for copying or exporting: NULL and undefined become empty. */
export function cellText(value: Cell | undefined): string {
  return value === null || value === undefined ? '' : String(value);
}

/** Text shown in a grid cell. Copy, export and tooltips read the full value. */
export function displayCell(value: Cell | undefined): string {
  if (value === null || value === undefined) return 'NULL';
  const text = String(value);
  return text.length > MAX_SHOWN_CHARACTERS ? `${text.slice(0, MAX_SHOWN_CHARACTERS)}…` : text;
}
