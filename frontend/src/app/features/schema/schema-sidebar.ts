import { Component, ElementRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Commands } from '../../core/commands';
import { ConnectionStore } from '../../core/connection.store';
import { SchemaStore, connectionScope, type ConnectionSchema } from '../../core/schema.store';
import { TabStore } from '../../core/tab.store';
import { Toasts } from '../../core/toast';
import { Ui } from '../../core/ui';
import { TxStore } from '../../core/tx.store';
import { ClickOutside, clampMenu } from '../../shared/click-outside';
import { Confirm } from '../../shared/confirm';
import { canCreateSchema } from '../../core/sql';
import { Autofocus } from '../../shared/autofocus';
import { Icon } from '../../shared/icon';
import { ScratchList } from '../scratches/scratch-list';
import {
  KIND_LABELS,
  type ConnectionFolder,
  type ConnectionView,
  type DbColumn,
  type DbTable,
} from '../../core/models';

/** Where a node's metadata comes from: a connection and, for Postgres, one of its databases. */
interface NodePlace {
  connId: string;
  database: string;
  scope: string;
}

type TreeRow =
  | {
      kind: 'folder';
      key: string;
      depth: number;
      folder: ConnectionFolder;
      open: boolean;
      count: number;
      match: boolean;
    }
  | {
      kind: 'conn';
      key: string;
      depth: number;
      connection: ConnectionView;
      open: boolean;
      loading: boolean;
      count?: number;
    }
  | ({
      kind: 'db';
      key: string;
      depth: number;
      open: boolean;
      loading: boolean;
      isCurrent: boolean;
      count?: number;
    } & NodePlace)
  | ({
      kind: 'schema';
      key: string;
      depth: number;
      schema: string;
      open: boolean;
      loading: boolean;
      isDefault: boolean;
      count?: number;
    } & NodePlace)
  | ({
      kind: 'table';
      key: string;
      depth: number;
      table: DbTable;
      open: boolean;
      loading: boolean;
    } & NodePlace)
  | { kind: 'column'; key: string; depth: number; column: DbColumn }
  | { kind: 'note'; key: string; depth: number; text: string };

type MenuTarget =
  | { kind: 'folder'; folder: ConnectionFolder }
  | { kind: 'conn'; connection: ConnectionView }
  | ({ kind: 'db' } & NodePlace)
  | ({ kind: 'schema'; schema: string } & NodePlace)
  | ({ kind: 'table'; table: DbTable } & NodePlace);

type ContextMenu = MenuTarget & { x: number; y: number };

const MAX_TABLES_UNFILTERED = 2000;
const CONNECTION_DRAG_TYPE = 'application/x-dolmen-connection';
const FOLDER_DRAG_TYPE = 'application/x-dolmen-folder';

type DraggedItem =
  { kind: 'conn'; id: string; name: string } | { kind: 'folder'; id: string; name: string };

@Component({
  selector: 'dm-schema-sidebar',
  imports: [FormsModule, ClickOutside, Autofocus, Icon, ScratchList],
  templateUrl: './schema-sidebar.html',
  styleUrl: './schema-sidebar.scss',
})
export class SchemaSidebar {
  public readonly commandService = inject(Commands);
  public readonly connectionStore = inject(ConnectionStore);
  public readonly schemaStore = inject(SchemaStore);
  private tabStore = inject(TabStore);
  public readonly uiState = inject(Ui);
  private transactionStore = inject(TxStore);
  private confirmDialog = inject(Confirm);
  private toastService = inject(Toasts);
  private hostElement = inject<ElementRef<HTMLElement>>(ElementRef);

  public readonly filterText = signal('');
  public readonly expandedKeys = signal<ReadonlySet<string>>(new Set());
  public readonly selectedKey = signal('');
  public readonly highlightKey = signal('');
  public readonly contextMenu = signal<ContextMenu | null>(null);
  public readonly editingFolderId = signal('');
  public readonly dropTargetKey = signal('');
  /** The connection or folder being dragged, for drop validation and hints. */
  public readonly draggedItem = signal<DraggedItem | null>(null);

