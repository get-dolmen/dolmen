import { describe, expect, it } from 'vitest';
import { buildChanges, isChanged, normalizeEdit, previewSQL, type GridRow } from './changes';
import type { TableColumn } from '../../core/models';

const col = (name: string, pk = false): TableColumn => ({ name, type: 'text', pk, nullable: true, editable: true });
const columns = [col('id', true), col('name'), col('age')];
const row = (id: string, cells: (string | number | null)[]): GridRow => ({ id, isNew: false, orig: [...cells], cells: [...cells] });

describe('buildChanges', () => {
  it('returns nothing without edits', () => {
    expect(buildChanges(columns, [row('a', [1, 'Ada', 36])], new Set())).toEqual([]);
  });

  it('updates only changed columns, keyed by the original primary key', () => {
    const r = row('a', [1, 'Ada', 36]);
    r.cells[1] = 'Ada L.';
    r.cells[2] = null;
    expect(buildChanges(columns, [r], new Set())).toEqual([{ op: 'update', key: { id: 1 }, values: { name: 'Ada L.', age: null } }]);
  });

  it('deletes win over edits, and new rows insert only the cells that were set', () => {
    const r = row('a', [1, 'Ada', 36]);
    r.cells[1] = 'changed';
    const n: GridRow = { id: 'n', isNew: true, orig: [], cells: ['7', 'Ken', undefined] };
    const gone: GridRow = { id: 'g', isNew: true, orig: [], cells: [undefined, 'x', undefined] };
    expect(buildChanges(columns, [r, n, gone], new Set(['a', 'g']))).toEqual([
      { op: 'delete', key: { id: 1 } },
      { op: 'insert', values: { id: '7', name: 'Ken' } },
    ]);
  });
});

describe('normalizeEdit', () => {
  it('keeps the original value when only the text form differs', () => {
    const r = row('a', [1, 'Ada', 36]);
    r.cells[2] = normalizeEdit(r, 2, '36');
    expect(isChanged(r, 2)).toBe(false);
    r.cells[2] = normalizeEdit(r, 2, '37');
    expect(isChanged(r, 2)).toBe(true);
  });
});

describe('previewSQL', () => {
  it('renders readable statements with escaped literals', () => {
    const q = (n: string) => `"${n}"`;
    expect(previewSQL([
      { op: 'update', key: { id: 1 }, values: { name: "O'Brien", age: null } },
      { op: 'delete', key: { id: 2 } },
      { op: 'insert', values: { name: 'Ken' } },
    ], 'people', q)).toEqual([
      `UPDATE people\nSET "name" = 'O''Brien', "age" = NULL\nWHERE "id" = 1;`,
      `DELETE FROM people\nWHERE "id" = 2;`,
      `INSERT INTO people ("name")\nVALUES ('Ken');`,
    ]);
  });
});
