import { describe, expect, it } from 'vitest';
import { canCreateSchema, createSchemaTemplate } from './sql';

describe('createSchemaTemplate', () => {
  it('uses CREATE SCHEMA on Postgres and MySQL, quoted for the dialect', () => {
    expect(createSchemaTemplate('postgres', 'sales')).toBe('CREATE SCHEMA sales;\n');
    expect(createSchemaTemplate('postgres', 'Sales')).toBe('CREATE SCHEMA "Sales";\n');
    expect(createSchemaTemplate('mysql', 'my-db')).toBe('CREATE SCHEMA `my-db`;\n');
  });

  it('creates a schema-only user on Oracle, folding plain names to upper case', () => {
    const script = createSchemaTemplate('oracle', 'sales');
    expect(script).toContain('CREATE USER SALES NO AUTHENTICATION;');
    expect(createSchemaTemplate('oracle', 'my schema')).toContain(
      'CREATE USER "my schema" NO AUTHENTICATION;',
    );
  });
});

describe('canCreateSchema', () => {
  it('is offered everywhere but SQLite', () => {
    expect(canCreateSchema('postgres')).toBe(true);
    expect(canCreateSchema('mysql')).toBe(true);
    expect(canCreateSchema('oracle')).toBe(true);
    expect(canCreateSchema('sqlite')).toBe(false);
    expect(canCreateSchema(undefined)).toBe(false);
  });
});