  public constructor() {
    // Expand freshly connected connections down to their default schema.
    this.connectionStore.onChange(async (connectionId, connected) => {
      if (!connected) return;
      await this.schemaStore.loadDatabases(connectionId);
      await this.schemaStore.loadSchemas(connectionId);
      this.expandKey(`c:${connectionId}`);
      const databaseList = this.schemaStore.databases()[connectionId];
      if (databaseList?.supported) this.expandKey(`d:${connectionId}:${databaseList.current}`);
      const cachedSchema = this.schemaStore.get(connectionId);
      if (cachedSchema?.defaultSchema) {
        this.expandKey(`s:${connectionId}:${cachedSchema.defaultSchema}`);
        void this.schemaStore.loadTables(connectionId, cachedSchema.defaultSchema);
      }
    });

    // Reveal requests from the palette.
    effect(() => {
      const reveal = this.uiState.reveal();
      if (!reveal) return;
      untracked(async () => {
        this.filterText.set('');
        const scope = this.schemaStore.scopeFor(reveal.connId, reveal.database);
        this.expandKey(`c:${reveal.connId}`);
        const databaseList = this.schemaStore.databases()[reveal.connId];
        if (databaseList?.supported) {
          this.expandKey(`d:${reveal.connId}:${reveal.database || databaseList.current}`);
        }
        this.expandKey(`s:${scope}:${reveal.schema}`);
        await this.schemaStore.loadTables(scope, reveal.schema);
        const key = `t:${scope}:${reveal.schema}:${reveal.table}`;
        this.highlightKey.set(key);
        setTimeout(() => {
          this.hostElement.nativeElement
            .querySelector(`[id="n-${CSS.escape(key)}"]`)
            ?.scrollIntoView({ block: 'center' });
        }, 30);
        setTimeout(() => this.highlightKey() === key && this.highlightKey.set(''), 2500);
      });
    });
  }

