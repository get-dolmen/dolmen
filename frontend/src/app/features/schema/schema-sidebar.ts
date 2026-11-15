import { Component, ElementRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Commands } from '../../core/commands';
import { ConnectionStore } from '../../core/connection.store';
import { SchemaStore, scopeOf, type ConnSchema } from '../../core/schema.store';
import { TabStore } from '../../core/tab.store';
import { Toasts } from '../../core/toast';
import { Ui } from '../../core/ui';
import { TxStore } from '../../core/tx.store';
import { ClickOutside, clampMenu } from '../../shared/click-outside';
import { Confirm } from '../../shared/confirm';
import { Autofocus } from '../../shared/autofocus';
import { Icon } from '../../shared/icon';
import { ScratchList } from '../scratches/scratch-list';
import { KIND_LABELS, type ConnectionFolder, type ConnectionView, type DbColumn, type DbTable } from '../../core/models';

/** Where a node's metadata comes from: a connection and, for Postgres, one of its databases. */
interface Place { connId: string; database: string; scope: string; }

type Row =
  | { kind: 'folder'; key: string; depth: number; folder: ConnectionFolder; open: boolean; count: number; match: boolean }
  | { kind: 'conn'; key: string; depth: number; conn: ConnectionView; open: boolean; loading: boolean; count?: number }
  | ({ kind: 'db'; key: string; depth: number; open: boolean; loading: boolean; isCurrent: boolean; count?: number } & Place)
  | ({ kind: 'schema'; key: string; depth: number; schema: string; open: boolean; loading: boolean; isDefault: boolean; count?: number } & Place)
  | ({ kind: 'table'; key: string; depth: number; table: DbTable; open: boolean; loading: boolean } & Place)
  | { kind: 'column'; key: string; depth: number; column: DbColumn }
  | { kind: 'note'; key: string; depth: number; text: string };

type MenuTarget =
  | { kind: 'folder'; folder: ConnectionFolder }
  | { kind: 'conn'; conn: ConnectionView }
  | ({ kind: 'db' } & Place)
  | ({ kind: 'table'; table: DbTable } & Place);

type Menu = MenuTarget & { x: number; y: number };

const MAX_TABLES_UNFILTERED = 2000;
const CONN_DRAG_TYPE = 'application/x-dolmen-connection';
const FOLDER_DRAG_TYPE = 'application/x-dolmen-folder';

type DragItem = { kind: 'conn'; id: string; name: string } | { kind: 'folder'; id: string; name: string };

@Component({
  selector: 'dm-schema-sidebar',
  imports: [FormsModule, ClickOutside, Autofocus, Icon, ScratchList],
  templateUrl: './schema-sidebar.html',
  styleUrl: './schema-sidebar.scss',
})
export class SchemaSidebar {
  readonly cmds = inject(Commands);
  readonly conns = inject(ConnectionStore);
  readonly schema = inject(SchemaStore);
  private tabs = inject(TabStore);
  readonly ui = inject(Ui);
  private tx = inject(TxStore);
  private confirm = inject(Confirm);
  private toasts = inject(Toasts);
  private el = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly filter = signal('');
  readonly expanded = signal<ReadonlySet<string>>(new Set());
  readonly selected = signal('');
  readonly highlight = signal('');
  readonly menu = signal<Menu | null>(null);
  readonly editingFolder = signal('');
  readonly dropKey = signal('');
  /** The connection or folder being dragged, for drop validation and hints. */
  readonly drag = signal<DragItem | null>(null);

