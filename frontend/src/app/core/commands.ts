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
  private tabs = inject(TabStore);
  private runs = inject(RunStore);
  private conns = inject(ConnectionStore);
  private schema = inject(SchemaStore);
  private editor = inject(EditorBridge);
  private toasts = inject(Toasts);
  private dialog = inject(Dialog);
  private ui = inject(Ui);
  private tables = inject(TableBridge);
  private tx = inject(TxStore);
  private scratches = inject(ScratchStore);
  private confirm = inject(Confirm);
  private prompt = inject(Prompt);

  public list(): Command[] {
    const active = this.tabs.active();
    const conn = this.conns.get(active?.connId);
    const cmds: Command[] = [
      { id: 'run', label: 'Run statement at cursor', hint: `${MOD}↵`, run: () => this.run() },
      { id: 'run-all', label: 'Run whole script', hint: `${MOD}⇧↵`, run: () => this.runAll() },
      { id: 'cancel', label: 'Cancel running query', hint: 'Esc', run: () => this.cancel() },
      { id: 'new-tab', label: 'New tab', hint: `${MOD}T`, run: () => this.newTab() },
      { id: 'close-tab', label: 'Close tab', hint: `${MOD}W`, run: () => this.closeTab() },
      { id: 'toggle-sidebar', label: 'Toggle schema sidebar', hint: `${MOD}B`, run: () => this.ui.sidebarOpen.update((v) => !v) },
      {
        id: 'toggle-scratches',
        label: this.ui.scratchPosition() === 'left' ? 'Move scratch files under the explorer' : 'Move scratch files to a left panel',
        run: () => this.ui.toggleScratchPosition(),
      },
      {
        id: 'toggle-inline-results',
        label: this.ui.inlineResults() ? 'Show query results in the bottom panel' : 'Show query results inline, under each statement',
        run: () => this.ui.inlineResults.update((v) => !v),
      },
      { id: 'new-connection', label: 'New connection…', run: () => this.newConnection() },
      { id: 'import-scratch', label: 'Open a .sql file as scratch…', run: () => void this.scratches.importFile() },
      { id: 'settings', label: 'Settings…', hint: `${MOD},`, run: () => this.openSettings() },
    ];
    if (active?.kind === 'sql') {
      cmds.push(
        { id: 'save-scratch', label: `Save ${active.name}`, hint: `${MOD}S`, run: () => void this.scratches.save(active.id) },
        { id: 'export-scratch', label: `Save ${active.name} as file…`, run: () => void this.scratches.exportFile(active.id) },
        { id: 'duplicate-scratch', label: `Duplicate ${active.name}`, run: () => void this.scratches.duplicate(active.id) },
        { id: 'delete-scratch', label: `Delete ${active.name}…`, run: () => void this.scratches.remove(active.id) },
      );
      if (this.ui.inlineResults() && this.runs.get(active.id).inline.length) {
        cmds.push({ id: 'clear-inline', label: `Clear inline results of ${active.name}`, run: () => this.runs.dismissInline(active.id) });
      }
    }
    if (active && !conn?.readOnly) {
      const tx = this.tx.get(active.id);
      if (tx.open) {
        cmds.push(
          { id: 'commit', label: `Commit transaction (${tx.statements} statements)`, run: () => void this.tx.commit() },
          { id: 'rollback', label: 'Roll back transaction', run: () => void this.tx.rollback() },
        );
      }
      cmds.push(active.txMode === 'manual'
        ? { id: 'tx-auto', label: 'Transactions: switch to auto-commit', run: () => this.tx.setMode(active.id, 'auto') }
        : { id: 'tx-manual', label: 'Transactions: switch to manual (commit / rollback)', run: () => this.tx.setMode(active.id, 'manual') });
    }
    if (conn) {
      cmds.push(
        { id: 'edit-connection', label: `Edit connection “${conn.name}”…`, run: () => this.editConnection(conn) },
        { id: 'toggle-read-only', label: `${conn.readOnly ? 'Allow writes on' : 'Make read-only'} “${conn.name}”`, run: () => void this.toggleReadOnly(conn) },
        conn.connected
          ? { id: 'disconnect', label: `Disconnect “${conn.name}”`, run: () => void this.conns.disconnect(conn.id) }
          : { id: 'connect', label: `Connect “${conn.name}”`, run: () => void this.conns.connect(conn.id) },
        { id: 'refresh-schema', label: `Refresh schema of “${conn.name}”`, run: () => void this.schema.refresh(conn.id) },
      );
    }
    return cmds;
  }

  /** In a data tab, Run reloads the grid. */
  public run() {
    if (this.tableHandle()) return this.tableHandle()!.refresh();
    void this.runs.run('cursor');
  }
  public runAll() {
    if (this.tableHandle()) return this.tableHandle()!.refresh();
    void this.runs.run('all');
  }

  /** ⌘S: applies pending edits in a data tab; elsewhere it only forces the autosave. */
  public save() {
    const h = this.tableHandle();
    if (h) h.apply();
    else if (this.tabs.active()?.kind === 'sql') void this.scratches.save(this.tabs.activeId());
  }

  private tableHandle() {
    const t = this.tabs.active();
    return t?.kind === 'table' ? this.tables.get(t.id) : undefined;
  }

  /** Opens (or focuses) the data editor of a table. */
  public openTableData(connId: string, database: string, t: DbTable) {
    const existing = this.tabs.tabs().find((x) => x.kind === 'table' && x.connId === connId && (x.database || '') === (database || '')
      && x.table?.schema === t.schema && x.table?.name === t.name);
    if (existing) return this.tabs.activate(existing.id);
    this.tabs.createTable(connId, database, { schema: t.schema, name: t.name, type: t.type });
  }
  public cancel() { this.runs.cancel(); }

  /** New tab; without arguments it reuses the current tab's connection and database. */
  public newTab(connId?: string, database?: string) {
    const active = this.tabs.active();
    const conn = connId ?? active?.connId ?? this.conns.connected()[0]?.id ?? '';
    const db = database ?? (conn === active?.connId ? active.database : '');
    this.tabs.create(conn, '', undefined, db);
    queueMicrotask(() => this.editor.focus());
  }

  public async closeTab(id = this.tabs.activeId()) {
    const t = this.tabs.get(id);
    if (t?.kind === 'table' && t.dirty
      && !(await this.confirm.ask(`Discard unsaved changes to ${t.name}?`, { title: 'Discard changes', confirmLabel: 'Discard', danger: true }))) return;
    const tx = this.tx.get(id);
    if (tx.open && !(await this.confirm.ask(
      `${t?.name ?? 'This tab'} has an open transaction (${tx.statements} statements). Closing rolls it back.`,
      { title: 'Close tab', confirmLabel: 'Close anyway', danger: true },
    ))) return;
    this.tx.forget(id);
    this.runs.forget(id);
    void this.tabs.close(id);
  }

  public newConnection() { this.openConnectionDialog(); }
  public editConnection(c: ConnectionView) { this.openConnectionDialog(c); }

  /**
   * Turns read-only on or off. Saving reopens a live connection, which rolls
   * back its open transactions, so that is confirmed first.
   */
  public async toggleReadOnly(c: ConnectionView) {
    const readOnly = !c.readOnly;
    const open = this.tabs.tabs().filter((t) => t.connId === c.id && this.tx.get(t.id).open);
    if (open.length && !(await this.confirm.ask(
      `${open.length === 1 ? `${open[0].name} has an open transaction` : `${open.length} tabs have open transactions`} on “${c.name}”. Reconnecting rolls ${open.length === 1 ? 'it' : 'them'} back.`,
      { title: readOnly ? 'Make read-only' : 'Allow writes', confirmLabel: 'Roll back and switch', danger: true },
    ))) return;
    try {
      await this.conns.save({ ...c, readOnly });
      for (const t of open) this.tx.forget(t.id);
      this.toasts.success(`${c.name} is now ${readOnly ? 'read-only' : 'writable'}.`);
    } catch (e) {
      this.toasts.error(errorText(e));
    }
  }

  public openSettings() {
    this.dialog.open(SettingsDialog, { width: 'auto', maxWidth: '94vw' });
  }

  private openConnectionDialog(c?: ConnectionView) {
    const ref = this.dialog.open<ConnectionView | undefined>(ConnectionDialog, { data: c, width: '520px', maxWidth: '94vw' });
    ref.closed.subscribe((saved) => {
      if (!saved) return;
      // A brand-new connection is attached to the current tab when it has none.
      const tab = this.tabs.active();
      if (!c && tab && !this.conns.get(tab.connId)) this.tabs.setConnection(tab.id, saved.id);
      void this.conns.connect(saved.id);
    });
  }

  /** Opens a new tab with SELECT * … on the table's database and runs it. */
  public async selectTop(connId: string, t: DbTable, database = '') {
    const conn = this.conns.get(connId);
    if (!conn) return;
    const def = this.schema.get(this.schema.scopeFor(connId, database))?.defaultSchema;
    const sql = selectTop(conn.kind, qualified(conn.kind, t.schema, t.name, def));
    if (!(await this.scratches.createIn({ connId, database, schema: t.schema, table: t.name }, sql))) return;
    // Let the editor pick up the new tab's model before running.
    setTimeout(() => this.runAll(), 0);
  }

  public async showDDL(connId: string, t: DbTable, database = '') {
    try {
      const ddl = await this.api.tableDDL(connId, database, t.schema, t.name, t.type);
      await this.scratches.createIn({ connId, database, schema: t.schema, table: t.name }, ddl.trim() + '\n', this.scratches.freeName(`${t.name}.ddl`));
    } catch (e) {
      this.toasts.error(errorText(e));
    }
  }

  /** Drops a table or view after a confirmation, then refreshes the explorer. */
  public async dropTable(connId: string, t: DbTable, database = '') {
    const what = t.type === 'view' ? 'view' : 'table';
    const label = t.schema ? `${t.schema}.${t.name}` : t.name;
    if (!(await this.confirm.ask(`Drop the ${what} ${label}?\n\nThis cannot be undone.`,
      { title: `Drop ${what}`, confirmLabel: `Drop ${what}`, danger: true }))) return;
    try {
      await this.api.dropTable(connId, database, t.schema, t.name, t.type);
      this.toasts.success(`Dropped ${what} ${label}`);
      await this.schema.refresh(connId);
      // Close its data tabs: the table no longer exists.
      for (const tab of this.tabs.tabs().filter((x) => x.kind === 'table' && x.connId === connId
        && (x.database || '') === (database || '') && x.table?.schema === t.schema && x.table?.name === t.name)) {
        this.tx.forget(tab.id);
        this.runs.forget(tab.id);
        void this.tabs.close(tab.id);
      }
    } catch (e) {
      this.toasts.error(errorText(e));
    }
  }

  /** Copies a table's or view's DDL to the clipboard. */
  public async copyDDL(connId: string, t: DbTable, database = '') {
    try {
      const ddl = await this.api.tableDDL(connId, database, t.schema, t.name, t.type);
      if (await this.copy(ddl.trim() + '\n')) this.toasts.success(`Copied the DDL of ${t.name}`);
    } catch (e) {
      this.toasts.error(errorText(e));
    }
  }

  /** Opens a scratch with a CREATE TABLE to complete and run, in the given schema. */
  public async newTable(connId: string, schema: string, database = '') {
    const conn = this.conns.get(connId);
    if (!conn) return;
    const name = await this.prompt.ask({ title: 'New table', label: schema ? `Table name in ${schema}` : 'Table name', value: 'new_table', confirmLabel: 'Open script' });
    if (!name) return;
    const def = this.schema.get(this.schema.scopeFor(connId, database))?.defaultSchema;
    const sql = createTableTemplate(conn.kind, qualified(conn.kind, schema, name, def));
    await this.scratches.createIn({ connId, database }, sql, this.scratches.freeName(`create_${name}`));
  }

  /** Creates a database on the connection's server, then shows it in the explorer. */
  public async createDatabase(connId: string) {
    const name = await this.prompt.ask({ title: 'New database', label: 'Database name', confirmLabel: 'Create' });
    if (!name) return;
    try {
      await this.api.createDatabase(connId, name);
      this.toasts.success(`Created database ${name}`);
      await this.schema.refresh(connId);
    } catch (e) {
      this.toasts.error(errorText(e));
    }
  }

  /** Drops a database after a confirmation; its tabs are closed (their sessions are gone). */
  public async dropDatabase(connId: string, database: string) {
    const tabs = this.tabs.tabs().filter((x) => x.connId === connId && x.database === database);
    const extra = tabs.length ? `\n\n${tabs.length} tab${tabs.length === 1 ? '' : 's'} using it will lose ${tabs.length === 1 ? 'its' : 'their'} session, and data tabs on it will close.` : '';
    if (!(await this.confirm.ask(`Drop the database ${database}?\n\nThis cannot be undone.${extra}`,
      { title: 'Drop database', confirmLabel: 'Drop database', danger: true }))) return;
    try {
      await this.api.dropDatabase(connId, database);
      this.toasts.success(`Dropped database ${database}`);
      for (const tab of tabs) {
        this.tx.forget(tab.id);
        this.runs.forget(tab.id);
        if (tab.kind === 'table') void this.tabs.close(tab.id);
      }
      await this.schema.refresh(connId);
    } catch (e) {
      this.toasts.error(errorText(e));
    }
  }

  /** New empty scratch filed under a table. */
  public newScratchFor(connId: string, t: DbTable, database = '') {
    void this.scratches.createIn({ connId, database, schema: t.schema, table: t.name });
  }

  public insertName(connId: string, schema: string, name: string, database = '') {
    const conn = this.conns.get(connId);
    if (!conn) return;
    this.editor.insert(qualified(conn.kind, schema, name, this.schema.get(this.schema.scopeFor(connId, database))?.defaultSchema));
    this.editor.focus();
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
        this.toasts.error('Clipboard is not available');
        return false;
      }
    }
  }
}