  public readonly rows = computed<TreeRow[]>(() => {
    const expandedKeys = this.expandedKeys();
    const schemasByScope = this.schemaStore.schemasByScope();
    const databaseLists = this.schemaStore.databases();
    const loadingKeys = this.schemaStore.loading();
    const searchText = this.filterText().trim().toLowerCase();
    const rows: TreeRow[] = [];
    const folders = this.connectionStore.folders();
    const rootFolderIds = new Set(folders.map((folder) => folder.id));
    const parentIdOf = (folder: ConnectionFolder) =>
      folder.parentId && rootFolderIds.has(folder.parentId) ? folder.parentId : '';
    const byFolderName = (first: { name: string }, second: { name: string }) =>
      first.name.localeCompare(second.name, undefined, { sensitivity: 'base' });

    const foldersByParent = new Map<string, ConnectionFolder[]>();
    for (const folder of folders) {
      const parentId = parentIdOf(folder);
      const siblings = foldersByParent.get(parentId) ?? [];
      siblings.push(folder);
      foldersByParent.set(parentId, siblings);
    }
    for (const siblings of foldersByParent.values()) siblings.sort(byFolderName);
    const connectionsByFolder = new Map<string, ConnectionView[]>();
    for (const connection of this.connectionStore.connections()) {
      const parentId =
        connection.folderId && rootFolderIds.has(connection.folderId) ? connection.folderId : '';
      const siblings = connectionsByFolder.get(parentId) ?? [];
      siblings.push(connection);
      connectionsByFolder.set(parentId, siblings);
    }
    for (const siblings of connectionsByFolder.values()) siblings.sort(byFolderName);

    /** Appends the schemas → tables → columns of one scope. Returns false when the filter hides it all. */
    const addSchemas = (
      place: NodePlace,
      cachedSchema: ConnectionSchema | undefined,
      depth: number,
    ): boolean => {
      if (!cachedSchema) return !searchText;
      let anyMatch = false;
      for (const schemaName of cachedSchema.schemas) {
        const schemaKey = `s:${place.scope}:${schemaName}`;
        const tables = cachedSchema.tables[schemaName];
        const matchingTables =
          searchText && tables
            ? tables.filter((table) => table.name.toLowerCase().includes(searchText))
            : tables;
        // The filter hides schemas without matches.
        if (searchText && (!matchingTables || !matchingTables.length)) continue;
        anyMatch = true;
        const open = expandedKeys.has(schemaKey) || !!searchText;
        rows.push({
          kind: 'schema',
          key: schemaKey,
          depth,
          ...place,
          schema: schemaName,
          open,
          loading: loadingKeys.has(`${place.scope}|tables|${schemaName}`),
          isDefault: schemaName === cachedSchema.defaultSchema,
          count: tables?.length,
        });
        if (!open || !matchingTables) continue;
        const shownTables = searchText
          ? matchingTables
          : matchingTables.slice(0, MAX_TABLES_UNFILTERED);
        for (const table of shownTables) {
          const tableKey = `t:${place.scope}:${schemaName}:${table.name}`;
          const tableOpen = expandedKeys.has(tableKey);
          rows.push({
            kind: 'table',
            key: tableKey,
            depth: depth + 1,
            ...place,
            table,
            open: tableOpen,
            loading: loadingKeys.has(`${place.scope}|cols|${schemaName}.${table.name}`),
          });
          if (!tableOpen) continue;
          for (const column of cachedSchema.columns[`${schemaName}.${table.name}`] ?? []) {
            rows.push({
              kind: 'column',
              key: `${tableKey}:${column.name}`,
              depth: depth + 2,
              column,
            });
          }
        }
        if (shownTables.length < matchingTables.length) {
          rows.push({
            kind: 'note',
            key: `${schemaKey}:more`,
            depth: depth + 1,
            text: `${matchingTables.length - shownTables.length} more; use the filter`,
          });
        }
        if (!matchingTables.length) {
          rows.push({
            kind: 'note',
            key: `${schemaKey}:none`,
            depth: depth + 1,
            text: 'No tables',
          });
        }
      }
      return anyMatch || !searchText;
    };

    const addConnection = (connection: ConnectionView, depth: number) => {
      const connectionKey = `c:${connection.id}`;
      const databaseList = databaseLists[connection.id];
      const connectionOpen =
        connection.connected && (expandedKeys.has(connectionKey) || !!searchText);
      rows.push({
        kind: 'conn',
        key: connectionKey,
        depth,
        connection,
        open: connectionOpen,
        loading:
          this.connectionStore.pending().has(connection.id) ||
          loadingKeys.has(`${connection.id}|schemas`) ||
          loadingKeys.has(`${connection.id}|databases`),
        count: databaseList?.supported ? databaseList.databases.length : undefined,
      });
      if (!connectionOpen || !databaseList) return;

      if (!databaseList.supported) {
        addSchemas(
          { connId: connection.id, database: '', scope: connection.id },
          schemasByScope[connection.id],
          depth + 1,
        );
        return;
      }
      for (const databaseName of databaseList.databases) {
        const isCurrent = databaseName === databaseList.current;
        const place: NodePlace = {
          connId: connection.id,
          database: isCurrent ? '' : databaseName,
          scope: isCurrent ? connection.id : connectionScope(connection.id, databaseName),
        };
        const databaseKey = `d:${connection.id}:${databaseName}`;
        const cachedSchema = schemasByScope[place.scope];
        const open = expandedKeys.has(databaseKey) || (!!searchText && !!cachedSchema);
        const rowStart = rows.length;
        rows.push({
          kind: 'db',
          key: databaseKey,
          depth: depth + 1,
          ...place,
          database: databaseName,
          open,
          loading: loadingKeys.has(`${place.scope}|schemas`),
          isCurrent,
          count: cachedSchema?.schemas.length,
        });
        // Filtered out entirely.
        if (open && !addSchemas(place, cachedSchema, depth + 2)) rows.length = rowStart;
      }
    };

    const countConnections = (folderId: string): number => {
      let count = (connectionsByFolder.get(folderId) ?? []).length;
      for (const child of foldersByParent.get(folderId) ?? []) count += countConnections(child.id);
      return count;
    };

    const addFolder = (folder: ConnectionFolder, depth: number) => {
      const key = `f:${folder.id}`;
      const open = expandedKeys.has(key) || !!searchText;
      rows.push({
        kind: 'folder',
        key,
        depth,
        folder,
        open,
        count: countConnections(folder.id),
        match: !!searchText && folder.name.toLowerCase().includes(searchText),
      });
      if (!open) return;
      for (const child of foldersByParent.get(folder.id) ?? []) addFolder(child, depth + 1);
      for (const connection of connectionsByFolder.get(folder.id) ?? [])
        addConnection(connection, depth + 1);
    };

    for (const folder of foldersByParent.get('') ?? []) addFolder(folder, 0);
    for (const connection of connectionsByFolder.get('') ?? []) addConnection(connection, 0);
    return rows;
  });

