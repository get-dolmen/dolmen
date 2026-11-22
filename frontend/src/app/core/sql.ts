import type { DbKind } from './models';

const PLAIN_IDENTIFIER: Record<DbKind, RegExp> = {
  postgres: /^[a-z_][a-z0-9_$]*$/,
  sqlite: /^[A-Za-z_][A-Za-z0-9_]*$/,
  mysql: /^[A-Za-z_][A-Za-z0-9_$]*$/,
  oracle: /^[A-Z][A-Z0-9_$#]*$/,
};

/** Quotes an identifier only when the dialect requires it. */
export function quoteIdentifier(kind: DbKind, name: string): string {
  if (PLAIN_IDENTIFIER[kind].test(name) && !RESERVED_WORDS.has(name.toUpperCase())) return name;
  const quoteCharacter = kind === 'mysql' ? '`' : '"';
  const escapedName = name.split(quoteCharacter).join(quoteCharacter + quoteCharacter);
  return quoteCharacter + escapedName + quoteCharacter;
}

/** schema.table, omitting the schema when it is the connection's default. */
export function qualified(
  kind: DbKind,
  schema: string,
  table: string,
  defaultSchema?: string,
): string {
  if (!schema || schema === defaultSchema) return quoteIdentifier(kind, table);
  return `${quoteIdentifier(kind, schema)}.${quoteIdentifier(kind, table)}`;
}

export function selectTop(kind: DbKind, target: string, limit = 100): string {
  return kind === 'oracle'
    ? `SELECT *\nFROM ${target}\nFETCH FIRST ${limit} ROWS ONLY;`
    : `SELECT *\nFROM ${target}\nLIMIT ${limit};`;
}

/** A CREATE DATABASE to review and run, quoted for the dialect. */
export function createDatabaseTemplate(kind: DbKind, name: string): string {
  return `CREATE DATABASE ${quoteIdentifier(kind, name)};\n`;
}

/** Engines where Dolmen can create a schema (SQLite schemas are attached files). */
export function canCreateSchema(kind: DbKind | undefined): boolean {
  return kind === 'postgres' || kind === 'mysql' || kind === 'oracle';
}

/**
 * The statement that creates a schema, to review and run. On MySQL a schema is
 * a database; on Oracle it is a user, created here as a schema-only account
 * (18c+) with the name folded to upper case like an unquoted identifier.
 */
export function createSchemaTemplate(kind: DbKind, name: string): string {
  if (kind !== 'oracle') return `CREATE SCHEMA ${quoteIdentifier(kind, name)};\n`;
  const user = quoteIdentifier(
    kind,
    /^[A-Za-z][A-Za-z0-9_$#]*$/.test(name) ? name.toUpperCase() : name,
  );
  return [
    '-- In Oracle a schema is a user. NO AUTHENTICATION (18c+) creates a schema-only',
    '-- account: nobody can log in as it, but it can own tables.',
    `CREATE USER ${user} NO AUTHENTICATION;`,
    '-- Let it store data in its default tablespace:',
    `-- ALTER USER ${user} QUOTA UNLIMITED ON USERS;`,
    '',
  ].join('\n');
}

/** A CREATE TABLE to fill in, with the dialect's usual auto-increment key. */
export function createTableTemplate(kind: DbKind, target: string): string {
  const [idDefinition, textDefinition] = {
    postgres: ['bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY', 'varchar(255) NOT NULL'],
    mysql: ['BIGINT AUTO_INCREMENT PRIMARY KEY', 'VARCHAR(255) NOT NULL'],
    oracle: ['NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY', 'VARCHAR2(255) NOT NULL'],
    sqlite: ['INTEGER PRIMARY KEY', 'TEXT NOT NULL'],
  }[kind];
  return `CREATE TABLE ${target} (\n    id ${idDefinition},\n    name ${textDefinition}\n);\n`;
}

/** Monaco language id for a dialect. */
export function monacoLanguage(kind: DbKind | undefined): string {
  switch (kind) {
    case 'postgres':
      return 'pgsql';
    case 'mysql':
      return 'mysql';
    default:
      return 'sql';
  }
}

export const KEYWORDS = [
  'SELECT',
  'FROM',
  'WHERE',
  'AND',
  'OR',
  'NOT',
  'IN',
  'IS',
  'NULL',
  'LIKE',
  'ILIKE',
  'BETWEEN',
  'EXISTS',
  'JOIN',
  'INNER JOIN',
  'LEFT JOIN',
  'RIGHT JOIN',
  'FULL JOIN',
  'CROSS JOIN',
  'ON',
  'USING',
  'GROUP BY',
  'ORDER BY',
  'HAVING',
  'LIMIT',
  'OFFSET',
  'FETCH FIRST',
  'ROWS ONLY',
  'DISTINCT',
  'AS',
  'ASC',
  'DESC',
  'UNION',
  'UNION ALL',
  'INTERSECT',
  'EXCEPT',
  'WITH',
  'CASE',
  'WHEN',
  'THEN',
  'ELSE',
  'END',
  'INSERT INTO',
  'VALUES',
  'UPDATE',
  'SET',
  'DELETE FROM',
  'RETURNING',
  'MERGE INTO',
  'CREATE TABLE',
  'CREATE VIEW',
  'CREATE INDEX',
  'ALTER TABLE',
  'DROP TABLE',
  'TRUNCATE',
  'BEGIN',
  'COMMIT',
  'ROLLBACK',
  'EXPLAIN',
  'COUNT',
  'SUM',
  'AVG',
  'MIN',
  'MAX',
  'COALESCE',
  'CAST',
  'NULLIF',
];

const RESERVED_WORDS = new Set([
  'SELECT',
  'FROM',
  'WHERE',
  'TABLE',
  'ORDER',
  'GROUP',
  'USER',
  'INDEX',
  'KEY',
  'LIMIT',
  'OFFSET',
  'DESC',
  'ASC',
  'BY',
  'TO',
  'AS',
  'ON',
  'IN',
  'IS',
  'OR',
  'AND',
  'NOT',
  'NULL',
  'CHECK',
  'COLUMN',
  'DEFAULT',
  'GRANT',
  'UNION',
  'UNIQUE',
  'VALUES',
  'VIEW',
  'WITH',
  'JOIN',
  'LEVEL',
  'SIZE',
  'COMMENT',
  'DATE',
  'NUMBER',
]);