  constructor() {
    // Expand freshly connected connections down to their default schema.
    this.conns.onChange(async (id, connected) => {
      if (!connected) return;
      await this.schema.loadDatabases(id);
      await this.schema.loadSchemas(id);
      this.expand(`c:${id}`);
      const dbs = this.schema.databases()[id];
      if (dbs?.supported) this.expand(`d:${id}:${dbs.current}`);
      const s = this.schema.get(id);
      if (s?.defaultSchema) {
        this.expand(`s:${id}:${s.defaultSchema}`);
        void this.schema.loadTables(id, s.defaultSchema);
      }
    });

    // Reveal requests from the palette.
    effect(() => {
      const r = this.ui.reveal();
      if (!r) return;
      untracked(async () => {
        this.filter.set('');
        const scope = this.schema.scope(r.connId, r.database);
        this.expand(`c:${r.connId}`);
        const dbs = this.schema.databases()[r.connId];
        if (dbs?.supported) this.expand(`d:${r.connId}:${r.database || dbs.current}`);
        this.expand(`s:${scope}:${r.schema}`);
        await this.schema.loadTables(scope, r.schema);
        const key = `t:${scope}:${r.schema}:${r.table}`;
        this.highlight.set(key);
        setTimeout(() => this.el.nativeElement.querySelector(`[id="n-${CSS.escape(key)}"]`)?.scrollIntoView({ block: 'center' }), 30);
        setTimeout(() => this.highlight() === key && this.highlight.set(''), 2500);
      });
    });
  }

  readonly rows = computed<Row[]>(() => {
    const exp = this.expanded();
    const data = this.schema.data();
    const dbs = this.schema.databases();
    const loading = this.schema.loading();
    const f = this.filter().trim().toLowerCase();
    const out: Row[] = [];
    const folders = this.conns.folders();
    const rootFolders = new Set(folders.map((x) => x.id));
    const parentOf = (folder: ConnectionFolder) => (folder.parentId && rootFolders.has(folder.parentId) ? folder.parentId : '');
    const byFolder = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

    const foldersByParent = new Map<string, ConnectionFolder[]>();
    for (const folder of folders) {
      const parent = parentOf(folder);
      const list = foldersByParent.get(parent) ?? [];
      list.push(folder);
      foldersByParent.set(parent, list);
    }
    for (const list of foldersByParent.values()) list.sort(byFolder);
    const connsByFolder = new Map<string, ConnectionView[]>();
    for (const conn of this.conns.connections()) {
      const parent = conn.folderId && rootFolders.has(conn.folderId) ? conn.folderId : '';
      const list = connsByFolder.get(parent) ?? [];
      list.push(conn);
      connsByFolder.set(parent, list);
    }
    for (const list of connsByFolder.values()) list.sort(byFolder);

    /** Appends the schemas → tables → columns of one scope. Returns false when the filter hides it all. */
    const addSchemas = (place: Place, cs: ConnSchema | undefined, depth: number): boolean => {
      if (!cs) return !f;
      let any = false;
      for (const s of cs.schemas) {
        const sk = `s:${place.scope}:${s}`;
        const tables = cs.tables[s];
        const matches = f && tables ? tables.filter((t) => t.name.toLowerCase().includes(f)) : tables;
        if (f && (!matches || !matches.length)) continue; // the filter hides schemas without matches
        any = true;
        const open = exp.has(sk) || !!f;
        out.push({ kind: 'schema', key: sk, depth, ...place, schema: s, open, loading: loading.has(`${place.scope}|tables|${s}`), isDefault: s === cs.defaultSchema, count: tables?.length });
        if (!open || !matches) continue;
        const shown = f ? matches : matches.slice(0, MAX_TABLES_UNFILTERED);
        for (const t of shown) {
          const tk = `t:${place.scope}:${s}:${t.name}`;
          const topen = exp.has(tk);
          out.push({ kind: 'table', key: tk, depth: depth + 1, ...place, table: t, open: topen, loading: loading.has(`${place.scope}|cols|${s}.${t.name}`) });
          if (!topen) continue;
          for (const c of cs.columns[`${s}.${t.name}`] ?? []) {
            out.push({ kind: 'column', key: `${tk}:${c.name}`, depth: depth + 2, column: c });
          }
        }
        if (shown.length < matches.length) {
          out.push({ kind: 'note', key: `${sk}:more`, depth: depth + 1, text: `${matches.length - shown.length} more; use the filter` });
        }
        if (!matches.length) out.push({ kind: 'note', key: `${sk}:none`, depth: depth + 1, text: 'No tables' });
      }
      return any || !f;
    };

    const addConn = (conn: ConnectionView, depth: number) => {
      const ck = `c:${conn.id}`;
      const d = dbs[conn.id];
      const connOpen = conn.connected && (exp.has(ck) || !!f);
      out.push({
        kind: 'conn', key: ck, depth, conn, open: connOpen,
        loading: this.conns.pending().has(conn.id) || loading.has(`${conn.id}|schemas`) || loading.has(`${conn.id}|databases`),
        count: d?.supported ? d.databases.length : undefined,
      });
      if (!connOpen || !d) return;

      if (!d.supported) {
        addSchemas({ connId: conn.id, database: '', scope: conn.id }, data[conn.id], depth + 1);
        return;
      }
      for (const db of d.databases) {
        const isCurrent = db === d.current;
        const place: Place = { connId: conn.id, database: isCurrent ? '' : db, scope: isCurrent ? conn.id : scopeOf(conn.id, db) };
        const dk = `d:${conn.id}:${db}`;
        const cs = data[place.scope];
        const open = exp.has(dk) || (!!f && !!cs);
        const at = out.length;
        out.push({ kind: 'db', key: dk, depth: depth + 1, ...place, database: db, open, loading: loading.has(`${place.scope}|schemas`), isCurrent, count: cs?.schemas.length });
        if (open && !addSchemas(place, cs, depth + 2)) out.length = at; // filtered out entirely
      }
    };

    const countConns = (folderId: string): number => {
      let n = (connsByFolder.get(folderId) ?? []).length;
      for (const child of foldersByParent.get(folderId) ?? []) n += countConns(child.id);
      return n;
    };

    const addFolder = (folder: ConnectionFolder, depth: number) => {
      const key = `f:${folder.id}`;
      const open = exp.has(key) || !!f;
      out.push({ kind: 'folder', key, depth, folder, open, count: countConns(folder.id), match: !!f && folder.name.toLowerCase().includes(f) });
      if (!open) return;
      for (const child of foldersByParent.get(folder.id) ?? []) addFolder(child, depth + 1);
      for (const conn of connsByFolder.get(folder.id) ?? []) addConn(conn, depth + 1);
    };

    for (const folder of foldersByParent.get('') ?? []) addFolder(folder, 0);
    for (const conn of connsByFolder.get('') ?? []) addConn(conn, 0);
    return out;
  });

