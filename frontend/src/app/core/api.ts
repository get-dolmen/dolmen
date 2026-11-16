import { Injectable } from '@angular/core';
import * as App from '../../../wailsjs/go/main/App';
import type {
  ConnectionConfig,
  ConnectionFolder,
  ConnectionView,
  DbColumn,
  DbTable,
  ExecResponse,
  FetchResult,
  ApplyResult,
  DatabaseList,
  TxStatus,
  ScratchInfo,
  TabState,
  HistoryEntry,
  SchemaList,
  TableChange,
  TablePage,
  Workspace,
  SyncConfig,
  SyncResult,
  SyncStatus,
  McpConfig,
  McpStatus,
} from './models';

/** Thin typed wrapper over the generated Wails bindings. */
@Injectable({ providedIn: 'root' })
export class Api {
  public listConnections = () => App.ListConnections() as unknown as Promise<ConnectionView[]>;
  public saveConnection = (connection: ConnectionConfig) =>
    App.SaveConnection(connection as any) as unknown as Promise<ConnectionView>;
  public deleteConnection = (connectionId: string) => App.DeleteConnection(connectionId);
  public testConnection = (connection: ConnectionConfig) => App.TestConnection(connection as any);
  public connect = (connectionId: string) => App.Connect(connectionId);
  public disconnect = (connectionId: string) => App.Disconnect(connectionId);
  public pickSQLiteFile = () => App.PickSQLiteFile();
  public pickSSHKey = () => App.PickSSHKey();

  public listFolders = () => App.ListFolders() as unknown as Promise<ConnectionFolder[]>;
  public saveFolder = (folder: ConnectionFolder) =>
    App.SaveFolder(folder as any) as unknown as Promise<ConnectionFolder>;
  public deleteFolder = (folderId: string) => App.DeleteFolder(folderId);
  public moveConnectionToFolder = (connectionId: string, folderId: string) =>
    App.MoveConnectionToFolder(connectionId, folderId);

  public listDatabases = (connectionId: string) =>
    App.ListDatabases(connectionId) as Promise<DatabaseList>;
  public listSchemas = (connectionId: string, database: string) =>
    App.ListSchemas(connectionId, database) as Promise<SchemaList>;
  public listTables = (connectionId: string, database: string, schema: string) =>
    App.ListTables(connectionId, database, schema) as Promise<DbTable[]>;
  public listColumns = (connectionId: string, database: string, schema: string, table = '') =>
    App.ListColumns(connectionId, database, schema, table) as Promise<DbColumn[]>;
  public tableDDL = (
    connectionId: string,
    database: string,
    schema: string,
    table: string,
    type: string,
  ) => App.TableDDL(connectionId, database, schema, table, type);
  public dropTable = (
    connectionId: string,
    database: string,
    schema: string,
    table: string,
    type: string,
  ) => App.DropTable(connectionId, database, schema, table, type);
  public quoteIdentifierForConnection = (connectionId: string, name: string) =>
    App.QuoteIdent(connectionId, name);
  public createDatabase = (connectionId: string, name: string) =>
    App.CreateDatabase(connectionId, name);
  public dropDatabase = (connectionId: string, name: string) =>
    App.DropDatabase(connectionId, name);

  public readTable = (
    tabId: string,
    connectionId: string,
    database: string,
    manual: boolean,
    request: {
      schema: string;
      table: string;
      type: string;
      where: string;
      orderBy: string;
      offset: number;
      limit: number;
    },
  ) =>
    App.ReadTable(tabId, connectionId, database, manual, request as any) as unknown as Promise<{
      page: TablePage;
      tx: TxStatus;
    }>;
  public countTableRows = (
    tabId: string,
    connectionId: string,
    database: string,
    manual: boolean,
    request: {
      schema: string;
      table: string;
      type: string;
      where: string;
      orderBy: string;
      offset: number;
      limit: number;
    },
  ) =>
    App.CountTableRows(
      tabId,
      connectionId,
      database,
      manual,
      request as any,
    ) as unknown as Promise<{ count: number; tx: TxStatus }>;
  public applyTableChanges = (
    tabId: string,
    connectionId: string,
    database: string,
    manual: boolean,
    request: { schema: string; table: string; changes: TableChange[] },
  ) =>
    App.ApplyTableChanges(
      tabId,
      connectionId,
      database,
      manual,
      request as any,
    ) as unknown as Promise<{ result: ApplyResult; tx: TxStatus }>;

