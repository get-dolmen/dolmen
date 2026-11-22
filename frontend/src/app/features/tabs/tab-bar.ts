import { Component, computed, inject, signal } from '@angular/core';
import { CdkDrag, CdkDragDrop, CdkDropList } from '@angular/cdk/drag-drop';
import { Commands } from '../../core/commands';
import { ConnectionStore } from '../../core/connection.store';
import { RunStore } from '../../core/run.store';
import { TxStore } from '../../core/tx.store';
import { TabStore, type EditorTab } from '../../core/tab.store';
import { MOD, Ui } from '../../core/ui';
import { Autofocus } from '../../shared/autofocus';
import { ClickOutside, clampMenu } from '../../shared/click-outside';
import { ScratchStore } from '../../core/scratch.store';
import { SchemaStore } from '../../core/schema.store';
import { Icon } from '../../shared/icon';
import { Toasts } from '../../core/toast';

@Component({
  selector: 'dm-tab-bar',
  imports: [CdkDropList, CdkDrag, Autofocus, ClickOutside, Icon],
  templateUrl: './tab-bar.html',
  styleUrl: './tab-bar.scss',
})
export class TabBar {
  public readonly tabStore = inject(TabStore);
  public readonly commandService = inject(Commands);
  private connectionStore = inject(ConnectionStore);
  private runStore = inject(RunStore);
  private scratchStore = inject(ScratchStore);
  private schemaStore = inject(SchemaStore);
  private toastService = inject(Toasts);
  public readonly transactionStore = inject(TxStore);
  public readonly uiState = inject(Ui);
  public readonly editingTabId = signal('');
  public readonly modifierKey = MOD;
  public readonly transactionMenu = signal<{ x: number; y: number } | null>(null);
  public readonly databaseMenu = signal<{ x: number; y: number } | null>(null);
  public readonly schemaMenu = signal<{ x: number; y: number } | null>(null);
  public readonly schemaFilter = signal('');
  public readonly activeTab = computed(() => this.tabStore.active());
  public readonly transactionState = computed(() =>
    this.transactionStore.get(this.tabStore.activeId()),
  );
  public readonly startedAtLabel = computed(() =>
    new Date(this.transactionState().startedAt).toLocaleTimeString(),
  );
  public readonly readOnly = computed(
    () => !!this.connectionStore.get(this.tabStore.active()?.connId)?.readOnly,
  );
  public readonly databaseInfo = computed(() => {
    const tab = this.activeTab();
    return tab?.kind === 'sql' ? this.schemaStore.databases()[tab.connId] : undefined;
  });
  public readonly showDatabasePicker = computed(
    () => !!this.databaseInfo()?.supported && (this.databaseInfo()?.databases.length ?? 0) > 1,
  );
  public readonly databaseLabel = computed(() => {
    const tab = this.activeTab();
    if (!tab) return '';
    return tab.database || this.databaseInfo()?.current || 'default';
  });

  /** The explorer cache of the active SQL tab's database. */
  private readonly schemaScope = computed(() => {
    const tab = this.activeTab();
    return tab?.kind === 'sql' ? this.schemaStore.scopeFor(tab.connId, tab.database) : '';
  });
  public readonly schemaInfo = computed(() => this.schemaStore.get(this.schemaScope()));
  /** SQLite has no current schema to switch: its schemas are attached files. */
  public readonly showSchemaPicker = computed(() => {
    const tab = this.activeTab();
    const connection = this.connectionStore.get(tab?.connId);
    return tab?.kind === 'sql' && !!connection?.connected && connection.kind !== 'sqlite';
  });
  public readonly schemaLabel = computed(
    () => this.activeTab()?.schema || this.schemaInfo()?.defaultSchema || 'default schema',
  );
  public readonly schemaOptions = computed(() => {
    const filter = this.schemaFilter().trim().toLowerCase();
    const schemas = this.schemaInfo()?.schemas ?? [];
    return filter ? schemas.filter((schema) => schema.toLowerCase().includes(filter)) : schemas;
  });

  public openSchemaMenu(event: MouseEvent) {
    const tab = this.activeTab();
    if (!tab) return;
    void this.schemaStore.loadSchemas(this.schemaScope());
    this.schemaFilter.set('');
    const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
    this.schemaMenu.set(clampMenu(bounds.right - 240, bounds.bottom + 4, 240, 320));
  }

  public isCurrentSchema(schema: string) {
    return (this.activeTab()?.schema || this.schemaInfo()?.defaultSchema || '') === schema;
  }

