import { describe, expect, it } from 'vitest';
import { FORMAT_WIDTH, clampFormatWidth, formatSql } from './sql-format';

describe('formatSql', () => {
  it('upper-cases keywords and puts each clause on its own line', () => {
    expect(formatSql('postgres', 'select id,name from users where active=true')).toBe(
      ['SELECT', '  id,', '  name', 'FROM', '  users', 'WHERE', '  active = TRUE'].join('\n'),
    );
  });

  it('keeps the identifiers of the connection dialect', () => {
    expect(formatSql('mysql', 'select `id` from `users`')).toBe(
      ['SELECT', '  `id`', 'FROM', '  `users`'].join('\n'),
    );
  });

  it('accepts anonymous queries and PL/SQL blocks', () => {
    expect(formatSql(undefined, 'select 1')).toContain('SELECT');
    expect(formatSql('oracle', 'begin update t set a = 1; commit; end;')).toContain('BEGIN');
  });

  it('leaves already formatted SQL untouched', () => {
    const sql = 'SELECT\n  id\nFROM\n  users';
    expect(formatSql('postgres', sql)).toBe(sql);
  });

  it('splits parenthesised lists only past the line width', () => {
    const sql = "select coalesce(first_name, last_name, nickname, 'unknown') from users";
    expect(formatSql('postgres', sql, 100)).toContain(
      "coalesce(first_name, last_name, nickname, 'unknown')",
    );
    expect(formatSql('postgres', sql, 30)).toContain('coalesce(\n    first_name,');
  });

  it('clamps the line width setting', () => {
    expect(clampFormatWidth('abc')).toBe(FORMAT_WIDTH.default);
    expect(clampFormatWidth(5)).toBe(FORMAT_WIDTH.min);
    expect(clampFormatWidth(999)).toBe(FORMAT_WIDTH.max);
    expect(clampFormatWidth(undefined)).toBe(FORMAT_WIDTH.default);
  });
});
