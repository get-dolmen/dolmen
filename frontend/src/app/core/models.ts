// Plain TypeScript shapes for data exchanged with the Go backend.
// They mirror the generated classes in wailsjs/go/models.ts but as interfaces,
// so components can build them as object literals.

export type DbKind = 'postgres' | 'mysql' | 'oracle' | 'sqlite';

export interface ConnectionConfig {
  id: string;
  name: string;
  kind: DbKind;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  filePath?: string;
  readOnly: boolean;
  color?: string;
  options?: Record<string, string>;
}

export interface ConnectionView extends ConnectionConfig {
  hasPassword: boolean;
  connected: boolean;
}

export interface DbTable { schema: string; name: string; type: 'table' | 'view'; }
export interface DbColumn { table: string; name: string; type: string; nullable: boolean; pk: boolean; }
export interface SchemaList { schemas: string[]; default: string; }

export interface ResultColumn { name: string; type: string; }
export type Cell = string | number | boolean | null;

export interface QueryResult {
  id: string;
  statement: string;
  columns: ResultColumn[];
  rows: Cell[][];
  isQuery: boolean;
  hasMore: boolean;
  canFetchMore: boolean;
  rowsAffected: number;
  message?: string;
  durationMs: number;
  error?: string;
}

export interface ExecResponse { results: QueryResult[]; cancelled: boolean; notice?: string; tx: TxStatus; }
export interface FetchResult { rows: Cell[][]; hasMore: boolean; error?: string; }

export interface HistoryEntry {
  id: number;
  connId: string;
  sql: string;
  startedAt: number;
  durationMs: number;
  rows: number;
  status: 'ok' | 'error' | 'cancelled';
  error?: string;
}

export interface TabState {
  id: string; name: string; connId: string; database?: string; content?: string;
  kind?: 'sql' | 'table'; schema?: string; table?: string; tableType?: string; txMode?: 'manual';
}

export type TxMode = 'auto' | 'manual';
export interface TxStatus { open: boolean; statements: number; startedAt: number; }

export interface TableColumn { name: string; type: string; pk: boolean; nullable: boolean; editable: boolean; }
export interface TablePage {
  columns: TableColumn[];
  rows: Cell[][];
  hasMore: boolean;
  offset: number;
  editable: boolean;
  readOnly?: string;
  sql: string;
  durationMs: number;
}
export interface TableChange { op: 'insert' | 'update' | 'delete'; key?: Record<string, Cell>; values?: Record<string, Cell>; }
export interface ApplyResult { inserted: number; updated: number; deleted: number; }
export interface DatabaseList { supported: boolean; databases: string[]; current: string; }
export interface Workspace { tabs: TabState[]; activeId: string; }

export interface ScratchInfo {
  id: string;
  name: string;
  connId: string;
  database?: string;
  schema?: string;
  table?: string;
  createdAt: number;
  updatedAt: number;
  size: number;
  preview?: string;
}

export const KIND_LABELS: Record<DbKind, string> = {
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
  oracle: 'Oracle',
  sqlite: 'SQLite',
};

export const DEFAULT_PORTS: Record<DbKind, number | undefined> = {
  postgres: 5432,
  mysql: 3306,
  oracle: 1521,
  sqlite: undefined,
};

export const CONNECTION_COLORS = ['#4f7a4a', '#3d6fa8', '#8a5bb0', '#b8862d', '#c0563f', '#2f8f8a', '#7a7a7a'];
