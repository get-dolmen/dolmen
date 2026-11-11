import { Injectable, inject, signal } from '@angular/core';
import { Api, errorText } from './api';
import { ConnectionStore } from './connection.store';
import { Toasts } from './toast';
import type { DbColumn, DbTable } from './models';

export interface ConnSchema {
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
export function scopeOf(connId: string, database = ''): string {
  return database ? `${connId}@${database}` : connId;
}

export function parseScope(scope: string): { connId: string; database: string } {
  const i = scope.indexOf('@');
  return i < 0 ? { connId: scope, database: '' } : { connId: scope.slice(0, i), database: scope.slice(i + 1) };
}

/** Caches database metadata per scope for the sidebar, palette and autocomplete. */
@Injectable({ providedIn: 'root' })
export class SchemaStore {
  private api = inject(Api);
  private toasts = inject(Toasts);
  private conns = inject(ConnectionStore);

  readonly data = signal<Record<string, ConnSchema>>({});
  readonly databases = signal<Record<string, ServerDatabases>>({});
  readonly loading = signal<ReadonlySet<string>>(new Set());
  private inflight = new Map<string, Promise<unknown>>();

  constructor() {
    this.conns.onChange((id, connected) => {
      this.invalidate(id);
      if (connected) void this.loadDatabases(id).then(() => this.loadSchemas(id));
    });
  }

  get(scope: string): ConnSchema | undefined { return this.data()[scope]; }

  /** The scope for a tab or tree node; the connection's own database maps to the plain connection scope. */
  scope(connId: string, database = ''): string {
    const cur = this.databases()[connId]?.current;
    return scopeOf(connId, database && database !== cur ? database : '');
  }

  /** Forgets everything cached for a connection, including its other databases. */
  invalidate(connId: string) {
    const owns = (k: string) => k === connId || k.startsWith(connId + '@') || k.startsWith(connId + '|');
    this.data.set(Object.fromEntries(Object.entries(this.data()).filter(([k]) => !owns(k))));
    const dbs = { ...this.databases() };
    delete dbs[connId];
    this.databases.set(dbs);
    for (const k of [...this.inflight.keys()]) if (owns(k)) this.inflight.delete(k);
  }

  async refresh(connId: string) {
    this.invalidate(connId);
    await this.loadDatabases(connId);
    await this.loadSchemas(connId);
  }

  loadDatabases(connId: string): Promise<unknown> {
    if (this.databases()[connId]) return Promise.resolve();
    return this.once(`${connId}|databases`, async () => {
      const d = await this.api.listDatabases(connId);
      this.databases.set({ ...this.databases(), [connId]: d });
    });
  }

  loadSchemas(scope: string): Promise<unknown> {
    if (this.get(scope)?.loaded) return Promise.resolve();
    const { connId, database } = parseScope(scope);
    return this.once(`${scope}|schemas`, async () => {
      const s = await this.api.listSchemas(connId, database);
      const schemas = s.schemas.length ? s.schemas : s.default ? [s.default] : [];
      this.patch(scope, { loaded: true, schemas, defaultSchema: s.default || schemas[0] || '' });
    });
  }

  loadTables(scope: string, schema: string): Promise<unknown> {
    if (this.get(scope)?.tables[schema]) return Promise.resolve();
    const { connId, database } = parseScope(scope);
    return this.once(`${scope}|tables|${schema}`, async () => {
      const t = await this.api.listTables(connId, database, schema);
      this.update(scope, (c) => ({ ...c, tables: { ...c.tables, [schema]: t } }));
    });
  }

  loadColumns(scope: string, schema: string, table: string): Promise<unknown> {
    if (this.get(scope)?.columns[`${schema}.${table}`]) return Promise.resolve();
    const { connId, database } = parseScope(scope);
    return this.once(`${scope}|cols|${schema}.${table}`, async () => {
      const cols = await this.api.listColumns(connId, database, schema, table);
      this.update(scope, (c) => ({ ...c, columns: { ...c.columns, [`${schema}.${table}`]: cols } }));
    });
  }

  /** Loads every column of a schema in one query (used by autocomplete). */
  loadAllColumns(scope: string, schema: string): Promise<unknown> {
    if (this.get(scope)?.fullColumns[schema]) return Promise.resolve();
    const { connId, database } = parseScope(scope);
    return this.once(`${scope}|allcols|${schema}`, async () => {
      const cols = await this.api.listColumns(connId, database, schema, '');
      const grouped: Record<string, DbColumn[]> = {};
      for (const col of cols) (grouped[`${schema}.${col.table}`] ??= []).push(col);
      this.update(scope, (c) => ({
        ...c,
        columns: { ...c.columns, ...grouped },
        fullColumns: { ...c.fullColumns, [schema]: true },
      }));
    });
  }

  /** Loads tables of every schema (capped) for the search palette. */
  async loadAllTables(scope: string, maxSchemas = 60) {
    await this.loadSchemas(scope);
    const c = this.get(scope);
    if (!c) return;
    const ordered = [c.defaultSchema, ...c.schemas.filter((s) => s !== c.defaultSchema)].filter(Boolean);
    await Promise.allSettled(ordered.slice(0, maxSchemas).map((s) => this.loadTables(scope, s)));
  }

  private once(key: string, fn: () => Promise<void>): Promise<unknown> {
    const existing = this.inflight.get(key);
    if (existing) return existing;
    this.setLoading(key, true);
    const p = fn()
      .catch((e) => {
        this.inflight.delete(key);
        this.toasts.error(errorText(e));
      })
      .finally(() => this.setLoading(key, false));
    this.inflight.set(key, p);
    return p;
  }

  private patch(scope: string, p: Partial<ConnSchema>) {
    this.update(scope, (c) => ({ ...c, ...p }));
  }

  private update(scope: string, fn: (c: ConnSchema) => ConnSchema) {
    const cur = this.data()[scope] ?? { loaded: false, schemas: [], defaultSchema: '', tables: {}, columns: {}, fullColumns: {} };
    this.data.set({ ...this.data(), [scope]: fn(cur) });
  }

  private setLoading(key: string, on: boolean) {
    const s = new Set(this.loading());
    if (on) s.add(key); else s.delete(key);
    this.loading.set(s);
  }
}
