import { format } from 'sql-formatter';
import type { DbKind } from './models';

const DIALECTS: Record<DbKind, 'postgresql' | 'mysql' | 'sqlite' | 'plsql'> = {
  postgres: 'postgresql',
  mysql: 'mysql',
  sqlite: 'sqlite',
  oracle: 'plsql',
};

/** Default and bounds of the formatter's line width setting. */
export const FORMAT_WIDTH = { default: 80, min: 20, max: 200 } as const;

/** Keeps a stored or typed width within the supported range. */
export function clampFormatWidth(value: unknown): number {
  const width = Math.round(Number(value));
  if (!Number.isFinite(width)) return FORMAT_WIDTH.default;
  return Math.min(FORMAT_WIDTH.max, Math.max(FORMAT_WIDTH.min, width));
}

/**
 * Pretty-prints SQL in the style the app writes: upper-case keywords, two-space
 * indentation, one blank line between statements. Unknown connections fall back
 * to the generic dialect. `width` is how long a parenthesised list (function
 * arguments, IN (...)) may get before it is split one item per line.
 */
export function formatSql(
  kind: DbKind | undefined,
  sql: string,
  width: number = FORMAT_WIDTH.default,
): string {
  return format(sql, {
    language: kind ? DIALECTS[kind] : 'sql',
    keywordCase: 'upper',
    tabWidth: 2,
    linesBetweenQueries: 1,
    expressionWidth: clampFormatWidth(width),
  });
}
