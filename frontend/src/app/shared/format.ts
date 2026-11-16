/** Locale-formatted integer, e.g. "1,204". */
export function formatCount(value: number): string {
  return value.toLocaleString();
}

/** Duration in milliseconds, e.g. "1,204 ms". */
export function formatDuration(milliseconds: number): string {
  return `${formatCount(milliseconds)} ms`;
}

/** "1 row" / "1,204 rows". */
export function formatRowCount(count: number): string {
  return `${formatCount(count)} row${count === 1 ? '' : 's'}`;
}

/** Rows affected by a statement, or "Done" when the driver reported none. */
export function formatAffectedRows(rowsAffected: number): string {
  return rowsAffected >= 0 ? `${formatRowCount(rowsAffected)} affected` : 'Done';
}
