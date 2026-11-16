import { Injectable, inject } from '@angular/core';
import { Dialog } from '@angular/cdk/dialog';
import { Api, errorText } from './api';
import { ConnectionStore } from './connection.store';
import { EditorBridge } from './editor-bridge';
import { RunStore } from './run.store';
import { SchemaStore } from './schema.store';
import { TabStore } from './tab.store';
import { TableBridge } from './table-bridge';
import { TxStore } from './tx.store';
import { ScratchStore } from './scratch.store';
import { Toasts } from './toast';
import { Ui, MOD } from './ui';
import { Confirm } from '../shared/confirm';
import { Prompt } from '../shared/prompt';
import { createTableTemplate, qualified, selectTop } from './sql';
import type { ConnectionView, DbTable } from './models';
import { ClipboardSetText } from '../../../wailsjs/runtime/runtime';
import { ConnectionDialog } from '../features/connections/connection-dialog';
import { SettingsDialog } from '../features/settings/settings-dialog';

export interface Command {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

/** Every user action lives here so hotkeys, menus and the palette share one implementation. */
@Injectable({ providedIn: 'root' })
export class Commands {
  private api = inject(Api);
  private tabStore = inject(TabStore);
  private runStore = inject(RunStore);
  private connectionStore = inject(ConnectionStore);
  private schemaStore = inject(SchemaStore);
  private editorBridge = inject(EditorBridge);
  private toastService = inject(Toasts);
  private dialog = inject(Dialog);
  private uiState = inject(Ui);
  private tableBridge = inject(TableBridge);
  private transactionStore = inject(TxStore);
  private scratchStore = inject(ScratchStore);
  private confirmDialog = inject(Confirm);
  private promptDialog = inject(Prompt);

  public list(): Command[] {
    const active = this.tabStore.active();
    const connection = this.connectionStore.get(active?.connId);
    const commands: Command[] = [
      { id: 'run', label: 'Run statement at cursor', hint: `${MOD}↵`, run: () => this.run() },
      { id: 'run-all', label: 'Run whole script', hint: `${MOD}⇧↵`, run: () => this.runAll() },
      { id: 'cancel', label: 'Cancel running query', hint: 'Esc', run: () => this.cancel() },
      { id: 'new-tab', label: 'New tab', hint: `${MOD}T`, run: () => this.newTab() },
      { id: 'close-tab', label: 'Close tab', hint: `${MOD}W`, run: () => this.closeTab() },
      {
        id: 'toggle-sidebar',
        label: 'Toggle schema sidebar',
        hint: `${MOD}B`,
        run: () => this.uiState.sidebarOpen.update((open) => !open),
      },
      {
        id: 'toggle-scratches',
        label:
          this.uiState.scratchPosition() === 'left'
            ? 'Move scratch files under the explorer'
            : 'Move scratch files to a left panel',
        run: () => this.uiState.toggleScratchPosition(),
      },
      {
        id: 'toggle-inline-results',
        label: this.uiState.inlineResults()
          ? 'Show query results in the bottom panel'
          : 'Show query results inline, under each statement',
        run: () => this.uiState.inlineResults.update((open) => !open),
      },
      { id: 'new-connection', label: 'New connection…', run: () => this.newConnection() },
      {
        id: 'import-scratch',
        label: 'Open a .sql file as scratch…',
        run: () => void this.scratchStore.importFile(),
      },
      { id: 'settings', label: 'Settings…', hint: `${MOD},`, run: () => this.openSettings() },
    ];
    if (active?.kind === 'sql') {
      commands.push(
        {
          id: 'save-scratch',
          label: `Save ${active.name}`,
          hint: `${MOD}S`,
          run: () => void this.scratchStore.save(active.id),
        },
        {
          id: 'export-scratch',
          label: `Save ${active.name} as file…`,
          run: () => void this.scratchStore.exportFile(active.id),
        },
        {
          id: 'duplicate-scratch',
          label: `Duplicate ${active.name}`,
          run: () => void this.scratchStore.duplicate(active.id),
        },
        {
          id: 'delete-scratch',
          label: `Delete ${active.name}…`,
          run: () => void this.scratchStore.remove(active.id),
        },
      );
      if (this.uiState.inlineResults() && this.runStore.get(active.id).inline.length) {
        commands.push({
          id: 'clear-inline',
          label: `Clear inline results of ${active.name}`,
          run: () => this.runStore.dismissInline(active.id),
        });
      }
    }
    if (active && !connection?.readOnly) {
      const transaction = this.transactionStore.get(active.id);
      if (transaction.open) {
        commands.push(
          {
            id: 'commit',
            label: `Commit transaction (${transaction.statements} statements)`,
            run: () => void this.transactionStore.commit(),
          },
          {
            id: 'rollback',
            label: 'Roll back transaction',
            run: () => void this.transactionStore.rollback(),
          },
        );
      }
      commands.push(
        active.txMode === 'manual'
          ? {
              id: 'transaction-auto',
              label: 'Transactions: switch to auto-commit',
              run: () => this.transactionStore.setMode(active.id, 'auto'),
            }
          : {
              id: 'transaction-manual',
              label: 'Transactions: switch to manual (commit / rollback)',
              run: () => this.transactionStore.setMode(active.id, 'manual'),
            },
      );
    }
    if (connection) {
      commands.push(
        {
          id: 'edit-connection',
          label: `Edit connection “${connection.name}”…`,
          run: () => this.editConnection(connection),
        },
        {
          id: 'toggle-read-only',
          label: `${connection.readOnly ? 'Allow writes on' : 'Make read-only'} “${connection.name}”`,
          run: () => void this.toggleReadOnly(connection),
        },
        connection.connected
          ? {
              id: 'disconnect',
              label: `Disconnect “${connection.name}”`,
              run: () => void this.connectionStore.disconnect(connection.id),
            }
          : {
              id: 'connect',
              label: `Connect “${connection.name}”`,
              run: () => void this.connectionStore.connect(connection.id),
            },
        {
          id: 'refresh-schema',
          label: `Refresh schema of “${connection.name}”`,
          run: () => void this.schemaStore.refresh(connection.id),
        },
      );
    }
    return commands;
  }

