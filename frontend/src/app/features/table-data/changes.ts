import type { Cell, TableChange, TableColumn } from '../../core/models';

/** A grid row of the data editor. `undefined` in a new row means "use the column default". */
export interface GridRow {
  id: string;
  isNew: boolean;
  original: Cell[];
  cells: (Cell | undefined)[];
}

/** Keeps the original value when an edit only changes its text form ("36" for 36). */
export function normalizeEdit(
  row: GridRow,
  columnIndex: number,
  value: Cell | undefined,
): Cell | undefined {
  if (row.isNew || value === null || value === undefined) return value;
  const original = row.original[columnIndex];
  return original !== null && String(original) === String(value) ? original : value;
}

export function isChanged(row: GridRow, columnIndex: number): boolean {
  return !row.isNew && !Object.is(row.cells[columnIndex], row.original[columnIndex]);
}

export function rowChanged(row: GridRow): boolean {
  return row.cells.some((_, columnIndex) => isChanged(row, columnIndex));
}

/** The primary key of a row, as a column → value object. */
function primaryKey(columns: TableColumn[], row: GridRow): Record<string, Cell> {
  return Object.fromEntries(
    columns.flatMap((column, columnIndex) =>
      column.pk ? [[column.name, row.original[columnIndex]]] : [],
    ),
  );
}

/** Turns the grid state into the change list sent to the backend. */
export function buildChanges(
  columns: TableColumn[],
  rows: GridRow[],
  deletedRowIds: ReadonlySet<string>,
): TableChange[] {
  const changes: TableChange[] = [];
  for (const row of rows) {
    if (row.isNew) {
      if (deletedRowIds.has(row.id)) continue;
      const values: Record<string, Cell> = {};
      row.cells.forEach((cell, columnIndex) => {
        if (cell !== undefined) values[columns[columnIndex].name] = cell;
      });
      changes.push({ op: 'insert', values });
    } else if (deletedRowIds.has(row.id)) {
      changes.push({ op: 'delete', key: primaryKey(columns, row) });
    } else if (rowChanged(row)) {
      const values: Record<string, Cell> = {};
      row.cells.forEach((cell, columnIndex) => {
        if (isChanged(row, columnIndex)) values[columns[columnIndex].name] = cell ?? null;
      });
      changes.push({ op: 'update', key: primaryKey(columns, row), values });
    }
  }
  return changes;
}

/** SQL literal for previews only (execution always uses bound parameters). */
function literal(value: Cell): string {
  if (value === null) return 'NULL';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return `'${value.replace(/'/g, "''")}'`;
}

/** Human-readable statements for the pending changes, shown before Apply. */
export function previewSQL(
  changes: TableChange[],
  target: string,
  quoteIdentifier: (name: string) => string,
): string[] {
  const whereClause = (key: Record<string, Cell> = {}) =>
    Object.entries(key)
      .map(([columnName, value]) => `${quoteIdentifier(columnName)} = ${literal(value)}`)
      .join(' AND ');
  return changes.map((change) => {
    const values = Object.entries(change.values ?? {});
    switch (change.op) {
      case 'insert':
        return values.length
          ? `INSERT INTO ${target} (${values.map(([columnName]) => quoteIdentifier(columnName)).join(', ')})\n` +
              `VALUES (${values.map(([, value]) => literal(value)).join(', ')});`
          : `INSERT INTO ${target} DEFAULT VALUES;`;
      case 'update':
        return (
          `UPDATE ${target}\n` +
          `SET ${values.map(([columnName, value]) => `${quoteIdentifier(columnName)} = ${literal(value)}`).join(', ')}\n` +
          `WHERE ${whereClause(change.key)};`
        );
      case 'delete':
        return `DELETE FROM ${target}\nWHERE ${whereClause(change.key)};`;
    }
  });
}