  public indent(depth: number) {
    return 6 + depth * 16;
  }

  public kindLabel(connection: ConnectionView) {
    return KIND_LABELS[connection.kind];
  }

  private expandKey(key: string) {
    if (this.expandedKeys().has(key)) return;
    this.expandedKeys.set(new Set([...this.expandedKeys(), key]));
  }

  private collapseKey(key: string) {
    const expandedKeys = new Set(this.expandedKeys());
    expandedKeys.delete(key);
    this.expandedKeys.set(expandedKeys);
  }

  public toggleFolder(folder: ConnectionFolder) {
    const key = `f:${folder.id}`;
    if (this.expandedKeys().has(key)) this.collapseKey(key);
    else this.expandKey(key);
  }

  public async newFolder() {
    const folder = await this.connectionStore.createFolder('New folder');
    if (!folder) return;
    this.editingFolderId.set(folder.id);
    this.selectedKey.set(`f:${folder.id}`);
    setTimeout(() => {
      const input = this.hostElement.nativeElement.querySelector<HTMLInputElement>(
        `[id="n-f:${CSS.escape(folder.id)}"] input.rename`,
      );
      input?.select();
    }, 20);
  }

  public async renameFolder(folder: ConnectionFolder, name: string) {
    if (this.editingFolderId() !== folder.id) return;
    this.editingFolderId.set('');
    if (name.trim() && name.trim() !== folder.name)
      await this.connectionStore.renameFolder(folder.id, name);
  }

  public async deleteFolder(folder: ConnectionFolder) {
    if (
      !(await this.confirmDialog.ask(
        `Delete the folder “${folder.name}”? Its connections and sub-folders move up one level.`,
        { title: 'Delete folder', confirmLabel: 'Delete', danger: true },
      ))
    )
      return;
    await this.connectionStore.deleteFolder(folder.id);
  }

  // ---- drag & drop: connections and folders move between folders ----

  public onConnectionDrag(event: DragEvent, connection: ConnectionView) {
    this.startDrag(event, { kind: 'conn', id: connection.id, name: connection.name });
  }

  public onFolderDrag(event: DragEvent, folder: ConnectionFolder) {
    this.startDrag(event, { kind: 'folder', id: folder.id, name: folder.name });
  }

  private startDrag(event: DragEvent, item: DraggedItem) {
    this.draggedItem.set(item);
    this.dropTargetKey.set('');
    event.dataTransfer?.setData(
      item.kind === 'conn' ? CONNECTION_DRAG_TYPE : FOLDER_DRAG_TYPE,
      item.id,
    );
    event.dataTransfer?.setData('text/plain', item.name);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  }

  public endDrag() {
    this.draggedItem.set(null);
    this.dropTargetKey.set('');
  }