  pad(depth: number) { return 6 + depth * 16; }

  kindLabel(c: ConnectionView) { return KIND_LABELS[c.kind]; }

  private expand(key: string) {
    if (this.expanded().has(key)) return;
    this.expanded.set(new Set([...this.expanded(), key]));
  }

  private collapse(key: string) {
    const s = new Set(this.expanded());
    s.delete(key);
    this.expanded.set(s);
  }

  toggleFolder(folder: ConnectionFolder) {
    const key = `f:${folder.id}`;
    if (this.expanded().has(key)) this.collapse(key);
    else this.expand(key);
  }

  async newFolder() {
    const f = await this.conns.createFolder('New folder');
    if (!f) return;
    this.editingFolder.set(f.id);
    this.selected.set(`f:${f.id}`);
    setTimeout(() => {
      const input = this.el.nativeElement.querySelector<HTMLInputElement>(`[id="n-f:${CSS.escape(f.id)}"] input.rename`);
      input?.select();
    }, 20);
  }

  async renameFolder(folder: ConnectionFolder, name: string) {
    if (this.editingFolder() !== folder.id) return;
    this.editingFolder.set('');
    if (name.trim() && name.trim() !== folder.name) await this.conns.renameFolder(folder.id, name);
  }

  async deleteFolder(folder: ConnectionFolder) {
    if (!(await this.confirm.ask(
      `Delete the folder “${folder.name}”? Its connections and sub-folders move up one level.`,
      { title: 'Delete folder', confirmLabel: 'Delete', danger: true },
    ))) return;
    await this.conns.deleteFolder(folder.id);
  }

