import { Injectable } from '@angular/core';
import * as App from '../../../wailsjs/go/main/App';
import type {
  ConnectionConfig, ConnectionFolder, ConnectionView, DbColumn, DbTable, ExecResponse, FetchResult,
  ApplyResult, DatabaseList, TxStatus, ScratchInfo, TabState, HistoryEntry, SchemaList, TableChange, TablePage, Workspace,
  SyncConfig, SyncResult, SyncStatus,
} from './models';

/** Thin typed wrapper over the generated Wails bindings. */
@Injectable({ providedIn: 'root' })
export class Api {
  listConnections = () => App.ListConnections() as unknown as Promise<ConnectionView[]>;
  saveConnection = (c: ConnectionConfig) => App.SaveConnection(c as any) as unknown as Promise<ConnectionView>;
  deleteConnection = (id: string) => App.DeleteConnection(id);
  testConnection = (c: ConnectionConfig) => App.TestConnection(c as any);
  connect = (id: string) => App.Connect(id);
  disconnect = (id: string) => App.Disconnect(id);
  pickSQLiteFile = () => App.PickSQLiteFile();

  listFolders = () => App.ListFolders() as unknown as Promise<ConnectionFolder[]>;
  saveFolder = (f: ConnectionFolder) => App.SaveFolder(f as any) as unknown as Promise<ConnectionFolder>;
  deleteFolder = (id: string) => App.DeleteFolder(id);
  moveConnectionToFolder = (connId: string, folderId: string) => App.MoveConnectionToFolder(connId, folderId);

  listDatabases = (connId: string) => App.ListDatabases(connId) as Promise<DatabaseList>;
  listSchemas = (connId: string, db: string) => App.ListSchemas(connId, db) as Promise<SchemaList>;
  listTables = (connId: string, db: string, schema: string) => App.ListTables(connId, db, schema) as Promise<DbTable[]>;
  listColumns = (connId: string, db: string, schema: string, table = '') =>
    App.ListColumns(connId, db, schema, table) as Promise<DbColumn[]>;
  tableDDL = (connId: string, db: string, schema: string, table: string, type: string) =>
    App.TableDDL(connId, db, schema, table, type);
  dropTable = (connId: string, db: string, schema: string, table: string, type: string) =>
    App.DropTable(connId, db, schema, table, type);
  quoteIdent = (connId: string, name: string) => App.QuoteIdent(connId, name);

  readTable = (tabId: string, connId: string, db: string, manual: boolean,
    req: { schema: string; table: string; type: string; where: string; orderBy: string; offset: number; limit: number }) =>
    App.ReadTable(tabId, connId, db, manual, req as any) as unknown as Promise<{ page: TablePage; tx: TxStatus }>;
  countTableRows = (tabId: string, connId: string, db: string, manual: boolean,
    req: { schema: string; table: string; type: string; where: string; orderBy: string; offset: number; limit: number }) =>
    App.CountTableRows(tabId, connId, db, manual, req as any) as unknown as Promise<{ count: number; tx: TxStatus }>;
  applyTableChanges = (tabId: string, connId: string, db: string, manual: boolean, req: { schema: string; table: string; changes: TableChange[] }) =>
    App.ApplyTableChanges(tabId, connId, db, manual, req as any) as unknown as Promise<{ result: ApplyResult; tx: TxStatus }>;

  commit = (tabId: string) => App.Commit(tabId) as Promise<TxStatus>;
  rollback = (tabId: string) => App.Rollback(tabId) as Promise<TxStatus>;

  execute = (req: { tabId: string; connId: string; database: string; sql: string; cursor: number; maxRows: number; manual: boolean }) =>
    App.Execute(req as any) as unknown as Promise<ExecResponse>;
  cancel = (tabId: string) => App.Cancel(tabId);
  fetchMore = (tabId: string, resultId: string, n: number) => App.FetchMore(tabId, resultId, n) as Promise<FetchResult>;
  exportResult = (tabId: string, resultId: string, format: 'csv' | 'json') => App.ExportResult(tabId, resultId, format);

  version = () => App.Version() as Promise<{ version: string; repo: string; commit: string }>;
  checkForUpdate = () => App.CheckForUpdate() as Promise<{ current: string; latest: string; newer: boolean; url: string; notes?: string }>;
  openReleasePage = (url: string) => App.OpenReleasePage(url);

  listHistory = (connId: string, search: string, limit = 200) =>
    App.ListHistory(connId, search, limit) as unknown as Promise<HistoryEntry[]>;
  clearHistory = (connId: string) => App.ClearHistory(connId);

  loadWorkspace = () => App.LoadWorkspace() as unknown as Promise<Workspace>;
  saveWorkspaceLayout = (ws: Workspace) => App.SaveWorkspaceLayout(ws as any);
  saveTabContent = (id: string, content: string) => App.SaveTabContent(id, content);
  closeTab = (id: string) => App.CloseTab(id);

  syncStatus = () => App.SyncStatus() as unknown as Promise<SyncStatus>;
  saveSyncConfig = (c: SyncConfig) => App.SaveSyncConfig(c as any) as unknown as Promise<SyncConfig>;
  syncNow = (password: string) => App.SyncNow(password) as unknown as Promise<SyncResult>;

  listScratches = () => App.ListScratches() as unknown as Promise<ScratchInfo[]>;
  openScratch = (id: string) => App.OpenScratch(id) as unknown as Promise<TabState>;
  renameScratch = (id: string, name: string) => App.RenameScratch(id, name);
  createScratch = (id: string, name: string, connId: string, db: string, schema: string, table: string, content: string) =>
    App.CreateScratch(id, name, connId, db, schema, table, content) as unknown as Promise<TabState>;
  linkScratch = (id: string, connId: string, db: string, schema: string, table: string) => App.LinkScratch(id, connId, db, schema, table);
  deleteScratch = (id: string) => App.DeleteScratch(id);
  duplicateScratch = (id: string, newId: string, name: string) => App.DuplicateScratch(id, newId, name) as unknown as Promise<TabState>;
  exportScratch = (id: string) => App.ExportScratch(id);
  importScratch = (newId: string, connId: string, db: string) => App.ImportScratch(newId, connId, db) as unknown as Promise<TabState>;
  releaseTabSession = (id: string) => App.ReleaseTabSession(id);
}

/** Errors from Wails arrive as plain strings. */
export function errorText(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message;
  return String(e);
}
