import type { Cell, TableChange, TableColumn } from '../../core/models';

/** A grid row of the data editor. `undefined` in a new row means "use the column default". */
export interface GridRow {
  id: string;
  isNew: boolean;
  orig: Cell[];
  cells: (Cell | undefined)[];
}

/** Keeps the original value when an edit only changes its text form ("36" for 36). */
export function normalizeEdit(row: GridRow, i: number, value: Cell | undefined): Cell | undefined {
  if (row.isNew || value === null || value === undefined) return value;
  const o = row.orig[i];
  return o !== null && String(o) === String(value) ? o : value;
}

export function isChanged(row: GridRow, i: number): boolean {
  return !row.isNew && !Object.is(row.cells[i], row.orig[i]);
}

export function rowChanged(row: GridRow): boolean {
  return row.cells.some((_, i) => isChanged(row, i));
}

/** Turns the grid state into the change list sent to the backend. */
export function buildChanges(columns: TableColumn[], rows: GridRow[], deleted: ReadonlySet<string>): TableChange[] {
  const key = (r: GridRow) => Object.fromEntries(columns.flatMap((c, i) => (c.pk ? [[c.name, r.orig[i]]] : [])));
  const out: TableChange[] = [];
  for (const r of rows) {
    if (r.isNew) {
      if (deleted.has(r.id)) continue;
      const values: Record<string, Cell> = {};
      r.cells.forEach((v, i) => { if (v !== undefined) values[columns[i].name] = v; });
      out.push({ op: 'insert', values });
    } else if (deleted.has(r.id)) {
      out.push({ op: 'delete', key: key(r) });
    } else if (rowChanged(r)) {
      const values: Record<string, Cell> = {};
      r.cells.forEach((v, i) => { if (isChanged(r, i)) values[columns[i].name] = v ?? null; });
      out.push({ op: 'update', key: key(r), values });
    }
  }
  return out;
}

/** SQL literal for previews only (execution always uses bound parameters). */
function literal(v: Cell): string {
  if (v === null) return 'NULL';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return `'${v.replace(/'/g, "''")}'`;
}

/** Human-readable statements for the pending changes, shown before Apply. */
export function previewSQL(changes: TableChange[], target: string, quote: (name: string) => string): string[] {
  const where = (key: Record<string, Cell> = {}) =>
    Object.entries(key).map(([k, v]) => `${quote(k)} = ${literal(v)}`).join(' AND ');
  return changes.map((c) => {
    const vals = Object.entries(c.values ?? {});
    switch (c.op) {
      case 'insert':
        return vals.length
          ? `INSERT INTO ${target} (${vals.map(([k]) => quote(k)).join(', ')})\nVALUES (${vals.map(([, v]) => literal(v)).join(', ')});`
          : `INSERT INTO ${target} DEFAULT VALUES;`;
      case 'update':
        return `UPDATE ${target}\nSET ${vals.map(([k, v]) => `${quote(k)} = ${literal(v)}`).join(', ')}\nWHERE ${where(c.key)};`;
      case 'delete':
        return `DELETE FROM ${target}\nWHERE ${where(c.key)};`;
    }
  });
}
