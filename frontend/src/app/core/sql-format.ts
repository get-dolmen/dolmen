import { format } from 'sql-formatter';
import type { DbKind } from './models';

const DIALECTS: Record<DbKind, 'postgresql' | 'mysql' | 'sqlite' | 'plsql'> = {
  postgres: 'postgresql',
  mysql: 'mysql',
  sqlite: 'sqlite',
  oracle: 'plsql',
};

/**
 * Pretty-prints SQL in the style the app writes: upper-case keywords, two-space
 * indentation, one blank line between statements. Unknown connections fall back
 * to the generic dialect.
 */
export function formatSql(kind: DbKind | undefined, sql: string): string {
  return format(sql, {
    language: kind ? DIALECTS[kind] : 'sql',
    keywordCase: 'upper',
    tabWidth: 2,
    linesBetweenQueries: 1,
  });
}
