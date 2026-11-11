import type { DbKind } from './models';

const PLAIN: Record<DbKind, RegExp> = {
  postgres: /^[a-z_][a-z0-9_$]*$/,
  sqlite: /^[A-Za-z_][A-Za-z0-9_]*$/,
  mysql: /^[A-Za-z_][A-Za-z0-9_$]*$/,
  oracle: /^[A-Z][A-Z0-9_$#]*$/,
};

/** Quotes an identifier only when the dialect requires it. */
export function ident(kind: DbKind, name: string): string {
  if (PLAIN[kind].test(name) && !RESERVED.has(name.toUpperCase())) return name;
  const q = kind === 'mysql' ? '`' : '"';
  return q + name.split(q).join(q + q) + q;
}

/** schema.table, omitting the schema when it is the connection's default. */
export function qualified(kind: DbKind, schema: string, table: string, defaultSchema?: string): string {
  if (!schema || schema === defaultSchema) return ident(kind, table);
  return `${ident(kind, schema)}.${ident(kind, table)}`;
}

export function selectTop(kind: DbKind, target: string, n = 100): string {
  return kind === 'oracle'
    ? `SELECT *\nFROM ${target}\nFETCH FIRST ${n} ROWS ONLY;`
    : `SELECT *\nFROM ${target}\nLIMIT ${n};`;
}

/** Monaco language id for a dialect. */
export function monacoLanguage(kind: DbKind | undefined): string {
  switch (kind) {
    case 'postgres': return 'pgsql';
    case 'mysql': return 'mysql';
    default: return 'sql';
  }
}

export const KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'IS', 'NULL', 'LIKE', 'ILIKE', 'BETWEEN', 'EXISTS',
  'JOIN', 'INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'FULL JOIN', 'CROSS JOIN', 'ON', 'USING',
  'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET', 'FETCH FIRST', 'ROWS ONLY', 'DISTINCT', 'AS', 'ASC', 'DESC',
  'UNION', 'UNION ALL', 'INTERSECT', 'EXCEPT', 'WITH', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
  'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE FROM', 'RETURNING', 'MERGE INTO',
  'CREATE TABLE', 'CREATE VIEW', 'CREATE INDEX', 'ALTER TABLE', 'DROP TABLE', 'TRUNCATE',
  'BEGIN', 'COMMIT', 'ROLLBACK', 'EXPLAIN',
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'COALESCE', 'CAST', 'NULLIF',
];

const RESERVED = new Set([
  'SELECT', 'FROM', 'WHERE', 'TABLE', 'ORDER', 'GROUP', 'USER', 'INDEX', 'KEY', 'LIMIT', 'OFFSET', 'DESC',
  'ASC', 'BY', 'TO', 'AS', 'ON', 'IN', 'IS', 'OR', 'AND', 'NOT', 'NULL', 'CHECK', 'COLUMN', 'DEFAULT',
  'GRANT', 'UNION', 'UNIQUE', 'VALUES', 'VIEW', 'WITH', 'JOIN', 'LEVEL', 'SIZE', 'COMMENT', 'DATE', 'NUMBER',
]);
