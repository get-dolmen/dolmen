// Plain TypeScript shapes for data exchanged with the Go backend.
// They mirror the generated classes in wailsjs/go/models.ts but as interfaces,
// so components can build them as object literals.

export type DbKind = 'postgres' | 'mysql' | 'oracle' | 'sqlite';

export type SSHAuthMethod = 'password' | 'key' | 'agent';

/** A jump host in front of the database server. */
export interface SSHConfig {
  enabled: boolean;
  host?: string;
  port?: number;
  user?: string;
  method?: SSHAuthMethod;
  password?: string;
  keyPath?: string;
  passphrase?: string;
  /** Skip the known_hosts check. */
  insecureHostKey?: boolean;
}

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
  folderId?: string;
  options?: Record<string, string>;
  ssh?: SSHConfig;
}

/** A folder grouping connections in the explorer (folders can be nested). */
export interface ConnectionFolder {
  id: string;
  name: string;
  parentId?: string;
}

export interface ConnectionView extends ConnectionConfig {
  hasPassword: boolean;
  hasSSHPassword: boolean;
  hasSSHPassphrase: boolean;
  connected: boolean;
}

export interface DbTable {
  schema: string;
  name: string;
  type: 'table' | 'view';
}
export interface DbColumn {
  table: string;
  name: string;
  type: string;
  nullable: boolean;
  pk: boolean;
}
export interface SchemaList {
  schemas: string[];
  default: string;
}

export interface ResultColumn {
  name: string;
  type: string;
}
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
  /** UTF-16 offset just past the statement in the SQL that was sent. */
  end: number;
}

export interface ExecResponse {
  results: QueryResult[];
  cancelled: boolean;
  notice?: string;
  tx: TxStatus;
}
export interface FetchResult {
  rows: Cell[][];
  hasMore: boolean;
  error?: string;
}

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
  id: string;
  name: string;
  connId: string;
  database?: string;
  content?: string;
  kind?: 'sql' | 'table';
  schema?: string;
  table?: string;
  tableType?: string;
  txMode?: 'manual';
  /** SQL tabs: the connection and database are pinned. */
  locked?: boolean;
}

export type TxMode = 'auto' | 'manual';
export interface TxStatus {
  open: boolean;
  statements: number;
  startedAt: number;
}

export interface TableColumn {
  name: string;
  type: string;
  pk: boolean;
  nullable: boolean;
  editable: boolean;
}
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
/** Which page of a table to read, and how to filter and sort it. */
export interface TablePageRequest {
  schema: string;
  table: string;
  type: string;
  where: string;
  orderBy: string;
  offset: number;
  limit: number;
}
export interface TableChange {
  op: 'insert' | 'update' | 'delete';
  key?: Record<string, Cell>;
  values?: Record<string, Cell>;
}
export interface ApplyResult {
  inserted: number;
  updated: number;
  deleted: number;
}
export interface DatabaseList {
  supported: boolean;
  databases: string[];
  current: string;
}
export interface Workspace {
  tabs: TabState[];
  activeId: string;
}

/** MCP server settings. Databases and schemas are allow-lists; empty means all. */
export interface McpConfig {
  enabled: boolean;
  port: number;
  /** Bearer token local MCP clients must send. */
  token: string;
  read: boolean;
  write: boolean;
  databases: string[];
  schemas: string[];
}

export interface McpStatus extends McpConfig {
  running: boolean;
  url: string;
  lastError?: string;
}

/** Git sync settings; the master password is never part of them. */
export interface SyncConfig {
  enabled: boolean;
  remote: string;
  branch: string;
  encrypted: boolean;
}

export interface SyncStatus extends SyncConfig {
  dir: string;
  gitAvailable: boolean;
  repoExists: boolean;
  lastCommit?: string;
  lastSyncAt?: number;
  lastError?: string;
}

export interface SyncResult {
  commit?: string;
  changed: boolean;
  lastSyncAt: number;
  connections: number;
  scratches: number;
}

export interface ScratchInfo {
  id: string;
  name: string;
  connId: string;
  database?: string;
  schema?: string;
  table?: string;
  locked?: boolean;
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

export const CONNECTION_COLORS = [
  '#4f7a4a',
  '#3d6fa8',
  '#8a5bb0',
  '#b8862d',
  '#c0563f',
  '#2f8f8a',
  '#7a7a7a',
];
