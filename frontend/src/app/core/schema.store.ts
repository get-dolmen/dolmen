import { Injectable, inject, signal } from '@angular/core';
import { Api, errorText } from './api';
import { ConnectionStore } from './connection.store';
import { Toasts } from './toast';
import type { DbColumn, DbTable } from './models';

export interface ConnectionSchema {
  loaded: boolean;
  schemas: string[];
  defaultSchema: string;
  /** schema -> tables, filled lazily */
  tables: Record<string, DbTable[]>;
  /** "schema.table" -> columns, filled lazily */
  columns: Record<string, DbColumn[]>;
  /** schemas whose full column list was loaded (for autocomplete) */
  fullColumns: Record<string, boolean>;
}

export interface ServerDatabases {
  /** false for engines without a database level (MySQL, Oracle, SQLite) */
  supported: boolean;
  databases: string[];
  /** the database the connection itself opens */
  current: string;
}

/**
 * A scope identifies where metadata comes from: a connection, or another
 * database on the same server ("<connId>@<database>", Postgres only).
 * Connection IDs are UUIDs, so they never contain "@".
 */
export function connectionScope(connectionId: string, database = ''): string {
  return database ? `${connectionId}@${database}` : connectionId;
}

export function parseConnectionScope(scope: string): { connId: string; database: string } {
  const separatorIndex = scope.indexOf('@');
  return separatorIndex < 0
    ? { connId: scope, database: '' }
    : { connId: scope.slice(0, separatorIndex), database: scope.slice(separatorIndex + 1) };
}

/** Caches database metadata per scope for the sidebar, palette and autocomplete. */
@Injectable({ providedIn: 'root' })
export class SchemaStore {
  private api = inject(Api);
  private toastService = inject(Toasts);
  private connectionStore = inject(ConnectionStore);

  public readonly schemasByScope = signal<Record<string, ConnectionSchema>>({});
  public readonly databases = signal<Record<string, ServerDatabases>>({});
  public readonly loading = signal<ReadonlySet<string>>(new Set());
  private inflight = new Map<string, Promise<unknown>>();

  public constructor() {
    this.connectionStore.onChange((id, connected) => {
      this.invalidate(id);
      if (connected) void this.loadDatabases(id).then(() => this.loadSchemas(id));
    });
  }

  public get(scope: string): ConnectionSchema | undefined {
    return this.schemasByScope()[scope];
  }

  /** The scope for a tab or tree node; the connection's own database maps to the plain connection scope. */
  public scopeFor(connectionId: string, database = ''): string {
    const current = this.databases()[connectionId]?.current;
    return connectionScope(connectionId, database && database !== current ? database : '');
  }

  /** The default schema of a tab's scope, when it is already cached. */
  public defaultSchemaFor(connectionId: string, database = ''): string | undefined {
    return this.get(this.scopeFor(connectionId, database))?.defaultSchema;
  }

  /** Forgets everything cached for a connection, including its other databases. */
  public invalidate(connId: string) {
    const belongsToConnection = (key: string) =>
      key === connId || key.startsWith(connId + '@') || key.startsWith(connId + '|');
    this.schemasByScope.set(
      Object.fromEntries(
        Object.entries(this.schemasByScope()).filter(([key]) => !belongsToConnection(key)),
      ),
    );
    const databases = { ...this.databases() };
    delete databases[connId];
    this.databases.set(databases);
    for (const key of [...this.inflight.keys()])
      if (belongsToConnection(key)) this.inflight.delete(key);
  }

  public async refresh(connId: string) {
    this.invalidate(connId);
    await this.loadDatabases(connId);
    await this.loadSchemas(connId);
  }

  /** Reloads one database (scope) of a connection, keeping the others cached. */
  public async refreshScope(scope: string) {
    const cache = { ...this.schemasByScope() };
    delete cache[scope];
    this.schemasByScope.set(cache);
    for (const key of [...this.inflight.keys()])
      if (key.startsWith(scope + '|')) this.inflight.delete(key);
    await this.loadSchemas(scope);
  }