  /** In a data tab, Run reloads the grid. */
  public run() {
    if (this.tableHandle()) return this.tableHandle()!.refresh();
    void this.runStore.run('cursor');
  }
  public runAll() {
    if (this.tableHandle()) return this.tableHandle()!.refresh();
    void this.runStore.run('all');
  }

  /** ⌘S: applies pending edits in a data tab; elsewhere it only forces the autosave. */
  public save() {
    const handle = this.tableHandle();
    if (handle) handle.apply();
    else if (this.tabStore.active()?.kind === 'sql')
      void this.scratchStore.save(this.tabStore.activeId());
  }

  private tableHandle() {
    const tab = this.tabStore.active();
    return tab?.kind === 'table' ? this.tableBridge.get(tab.id) : undefined;
  }

  /** Opens (or focuses) the data editor of a table. */
  public openTableData(connectionId: string, database: string, table: DbTable) {
    const existing = this.tabStore
      .tabs()
      .find(
        (tab) =>
          tab.kind === 'table' &&
          tab.connId === connectionId &&
          (tab.database || '') === (database || '') &&
          tab.table?.schema === table.schema &&
          tab.table?.name === table.name,
      );
    if (existing) return this.tabStore.activate(existing.id);
    this.tabStore.createTable(connectionId, database, {
      schema: table.schema,
      name: table.name,
      type: table.type,
    });
  }
  public cancel() {
    this.runStore.cancel();
  }

  /** New tab; without arguments it reuses the current tab's connection and database. */
  public newTab(connectionId?: string, database?: string) {
    const active = this.tabStore.active();
    const targetConnection =
      connectionId ?? active?.connId ?? this.connectionStore.connected()[0]?.id ?? '';
    const targetDatabase = database ?? (targetConnection === active?.connId ? active.database : '');
    this.tabStore.create(targetConnection, '', undefined, targetDatabase);
    queueMicrotask(() => this.editorBridge.focus());
  }

  public async closeTab(tabId = this.tabStore.activeId()) {
    const tab = this.tabStore.get(tabId);
    if (
      tab?.kind === 'table' &&
      tab.dirty &&
      !(await this.confirmDialog.ask(`Discard unsaved changes to ${tab.name}?`, {
        title: 'Discard changes',
        confirmLabel: 'Discard',
        danger: true,
      }))
    )
      return;
    const transaction = this.transactionStore.get(tabId);
    if (
      transaction.open &&
      !(await this.confirmDialog.ask(
        `${tab?.name ?? 'This tab'} has an open transaction (${transaction.statements} statements). Closing rolls it back.`,
        { title: 'Close tab', confirmLabel: 'Close anyway', danger: true },
      ))
    )
      return;
    this.transactionStore.forget(tabId);
    this.runStore.forget(tabId);
    void this.tabStore.close(tabId);
  }

