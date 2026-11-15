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
  public listConnections = () => App.ListConnections() as unknown as Promise<ConnectionView[]>;
  public saveConnection = (c: ConnectionConfig) => App.SaveConnection(c as any) as unknown as Promise<ConnectionView>;
  public deleteConnection = (id: string) => App.DeleteConnection(id);
  public testConnection = (c: ConnectionConfig) => App.TestConnection(c as any);
  public connect = (id: string) => App.Connect(id);
  public disconnect = (id: string) => App.Disconnect(id);
  public pickSQLiteFile = () => App.PickSQLiteFile();
  public pickSSHKey = () => App.PickSSHKey();

  public listFolders = () => App.ListFolders() as unknown as Promise<ConnectionFolder[]>;
  public saveFolder = (f: ConnectionFolder) => App.SaveFolder(f as any) as unknown as Promise<ConnectionFolder>;
  public deleteFolder = (id: string) => App.DeleteFolder(id);
  public moveConnectionToFolder = (connId: string, folderId: string) => App.MoveConnectionToFolder(connId, folderId);

  public listDatabases = (connId: string) => App.ListDatabases(connId) as Promise<DatabaseList>;
  public listSchemas = (connId: string, db: string) => App.ListSchemas(connId, db) as Promise<SchemaList>;
  public listTables = (connId: string, db: string, schema: string) => App.ListTables(connId, db, schema) as Promise<DbTable[]>;
  public listColumns = (connId: string, db: string, schema: string, table = '') =>
    App.ListColumns(connId, db, schema, table) as Promise<DbColumn[]>;
  public tableDDL = (connId: string, db: string, schema: string, table: string, type: string) =>
    App.TableDDL(connId, db, schema, table, type);
  public dropTable = (connId: string, db: string, schema: string, table: string, type: string) =>
    App.DropTable(connId, db, schema, table, type);
  public quoteIdent = (connId: string, name: string) => App.QuoteIdent(connId, name);
  public createDatabase = (connId: string, name: string) => App.CreateDatabase(connId, name);
  public dropDatabase = (connId: string, name: string) => App.DropDatabase(connId, name);

  public readTable = (tabId: string, connId: string, db: string, manual: boolean,
    req: { schema: string; table: string; type: string; where: string; orderBy: string; offset: number; limit: number }) =>
    App.ReadTable(tabId, connId, db, manual, req as any) as unknown as Promise<{ page: TablePage; tx: TxStatus }>;
  public countTableRows = (tabId: string, connId: string, db: string, manual: boolean,
    req: { schema: string; table: string; type: string; where: string; orderBy: string; offset: number; limit: number }) =>
    App.CountTableRows(tabId, connId, db, manual, req as any) as unknown as Promise<{ count: number; tx: TxStatus }>;
  public applyTableChanges = (tabId: string, connId: string, db: string, manual: boolean, req: { schema: string; table: string; changes: TableChange[] }) =>
    App.ApplyTableChanges(tabId, connId, db, manual, req as any) as unknown as Promise<{ result: ApplyResult; tx: TxStatus }>;

  public commit = (tabId: string) => App.Commit(tabId) as Promise<TxStatus>;
  public rollback = (tabId: string) => App.Rollback(tabId) as Promise<TxStatus>;

  public execute = (req: { tabId: string; connId: string; database: string; sql: string; cursor: number; maxRows: number; manual: boolean }) =>
    App.Execute(req as any) as unknown as Promise<ExecResponse>;
  public cancel = (tabId: string) => App.Cancel(tabId);
  public fetchMore = (tabId: string, resultId: string, n: number) => App.FetchMore(tabId, resultId, n) as Promise<FetchResult>;
  public exportResult = (tabId: string, resultId: string, format: 'csv' | 'json') => App.ExportResult(tabId, resultId, format);

  public version = () => App.Version() as Promise<{ version: string; repo: string; commit: string }>;
  public checkForUpdate = () => App.CheckForUpdate() as Promise<{
    current: string; latest: string; newer: boolean; url: string; notes?: string;
    asset?: { name: string; size: number; url: string };
  }>;
  public installUpdate = (tag: string) => App.InstallUpdate(tag) as unknown as Promise<{ version: string; relaunch: boolean; message?: string }>;
  public restartApp = () => App.RestartApp();
  public openReleasePage = (url: string) => App.OpenReleasePage(url);

  public listHistory = (connId: string, search: string, limit = 200) =>
    App.ListHistory(connId, search, limit) as unknown as Promise<HistoryEntry[]>;
  public clearHistory = (connId: string) => App.ClearHistory(connId);

  public loadWorkspace = () => App.LoadWorkspace() as unknown as Promise<Workspace>;
  public saveWorkspaceLayout = (ws: Workspace) => App.SaveWorkspaceLayout(ws as any);
  public saveTabContent = (id: string, content: string) => App.SaveTabContent(id, content);
  public closeTab = (id: string) => App.CloseTab(id);

  public syncStatus = () => App.SyncStatus() as unknown as Promise<SyncStatus>;
  public saveSyncConfig = (c: SyncConfig) => App.SaveSyncConfig(c as any) as unknown as Promise<SyncConfig>;
  public syncNow = (password: string) => App.SyncNow(password) as unknown as Promise<SyncResult>;

  public listScratches = () => App.ListScratches() as unknown as Promise<ScratchInfo[]>;
  public openScratch = (id: string) => App.OpenScratch(id) as unknown as Promise<TabState>;
  public renameScratch = (id: string, name: string) => App.RenameScratch(id, name);
  public createScratch = (id: string, name: string, connId: string, db: string, schema: string, table: string, content: string) =>
    App.CreateScratch(id, name, connId, db, schema, table, content) as unknown as Promise<TabState>;
  public linkScratch = (id: string, connId: string, db: string, schema: string, table: string) => App.LinkScratch(id, connId, db, schema, table);
  public setScratchLock = (id: string, locked: boolean) => App.SetScratchLock(id, locked);
  public deleteScratch = (id: string) => App.DeleteScratch(id);
  public duplicateScratch = (id: string, newId: string, name: string) => App.DuplicateScratch(id, newId, name) as unknown as Promise<TabState>;
  public exportScratch = (id: string) => App.ExportScratch(id);
  public importScratch = (newId: string, connId: string, db: string) => App.ImportScratch(newId, connId, db) as unknown as Promise<TabState>;
  public releaseTabSession = (id: string) => App.ReleaseTabSession(id);
}

/** Errors from Wails arrive as plain strings. */
export function errorText(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message;
  return String(e);
}