  public commit = (tabId: string) => App.Commit(tabId) as Promise<TxStatus>;
  public rollback = (tabId: string) => App.Rollback(tabId) as Promise<TxStatus>;

  public execute = (request: {
    tabId: string;
    connId: string;
    database: string;
    sql: string;
    cursor: number;
    maxRows: number;
    manual: boolean;
  }) => App.Execute(request as any) as unknown as Promise<ExecResponse>;
  public cancel = (tabId: string) => App.Cancel(tabId);
  public fetchMore = (tabId: string, resultId: string, rowCount: number) =>
    App.FetchMore(tabId, resultId, rowCount) as Promise<FetchResult>;
  public exportResult = (tabId: string, resultId: string, format: 'csv' | 'json') =>
    App.ExportResult(tabId, resultId, format);

  public version = () =>
    App.Version() as Promise<{ version: string; repo: string; commit: string }>;
  public checkForUpdate = () =>
    App.CheckForUpdate() as Promise<{
      current: string;
      latest: string;
      newer: boolean;
      url: string;
      notes?: string;
      asset?: { name: string; size: number; url: string };
    }>;
  public installUpdate = (tag: string) =>
    App.InstallUpdate(tag) as unknown as Promise<{
      version: string;
      relaunch: boolean;
      message?: string;
    }>;
  public restartApp = () => App.RestartApp();
  public openReleasePage = (url: string) => App.OpenReleasePage(url);

  public listHistory = (connectionId: string, search: string, limit = 200) =>
    App.ListHistory(connectionId, search, limit) as unknown as Promise<HistoryEntry[]>;
  public clearHistory = (connectionId: string) => App.ClearHistory(connectionId);

  public loadWorkspace = () => App.LoadWorkspace() as unknown as Promise<Workspace>;
  public saveWorkspaceLayout = (workspace: Workspace) => App.SaveWorkspaceLayout(workspace as any);
  public saveTabContent = (tabId: string, content: string) => App.SaveTabContent(tabId, content);
  public closeTab = (tabId: string) => App.CloseTab(tabId);

  public mcpStatus = () => App.MCPStatus() as unknown as Promise<McpStatus>;
  public saveMcpConfig = (config: McpConfig) =>
    App.SaveMCPConfig(config as any) as unknown as Promise<McpStatus>;
  public regenerateMcpToken = () => App.RegenerateMCPToken() as unknown as Promise<McpStatus>;

  public syncStatus = () => App.SyncStatus() as unknown as Promise<SyncStatus>;
  public saveSyncConfig = (config: SyncConfig) =>
    App.SaveSyncConfig(config as any) as unknown as Promise<SyncConfig>;
  public syncNow = (password: string) => App.SyncNow(password) as unknown as Promise<SyncResult>;

  public listScratches = () => App.ListScratches() as unknown as Promise<ScratchInfo[]>;
  public openScratch = (scratchId: string) =>
    App.OpenScratch(scratchId) as unknown as Promise<TabState>;
  public renameScratch = (scratchId: string, name: string) => App.RenameScratch(scratchId, name);
  public createScratch = (
    scratchId: string,
    name: string,
    connectionId: string,
    database: string,
    schema: string,
    table: string,
    content: string,
  ) =>
    App.CreateScratch(
      scratchId,
      name,
      connectionId,
      database,
      schema,
      table,
      content,
    ) as unknown as Promise<TabState>;
  public linkScratch = (
    scratchId: string,
    connectionId: string,
    database: string,
    schema: string,
    table: string,
  ) => App.LinkScratch(scratchId, connectionId, database, schema, table);
  public setScratchLock = (scratchId: string, locked: boolean) =>
    App.SetScratchLock(scratchId, locked);
  public deleteScratch = (scratchId: string) => App.DeleteScratch(scratchId);
  public duplicateScratch = (scratchId: string, newScratchId: string, name: string) =>
    App.DuplicateScratch(scratchId, newScratchId, name) as unknown as Promise<TabState>;
  public exportScratch = (scratchId: string) => App.ExportScratch(scratchId);
  public importScratch = (newScratchId: string, connectionId: string, database: string) =>
    App.ImportScratch(newScratchId, connectionId, database) as unknown as Promise<TabState>;
  public releaseTabSession = (tabId: string) => App.ReleaseTabSession(tabId);
}

/** Errors from Wails arrive as plain strings. */
export function errorText(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return String(error);
}
