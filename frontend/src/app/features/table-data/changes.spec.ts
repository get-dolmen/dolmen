import { describe, expect, it } from 'vitest';
import { buildChanges, isChanged, normalizeEdit, previewSQL, type GridRow } from './changes';
import type { TableColumn } from '../../core/models';

const tableColumn = (name: string, pk = false): TableColumn => ({
  name,
  type: 'text',
  pk,
  nullable: true,
  editable: true,
});
const columns = [tableColumn('id', true), tableColumn('name'), tableColumn('age')];
const row = (id: string, cells: (string | number | null)[]): GridRow => ({
  id,
  isNew: false,
  original: [...cells],
  cells: [...cells],
});

describe('buildChanges', () => {
  it('returns nothing without edits', () => {
    expect(buildChanges(columns, [row('a', [1, 'Ada', 36])], new Set())).toEqual([]);
  });

  it('updates only changed columns, keyed by the original primary key', () => {
    const edited = row('a', [1, 'Ada', 36]);
    edited.cells[1] = 'Ada L.';
    edited.cells[2] = null;
    expect(buildChanges(columns, [edited], new Set())).toEqual([
      { op: 'update', key: { id: 1 }, values: { name: 'Ada L.', age: null } },
    ]);
  });

  it('deletes win over edits, and new rows insert only the cells that were set', () => {
    const edited = row('a', [1, 'Ada', 36]);
    edited.cells[1] = 'changed';
    const fresh: GridRow = {
      id: 'n',
      isNew: true,
      original: [],
      cells: ['7', 'Ken', undefined],
    };
    const removed: GridRow = {
      id: 'g',
      isNew: true,
      original: [],
      cells: [undefined, 'x', undefined],
    };
    expect(buildChanges(columns, [edited, fresh, removed], new Set(['a', 'g']))).toEqual([
      { op: 'delete', key: { id: 1 } },
      { op: 'insert', values: { id: '7', name: 'Ken' } },
    ]);
  });
});

describe('normalizeEdit', () => {
  it('keeps the original value when only the text form differs', () => {
    const edited = row('a', [1, 'Ada', 36]);
    edited.cells[2] = normalizeEdit(edited, 2, '36');
    expect(isChanged(edited, 2)).toBe(false);
    edited.cells[2] = normalizeEdit(edited, 2, '37');
    expect(isChanged(edited, 2)).toBe(true);
  });
});

describe('previewSQL', () => {
  it('renders readable statements with escaped literals', () => {
    const quote = (name: string) => `"${name}"`;
    expect(
      previewSQL(
        [
          { op: 'update', key: { id: 1 }, values: { name: "O'Brien", age: null } },
          { op: 'delete', key: { id: 2 } },
          { op: 'insert', values: { name: 'Ken' } },
        ],
        'people',
        quote,
      ),
    ).toEqual([
      `UPDATE people\nSET "name" = 'O''Brien', "age" = NULL\nWHERE "id" = 1;`,
      `DELETE FROM people\nWHERE "id" = 2;`,
      `INSERT INTO people ("name")\nVALUES ('Ken');`,
    ]);
  });
});