  public loadDatabases(connId: string): Promise<unknown> {
    if (this.databases()[connId]) return Promise.resolve();
    return this.once(`${connId}|databases`, async () => {
      const databases = await this.api.listDatabases(connId);
      this.databases.set({ ...this.databases(), [connId]: databases });
    });
  }

  public loadSchemas(scope: string): Promise<unknown> {
    if (this.get(scope)?.loaded) return Promise.resolve();
    const { connId, database } = parseConnectionScope(scope);
    return this.once(`${scope}|schemas`, async () => {
      const response = await this.api.listSchemas(connId, database);
      const schemas = response.schemas.length
        ? response.schemas
        : response.default
          ? [response.default]
          : [];
      this.patch(scope, {
        loaded: true,
        schemas,
        defaultSchema: response.default || schemas[0] || '',
      });
    });
  }

  public loadTables(scope: string, schema: string): Promise<unknown> {
    if (this.get(scope)?.tables[schema]) return Promise.resolve();
    const { connId, database } = parseConnectionScope(scope);
    return this.once(`${scope}|tables|${schema}`, async () => {
      const tables = await this.api.listTables(connId, database, schema);
      this.update(scope, (cached) => ({
        ...cached,
        tables: { ...cached.tables, [schema]: tables },
      }));
    });
  }

  public loadColumns(scope: string, schema: string, table: string): Promise<unknown> {
    if (this.get(scope)?.columns[`${schema}.${table}`]) return Promise.resolve();
    const { connId, database } = parseConnectionScope(scope);
    return this.once(`${scope}|cols|${schema}.${table}`, async () => {
      const columns = await this.api.listColumns(connId, database, schema, table);
      this.update(scope, (cached) => ({
        ...cached,
        columns: { ...cached.columns, [`${schema}.${table}`]: columns },
      }));
    });
  }

  /** Loads every column of a schema in one query (used by autocomplete). */
  public loadAllColumns(scope: string, schema: string): Promise<unknown> {
    if (this.get(scope)?.fullColumns[schema]) return Promise.resolve();
    const { connId, database } = parseConnectionScope(scope);
    return this.once(`${scope}|allcols|${schema}`, async () => {
      const columns = await this.api.listColumns(connId, database, schema, '');
      const groupedColumns: Record<string, DbColumn[]> = {};
      for (const column of columns)
        (groupedColumns[`${schema}.${column.table}`] ??= []).push(column);
      this.update(scope, (cached) => ({
        ...cached,
        columns: { ...cached.columns, ...groupedColumns },
        fullColumns: { ...cached.fullColumns, [schema]: true },
      }));
    });
  }

  /** Loads tables of every schema (capped) for the search palette. */
  public async loadAllTables(scope: string, maxSchemas = 60) {
    await this.loadSchemas(scope);
    const schema = this.get(scope);
    if (!schema) return;
    const ordered = [
      schema.defaultSchema,
      ...schema.schemas.filter((name) => name !== schema.defaultSchema),
    ].filter(Boolean);
    await Promise.allSettled(
      ordered.slice(0, maxSchemas).map((name) => this.loadTables(scope, name)),
    );
  }

  private once(key: string, load: () => Promise<void>): Promise<unknown> {
    const existing = this.inflight.get(key);
    if (existing) return existing;
    this.setLoading(key, true);
    const pending = load()
      .catch((error) => {
        this.inflight.delete(key);
        this.toastService.error(errorText(error));
      })
      .finally(() => this.setLoading(key, false));
    this.inflight.set(key, pending);
    return pending;
  }

  private patch(scope: string, changes: Partial<ConnectionSchema>) {
    this.update(scope, (cached) => ({ ...cached, ...changes }));
  }

  private update(scope: string, transform: (cached: ConnectionSchema) => ConnectionSchema) {
    const current = this.schemasByScope()[scope] ?? {
      loaded: false,
      schemas: [],
      defaultSchema: '',
      tables: {},
      columns: {},
      fullColumns: {},
    };
    this.schemasByScope.set({ ...this.schemasByScope(), [scope]: transform(current) });
  }

  private setLoading(key: string, active: boolean) {
    const loading = new Set(this.loading());
    if (active) loading.add(key);
    else loading.delete(key);
    this.loading.set(loading);
  }
}