  public newConnection() {
    this.openConnectionDialog();
  }
  public editConnection(connection: ConnectionView) {
    this.openConnectionDialog(connection);
  }

  /**
   * Turns read-only on or off. Saving reopens a live connection, which rolls
   * back its open transactions, so that is confirmed first.
   */
  public async toggleReadOnly(connection: ConnectionView) {
    const readOnly = !connection.readOnly;
    const openTabs = this.tabStore
      .tabs()
      .filter((tab) => tab.connId === connection.id && this.transactionStore.get(tab.id).open);
    if (
      openTabs.length &&
      !(await this.confirmDialog.ask(
        `${openTabs.length === 1 ? `${openTabs[0].name} has an open transaction` : `${openTabs.length} tabs have open transactions`} on “${connection.name}”. Reconnecting rolls ${openTabs.length === 1 ? 'it' : 'them'} back.`,
        {
          title: readOnly ? 'Make read-only' : 'Allow writes',
          confirmLabel: 'Roll back and switch',
          danger: true,
        },
      ))
    )
      return;
    try {
      await this.connectionStore.save({ ...connection, readOnly });
      for (const tab of openTabs) this.transactionStore.forget(tab.id);
      this.toastService.success(
        `${connection.name} is now ${readOnly ? 'read-only' : 'writable'}.`,
      );
    } catch (error) {
      this.toastService.error(errorText(error));
    }
  }

  public openSettings() {
    this.dialog.open(SettingsDialog, { width: 'auto', maxWidth: '94vw' });
  }

  private openConnectionDialog(connection?: ConnectionView) {
    const dialogRef = this.dialog.open<ConnectionView | undefined>(ConnectionDialog, {
      data: connection,
      width: '520px',
      maxWidth: '94vw',
    });
    dialogRef.closed.subscribe((created) => {
      if (!created) return;
      // A brand-new connection is attached to the current tab when it has none.
      const tab = this.tabStore.active();
      if (!connection && tab && !this.connectionStore.get(tab.connId))
        this.tabStore.setConnection(tab.id, created.id);
      void this.connectionStore.connect(created.id);
    });
  }

  /** Opens a new tab with SELECT * … on the table's database and runs it. */
  public async selectTop(connectionId: string, table: DbTable, database = '') {
    const connection = this.connectionStore.get(connectionId);
    if (!connection) return;
    const defaultSchema = this.schemaStore.get(
      this.schemaStore.scopeFor(connectionId, database),
    )?.defaultSchema;
    const statement = selectTop(
      connection.kind,
      qualified(connection.kind, table.schema, table.name, defaultSchema),
    );
    if (
      !(await this.scratchStore.createIn(
        { connId: connectionId, database, schema: table.schema, table: table.name },
        statement,
      ))
    )
      return;
    // Let the editor pick up the new tab's model before running.
    setTimeout(() => this.runAll(), 0);
  }

  public async showDDL(connectionId: string, table: DbTable, database = '') {
    try {
      const definition = await this.api.tableDDL(
        connectionId,
        database,
        table.schema,
        table.name,
        table.type,
      );
      await this.scratchStore.createIn(
        { connId: connectionId, database, schema: table.schema, table: table.name },
        definition.trim() + '\n',
        this.scratchStore.freeName(`${table.name}.ddl`),
      );
    } catch (error) {
      this.toastService.error(errorText(error));
    }
  }

  /** Drops a table or view after a confirmation, then refreshes the explorer. */
  public async dropTable(connectionId: string, table: DbTable, database = '') {
    const objectKind = table.type === 'view' ? 'view' : 'table';
    const label = table.schema ? `${table.schema}.${table.name}` : table.name;
    if (
      !(await this.confirmDialog.ask(`Drop the ${objectKind} ${label}?\n\nThis cannot be undone.`, {
        title: `Drop ${objectKind}`,
        confirmLabel: `Drop ${objectKind}`,
        danger: true,
      }))
    )
      return;
    try {
      await this.api.dropTable(connectionId, database, table.schema, table.name, table.type);
      this.toastService.success(`Dropped ${objectKind} ${label}`);
      await this.schemaStore.refresh(connectionId);
      // Close its data tabs: the table no longer exists.
      for (const tab of this.tabStore
        .tabs()
        .filter(
          (tab) =>
            tab.kind === 'table' &&
            tab.connId === connectionId &&
            (tab.database || '') === (database || '') &&
            tab.table?.schema === table.schema &&
            tab.table?.name === table.name,
        )) {
        this.transactionStore.forget(tab.id);
        this.runStore.forget(tab.id);
        void this.tabStore.close(tab.id);
      }
    } catch (error) {
      this.toastService.error(errorText(error));
    }
  }