  public onFolderOver(event: DragEvent, folder: ConnectionFolder) {
    const item = this.draggedItem();
    if (!item || !this.canDropInto(item, folder)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    this.dropTargetKey.set(`f:${folder.id}`);
  }

  public onFolderLeave(event: DragEvent, folder: ConnectionFolder) {
    const nextTarget = event.relatedTarget as Node | null;
    if (nextTarget && (event.currentTarget as Node).contains(nextTarget)) return;
    if (this.dropTargetKey() === `f:${folder.id}`) this.dropTargetKey.set('');
  }

  public onFolderDrop(event: DragEvent, folder: ConnectionFolder) {
    const item = this.draggedItem();
    if (!item || !this.canDropInto(item, folder)) return;
    event.preventDefault();
    event.stopPropagation();
    this.dropItem(item, folder.id);
  }

  /** The area outside folder rows is the root: drop there to move something out. */
  public onRootOver(event: DragEvent) {
    if (!this.draggedItem()) return;
    if ((event.target as HTMLElement).closest?.('.row.folder')) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    this.dropTargetKey.set('root');
  }

  public onRootLeave(event: DragEvent) {
    const nextTarget = event.relatedTarget as Node | null;
    if (nextTarget && (event.currentTarget as HTMLElement).contains(nextTarget)) return;
    if (this.dropTargetKey() === 'root') this.dropTargetKey.set('');
  }

  public onRootDrop(event: DragEvent) {
    const item = this.draggedItem();
    if (!item) return;
    if ((event.target as HTMLElement).closest?.('.row.folder')) return;
    event.preventDefault();
    this.dropItem(item, '');
  }

  /** A folder can never be dropped into itself or one of its descendants. */
  private canDropInto(item: DraggedItem, folder: ConnectionFolder): boolean {
    if (item.kind === 'conn') return true;
    if (item.id === folder.id) return false;
    const foldersById = new Map(
      this.connectionStore.folders().map((candidate) => [candidate.id, candidate]),
    );
    for (let parentId = folder.parentId; parentId; parentId = foldersById.get(parentId)?.parentId) {
      if (parentId === item.id) return false;
    }
    return true;
  }

  private dropItem(item: DraggedItem, folderId: string) {
    this.dropTargetKey.set('');
    this.draggedItem.set(null);
    if (folderId) this.expandKey(`f:${folderId}`);
    if (item.kind === 'conn') void this.connectionStore.moveToFolder(item.id, folderId);
    else void this.connectionStore.moveFolder(item.id, folderId);
  }

  public async toggleConnection(connection: ConnectionView) {
    const key = `c:${connection.id}`;
    if (!connection.connected) {
      await this.connectionStore.connect(connection.id); // onChange expands it
      return;
    }
    if (this.expandedKeys().has(key)) {
      this.collapseKey(key);
      return;
    }
    this.expandKey(key);
    void this.schemaStore.loadDatabases(connection.id);
    void this.schemaStore.loadSchemas(connection.id);
  }

  public toggle(row: TreeRow) {
    if (!('open' in row) || row.kind === 'conn') return;
    if (row.kind === 'folder') {
      this.toggleFolder(row.folder);
      return;
    }
    if (row.open) {
      if (!this.filterText()) this.collapseKey(row.key);
      return;
    }
    this.expandKey(row.key);
    if (row.kind === 'db') void this.schemaStore.loadSchemas(row.scope);
    if (row.kind === 'schema') void this.schemaStore.loadTables(row.scope, row.schema);
    if (row.kind === 'table')
      void this.schemaStore.loadColumns(row.scope, row.table.schema, row.table.name);
  }

  public openContextMenu(event: MouseEvent, target: MenuTarget) {
    event.preventDefault();
    this.contextMenu.set({ ...target, ...clampMenu(event.clientX, event.clientY, 240, 420) });
  }

  public runMenuAction(action: string) {
    const menu = this.contextMenu();
    this.contextMenu.set(null);
    if (!menu) return;
    switch (menu.kind) {
      case 'folder': {
        switch (action) {
          case 'rename':
            return this.editingFolderId.set(menu.folder.id);
          case 'delete':
            return void this.deleteFolder(menu.folder);
        }
        return;
      }
      case 'table': {
        const { connId, database, table } = menu;
        switch (action) {
          case 'data':
            return this.commandService.openTableData(connId, database, table);
          case 'select':
            return void this.commandService.selectTop(connId, table, database);
          case 'scratch':
            return this.commandService.newScratchFor(connId, table, database);
          case 'insert':
            return this.commandService.insertName(connId, table.schema, table.name, database);
          case 'copy':
            return void this.commandService.copy(table.name);
          case 'ddl':
            return void this.commandService.showDDL(connId, table, database);
          case 'copyddl':
            return void this.commandService.copyDDL(connId, table, database);
          case 'newtable':
            return void this.commandService.newTable(connId, table.schema, database);
          case 'drop':
            return void this.commandService.dropTable(connId, table, database);
        }
        return;
      }
      case 'schema':
        switch (action) {
          case 'diagram':
            return this.commandService.openDiagram(menu.connId, menu.schema, menu.database);
          case 'refresh':
            return void this.schemaStore.refreshScope(menu.scope);
          case 'newschema':
            return void this.commandService.createSchema(menu.connId, menu.database, menu.scope);
        }
        return;
      case 'db': {
        const databaseName =
          menu.database || this.schemaStore.databases()[menu.connId]?.current || '';
        switch (action) {
          case 'newtab':
            return this.commandService.newTab(menu.connId, menu.database);
          case 'use':
            return this.useInCurrentTab(menu.connId, menu.database);
          case 'copy':
            return void this.commandService.copy(databaseName);
          case 'refresh':
            return void this.schemaStore.refreshScope(menu.scope);
          case 'newdb':
            return void this.commandService.createDatabase(menu.connId);
          case 'newschema':
            return void this.commandService.createSchema(menu.connId, menu.database, menu.scope);
          case 'dropdb':
            return void this.commandService.dropDatabase(menu.connId, databaseName);
        }
        return;
      }
      case 'conn': {
        const connection = menu.connection;
        switch (action) {
          case 'newtab':
            return this.commandService.newTab(connection.id, '');
          case 'newdb':
            return void this.commandService.createDatabase(connection.id);
          case 'newschema':
            return void this.commandService.createSchema(connection.id, '', connection.id);
          case 'refresh':
            return void this.schemaStore.refresh(connection.id);
          case 'disconnect':
            return void this.connectionStore.disconnect(connection.id);
          case 'connect':
            return void this.connectionStore.connect(connection.id);
          case 'readonly':
            return void this.commandService.toggleReadOnly(connection);
          case 'edit':
            return this.commandService.editConnection(connection);
        }
      }
    }
  }

  /** Engines with a database level (Postgres) can create and list databases. */
  public hasDatabaseLevel(connection: ConnectionView): boolean {
    return this.schemaStore.databases()[connection.id]?.supported ?? connection.kind === 'postgres';
  }

  /** Postgres, MySQL and Oracle can create schemas; SQLite schemas are attached files. */
  public canCreateSchema(connectionId: string): boolean {
    return canCreateSchema(this.connectionStore.get(connectionId)?.kind);
  }

  /** The database the connection itself is opened on (it cannot be dropped from here). */
  public isPrimaryDatabase(connectionId: string, database: string): boolean {
    const currentDatabase = this.schemaStore.databases()[connectionId]?.current;
    return !database || database === currentDatabase;
  }

  public async useInCurrentTab(connectionId: string, database: string) {
    const tab = this.tabStore.active();
    if (!tab) return;
    if (tab.locked) {
      this.toastService.error(`${tab.name} is locked to its folder. Unlock it first.`);
      return;
    }
    if (!(await this.transactionStore.confirmLeave(tab.id))) return;
    this.tabStore.setConnection(tab.id, connectionId, database);
  }

  /** Arrow keys move between rows, Left/Right collapse/expand, Enter toggles. */
  public onTreeKeyDown(event: KeyboardEvent) {
    const rows = this.rows().filter((row) => row.kind !== 'note' && row.kind !== 'column');
    const selectedIndex = rows.findIndex((row) => row.key === this.selectedKey());
    const focusRow = (key: string) =>
      this.hostElement.nativeElement
        .querySelector<HTMLElement>(`[id="n-${CSS.escape(key)}"]`)
        ?.focus();
    const row = rows[selectedIndex];
    switch (event.key) {
      case 'ArrowDown':
        if (selectedIndex < rows.length - 1) focusRow(rows[selectedIndex + 1].key);
        break;
      case 'ArrowUp':
        if (selectedIndex > 0) focusRow(rows[selectedIndex - 1].key);
        break;
      case 'ArrowRight':
      case 'ArrowLeft':
      case 'Enter':
        if (!row || !('open' in row)) return;
        if (event.key === 'Enter' || (event.key === 'ArrowRight') !== row.open) {
          if (row.kind === 'conn') void this.toggleConnection(row.connection);
          else this.toggle(row);
        }
        break;
      default:
        return;
    }
    event.preventDefault();
  }
}