  /** Runs the tab in another schema; picking the default schema clears the choice. */
  public chooseSchema(schema: string) {
    this.schemaMenu.set(null);
    const tab = this.activeTab();
    if (!tab) return;
    const nextSchema = schema === this.schemaInfo()?.defaultSchema ? '' : schema;
    if (tab.schema === nextSchema) return;
    if (this.transactionStore.get(tab.id).open) {
      this.toastService.error('Commit or roll back the open transaction before switching schema.');
      return;
    }
    this.tabStore.setSchema(tab.id, nextSchema);
  }

  public openTransactionMenu(event: MouseEvent) {
    const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
    this.transactionMenu.set(clampMenu(bounds.right - 300, bounds.bottom + 4, 300, 160));
  }

  public setMode(mode: 'auto' | 'manual') {
    const tab = this.tabStore.active();
    if (tab && this.transactionStore.setMode(tab.id, mode)) this.transactionMenu.set(null);
  }

  public openDatabaseMenu(event: MouseEvent) {
    const tab = this.activeTab();
    if (!tab || tab.locked) return;
    if (!this.databaseInfo()) void this.schemaStore.loadDatabases(tab.connId);
    const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
    this.databaseMenu.set(clampMenu(bounds.right - 240, bounds.bottom + 4, 240, 260));
  }

  public isCurrentDatabase(database: string) {
    const tab = this.activeTab();
    return !!tab && (tab.database || this.databaseInfo()?.current || '') === database;
  }

  public async chooseDatabase(database: string) {
    this.databaseMenu.set(null);
    const tab = this.activeTab();
    const databaseInfo = this.databaseInfo();
    if (!tab || !databaseInfo || tab.locked) return;
    const nextDatabase = database === databaseInfo.current ? '' : database;
    if ((tab.database || '') === nextDatabase) return;
    if (!(await this.transactionStore.confirmLeave(tab.id))) return;
    this.tabStore.setConnection(tab.id, tab.connId, nextDatabase);
  }

  public connectionColor(tab: EditorTab) {
    return this.connectionStore.get(tab.connId)?.color ?? null;
  }

  /** "connection" or "connection/database" for data tabs. */
  public locationLabel(tab: EditorTab) {
    const connectionName = this.connectionStore.get(tab.connId)?.name ?? '?';
    return tab.database ? `${connectionName}/${tab.database}` : connectionName;
  }

  public isRunning(tab: EditorTab) {
    return !!this.runStore.runs()[tab.id]?.running;
  }

  public tooltip(tab: EditorTab) {
    const connection = this.connectionStore.get(tab.connId);
    const pinned = tab.pinned ? ' · pinned' : '';
    return `${tab.name}${connection ? ' · ' + connection.name : ''}${pinned}\nDouble-click to rename`;
  }

  public renameTab(tab: EditorTab, name: string) {
    if (this.editingTabId() !== tab.id) return;
    this.editingTabId.set('');
    if (!name.trim() || name.trim() === tab.name) return;
    // SQL tabs are scratch files: rename the file; data tabs only change their label.
    if (tab.kind === 'sql') void this.scratchStore.rename(tab.id, name);
    else this.tabStore.rename(tab.id, name);
  }

  public readonly tabMenu = signal<{ x: number; y: number; tab: EditorTab } | null>(null);

  public openTabMenu(event: MouseEvent, tab: EditorTab) {
    event.preventDefault();
    this.tabMenu.set({ ...clampMenu(event.clientX, event.clientY, 210, 280), tab });
  }

  public async runMenuAction(action: string) {
    const menu = this.tabMenu();
    this.tabMenu.set(null);
    if (!menu) return;
    const tabId = menu.tab.id;
    switch (action) {
      case 'pin':
        return this.tabStore.setPinned(tabId, !menu.tab.pinned);
      case 'rename':
        return this.editingTabId.set(tabId);
      case 'format':
        this.tabStore.activate(tabId);
        return this.commandService.formatSql(tabId);
      case 'save':
        return void this.scratchStore.save(tabId);
      case 'export':
        return void this.scratchStore.exportFile(tabId);
      case 'duplicate':
        return void this.scratchStore.duplicate(tabId);
      case 'close':
        return void this.commandService.closeTab(tabId);
      case 'others':
        for (const tab of this.tabStore.tabs())
          if (tab.id !== tabId && !tab.pinned) await this.commandService.closeTab(tab.id);
        return;
      case 'delete':
        return void this.scratchStore.remove(tabId);
    }
  }

  public dropTab(event: CdkDragDrop<unknown>) {
    if (event.previousIndex !== event.currentIndex)
      this.tabStore.move(event.previousIndex, event.currentIndex);
  }
}