  /** Copies a table's or view's DDL to the clipboard. */
  public async copyDDL(connectionId: string, table: DbTable, database = '') {
    try {
      const definition = await this.api.tableDDL(
        connectionId,
        database,
        table.schema,
        table.name,
        table.type,
      );
      if (await this.copy(definition.trim() + '\n'))
        this.toastService.success(`Copied the DDL of ${table.name}`);
    } catch (error) {
      this.toastService.error(errorText(error));
    }
  }

  /** Opens a scratch with a CREATE TABLE to complete and run, in the given schema. */
  public async newTable(connectionId: string, schema: string, database = '') {
    const connection = this.connectionStore.get(connectionId);
    if (!connection) return;
    const name = await this.promptDialog.ask({
      title: 'New table',
      label: schema ? `Table name in ${schema}` : 'Table name',
      value: 'new_table',
      confirmLabel: 'Open script',
    });
    if (!name) return;
    const defaultSchema = this.schemaStore.get(
      this.schemaStore.scopeFor(connectionId, database),
    )?.defaultSchema;
    const statement = createTableTemplate(
      connection.kind,
      qualified(connection.kind, schema, name, defaultSchema),
    );
    await this.scratchStore.createIn(
      { connId: connectionId, database },
      statement,
      this.scratchStore.freeName(`create_${name}`),
    );
  }

  /** Creates a database on the connection's server, then shows it in the explorer. */
  public async createDatabase(connectionId: string) {
    const name = await this.promptDialog.ask({
      title: 'New database',
      label: 'Database name',
      confirmLabel: 'Create',
    });
    if (!name) return;
    try {
      await this.api.createDatabase(connectionId, name);
      this.toastService.success(`Created database ${name}`);
      await this.schemaStore.refresh(connectionId);
    } catch (error) {
      this.toastService.error(errorText(error));
    }
  }

  /** Drops a database after a confirmation; its tabs are closed (their sessions are gone). */
  public async dropDatabase(connectionId: string, database: string) {
    const affectedTabs = this.tabStore
      .tabs()
      .filter((tab) => tab.connId === connectionId && tab.database === database);
    const warning = affectedTabs.length
      ? `\n\n${affectedTabs.length} tab${affectedTabs.length === 1 ? '' : 's'} using it will lose ${affectedTabs.length === 1 ? 'its' : 'their'} session, and data tabs on it will close.`
      : '';
    if (
      !(await this.confirmDialog.ask(
        `Drop the database ${database}?\n\nThis cannot be undone.${warning}`,
        { title: 'Drop database', confirmLabel: 'Drop database', danger: true },
      ))
    )
      return;
    try {
      await this.api.dropDatabase(connectionId, database);
      this.toastService.success(`Dropped database ${database}`);
      for (const tab of affectedTabs) {
        this.transactionStore.forget(tab.id);
        this.runStore.forget(tab.id);
        if (tab.kind === 'table') void this.tabStore.close(tab.id);
      }
      await this.schemaStore.refresh(connectionId);
    } catch (error) {
      this.toastService.error(errorText(error));
    }
  }

  /** New empty scratch filed under a table. */
  public newScratchFor(connectionId: string, table: DbTable, database = '') {
    void this.scratchStore.createIn({
      connId: connectionId,
      database,
      schema: table.schema,
      table: table.name,
    });
  }

  public insertName(connectionId: string, schema: string, name: string, database = '') {
    const connection = this.connectionStore.get(connectionId);
    if (!connection) return;
    this.editorBridge.insert(
      qualified(
        connection.kind,
        schema,
        name,
        this.schemaStore.get(this.schemaStore.scopeFor(connectionId, database))?.defaultSchema,
      ),
    );
    this.editorBridge.focus();
  }

  /** Copies text to the clipboard; false (after a toast) when it failed. */
  public async copy(text: string): Promise<boolean> {
    try {
      if (!(await ClipboardSetText(text))) throw new Error();
      return true;
    } catch {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        this.toastService.error('Clipboard is not available');
        return false;
      }
    }
  }
}
