import { describe, expect, it } from 'vitest';
import {
  completionContext,
  expectsTable,
  parseTableReferences,
  splitName,
  statementAround,
} from './completion';

describe('parseTableReferences', () => {
  it('finds tables and aliases across FROM and JOIN', () => {
    const references = parseTableReferences(
      'select * from public.orders o join users as u on u.id = o.user_id left join items where 1=1',
    );
    expect(references).toEqual([
      { schema: 'public', table: 'orders', alias: 'o' },
      { schema: undefined, table: 'users', alias: 'u' },
      { schema: undefined, table: 'items', alias: undefined },
    ]);
  });

  it('follows comma-separated FROM lists', () => {
    const references = parseTableReferences('select * from a x, b, "My Table" t where x.id = 1');
    expect(references.map((reference) => [reference.table, reference.alias])).toEqual([
      ['a', 'x'],
      ['b', undefined],
      ['My Table', 't'],
    ]);
  });

  it('does not treat clause keywords as aliases', () => {
    expect(parseTableReferences('select * from t where a = 1')).toEqual([
      { schema: undefined, table: 't', alias: undefined },
    ]);
    expect(parseTableReferences('update t set a = 1')[0].alias).toBeUndefined();
  });

  it('handles quoted identifiers', () => {
    expect(parseTableReferences('select * from `db`.`my tbl` m')).toEqual([
      { schema: 'db', table: 'my tbl', alias: 'm' },
    ]);
  });
});

describe('completionContext', () => {
  it('splits qualifier and word', () => {
    expect(completionContext('select o.na')).toEqual({
      qualifier: ['o'],
      word: 'na',
      keyword: 'select',
    });
    expect(completionContext('select * from public.')).toEqual({
      qualifier: ['public'],
      word: '',
      keyword: 'from',
    });
    expect(completionContext('select * from ')).toEqual({
      qualifier: [],
      word: '',
      keyword: 'from',
    });
    expect(completionContext('select "My Table".c')).toMatchObject({
      qualifier: ['My Table'],
      word: 'c',
    });
  });

  it('ranks tables after FROM', () => {
    expect(expectsTable(completionContext('select * from ord').keyword)).toBe(true);
    expect(expectsTable(completionContext('select * from t where ').keyword)).toBe(false);
  });
});

describe('helpers', () => {
  it('splitName handles dots inside quotes', () => {
    expect(splitName('a."b.c"')).toEqual(['a', 'b.c']);
  });

  it('statementAround returns the current statement', () => {
    const text = "select 1; select ';' from t; select 3";
    expect(statementAround(text, 12).text).toBe(" select ';' from t");
    expect(statementAround(text, text.length).text).toBe(' select 3');
  });
});