  // ---- drag & drop: connections and folders move between folders ----

  onConnDrag(e: DragEvent, conn: ConnectionView) {
    this.startDrag(e, { kind: 'conn', id: conn.id, name: conn.name });
  }

  onFolderDrag(e: DragEvent, f: ConnectionFolder) {
    this.startDrag(e, { kind: 'folder', id: f.id, name: f.name });
  }

  private startDrag(e: DragEvent, item: DragItem) {
    this.drag.set(item);
    this.dropKey.set('');
    e.dataTransfer?.setData(item.kind === 'conn' ? CONN_DRAG_TYPE : FOLDER_DRAG_TYPE, item.id);
    e.dataTransfer?.setData('text/plain', item.name);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  }

  endDrag() {
    this.drag.set(null);
    this.dropKey.set('');
  }

  onFolderOver(e: DragEvent, folder: ConnectionFolder) {
    const item = this.drag();
    if (!item || !this.canDropIn(item, folder)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    this.dropKey.set(`f:${folder.id}`);
  }

  onFolderLeave(e: DragEvent, folder: ConnectionFolder) {
    const next = e.relatedTarget as Node | null;
    if (next && (e.currentTarget as Node).contains(next)) return;
    if (this.dropKey() === `f:${folder.id}`) this.dropKey.set('');
  }

  onFolderDrop(e: DragEvent, folder: ConnectionFolder) {
    const item = this.drag();
    if (!item || !this.canDropIn(item, folder)) return;
    e.preventDefault();
    e.stopPropagation();
    this.drop(item, folder.id);
  }

  /** The area outside folder rows is the root: drop there to move something out. */
  onRootOver(e: DragEvent) {
    if (!this.drag()) return;
    if ((e.target as HTMLElement).closest?.('.row.folder')) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    this.dropKey.set('root');
  }

  onRootLeave(e: DragEvent) {
    const next = e.relatedTarget as Node | null;
    if (next && (e.currentTarget as HTMLElement).contains(next)) return;
    if (this.dropKey() === 'root') this.dropKey.set('');
  }

  onRootDrop(e: DragEvent) {
    const item = this.drag();
    if (!item) return;
    if ((e.target as HTMLElement).closest?.('.row.folder')) return;
    e.preventDefault();
    this.drop(item, '');
  }

  /** A folder can never be dropped into itself or one of its descendants. */
  private canDropIn(item: DragItem, folder: ConnectionFolder): boolean {
    if (item.kind === 'conn') return true;
    if (item.id === folder.id) return false;
    const byId = new Map(this.conns.folders().map((f) => [f.id, f]));
    for (let parent = folder.parentId; parent; parent = byId.get(parent)?.parentId) {
      if (parent === item.id) return false;
    }
    return true;
  }

  private drop(item: DragItem, folderId: string) {
    this.dropKey.set('');
    this.drag.set(null);
    if (folderId) this.expand(`f:${folderId}`);
    if (item.kind === 'conn') void this.conns.moveToFolder(item.id, folderId);
    else void this.conns.moveFolder(item.id, folderId);
  }

  async toggleConn(c: ConnectionView) {
    const key = `c:${c.id}`;
    if (!c.connected) {
      await this.conns.connect(c.id); // onChange expands it
      return;
    }
    if (this.expanded().has(key)) this.collapse(key);
    else {
      this.expand(key);
      void this.schema.loadDatabases(c.id);
      void this.schema.loadSchemas(c.id);
    }
  }

  toggle(r: Row) {
    if (!('open' in r) || r.kind === 'conn') return;
    if (r.kind === 'folder') {
      this.toggleFolder(r.folder);
      return;
    }
    if (r.open) {
      if (!this.filter()) this.collapse(r.key);
      return;
    }
    this.expand(r.key);
    if (r.kind === 'db') void this.schema.loadSchemas(r.scope);
    if (r.kind === 'schema') void this.schema.loadTables(r.scope, r.schema);
    if (r.kind === 'table') void this.schema.loadColumns(r.scope, r.table.schema, r.table.name);
  }

  openMenu(e: MouseEvent, m: MenuTarget) {
    e.preventDefault();
    this.menu.set({ ...m, ...clampMenu(e.clientX, e.clientY, 240, 420) });
  }

  menuAction(action: string) {
    const m = this.menu();
    this.menu.set(null);
    if (!m) return;
    switch (m.kind) {
      case 'folder': {
        switch (action) {
          case 'rename': return this.editingFolder.set(m.folder.id);
          case 'delete': return void this.deleteFolder(m.folder);
        }
        return;
      }
      case 'table': {
        const { connId, database, table: t } = m;
        switch (action) {
          case 'data': return this.cmds.openTableData(connId, database, t);
          case 'select': return void this.cmds.selectTop(connId, t, database);
          case 'scratch': return this.cmds.newScratchFor(connId, t, database);
          case 'insert': return this.cmds.insertName(connId, t.schema, t.name, database);
          case 'copy': return void this.cmds.copy(t.name);
          case 'ddl': return void this.cmds.showDDL(connId, t, database);
          case 'copyddl': return void this.cmds.copyDDL(connId, t, database);
          case 'newtable': return void this.cmds.newTable(connId, t.schema, database);
          case 'drop': return void this.cmds.dropTable(connId, t, database);
        }
        return;
      }
      case 'db': {
        const db = m.database || this.schema.databases()[m.connId]?.current || '';
        switch (action) {
          case 'newtab': return this.cmds.newTab(m.connId, m.database);
          case 'use': return this.useInTab(m.connId, m.database);
          case 'copy': return void this.cmds.copy(db);
          case 'refresh': return void this.schema.refreshScope(m.scope);
          case 'newdb': return void this.cmds.createDatabase(m.connId);
          case 'dropdb': return void this.cmds.dropDatabase(m.connId, db);
        }
        return;
      }
      case 'conn': {
        const c = m.conn;
        switch (action) {
          case 'newtab': return this.cmds.newTab(c.id, '');
          case 'use': return this.useInTab(c.id, '');
          case 'refresh': return void this.schema.refresh(c.id);
          case 'disconnect': return void this.conns.disconnect(c.id);
          case 'connect': return void this.conns.connect(c.id);
          case 'readonly': return void this.cmds.toggleReadOnly(c);
          case 'edit': return this.cmds.editConnection(c);
        }
      }
    }
  }

  /** The database the connection itself is opened on (it cannot be dropped from here). */
  isMainDb(connId: string, database: string): boolean {
    const cur = this.schema.databases()[connId]?.current;
    return !database || database === cur;
  }

  async useInTab(connId: string, database: string) {
    const t = this.tabs.active();
    if (!t) return;
    if (t.locked) {
      this.toasts.error(`${t.name} is locked to its connection and database. Unlock it first.`);
      return;
    }
    if (!(await this.tx.confirmLeave(t.id))) return;
    this.tabs.setConnection(t.id, connId, database);
  }

  /** Arrow keys move between rows, Left/Right collapse/expand, Enter toggles. */
  onTreeKey(e: KeyboardEvent) {
    const rows = this.rows().filter((r) => r.kind !== 'note' && r.kind !== 'column');
    const i = rows.findIndex((r) => r.key === this.selected());
    const focus = (k: string) => this.el.nativeElement.querySelector<HTMLElement>(`[id="n-${CSS.escape(k)}"]`)?.focus();
    const r = rows[i];
    switch (e.key) {
      case 'ArrowDown': if (i < rows.length - 1) focus(rows[i + 1].key); break;
      case 'ArrowUp': if (i > 0) focus(rows[i - 1].key); break;
      case 'ArrowRight': case 'ArrowLeft': case 'Enter':
        if (!r || !('open' in r)) return;
        if (e.key === 'Enter' || (e.key === 'ArrowRight') !== r.open) {
          if (r.kind === 'conn') void this.toggleConn(r.conn);
          else this.toggle(r);
        }
        break;
      default: return;
    }
    e.preventDefault();
  }
}
