import { Component, ElementRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Commands } from '../../core/commands';
import { ConnectionStore } from '../../core/connection.store';
import { SchemaStore, scopeOf, type ConnSchema } from '../../core/schema.store';
import { TabStore } from '../../core/tab.store';
import { Ui } from '../../core/ui';
import { TxStore } from '../../core/tx.store';
import { ClickOutside, clampMenu } from '../../shared/click-outside';
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

@Component({
  selector: 'dm-schema-sidebar',
  imports: [FormsModule, ClickOutside, Autofocus, Icon, ScratchList],
  template: `
    <div class="head">
      <span class="title">Explorer</span>
      <span class="spacer"></span>
      <button class="btn ghost icon sm" title="New folder" aria-label="New folder" (click)="newFolder('')"><dm-icon name="folder" [size]="14" /></button>
      <button class="btn ghost icon sm" title="New connection" aria-label="New connection" (click)="cmds.newConnection()">＋</button>
    </div>
    <div class="filter">
      <input class="input" type="search" placeholder="Filter tables and scratches…" [ngModel]="filter()" (ngModelChange)="filter.set($event)"
             (keydown.escape)="filter.set('')" />
    </div>
    <div class="tree" role="tree" (keydown)="onTreeKey($event)">
      @for (r of rows(); track r.key) {
        @switch (r.kind) {
          @case ('folder') {
            <div class="row folder" role="treeitem" tabindex="0" [style.padding-left.px]="pad(r.depth)" [attr.aria-expanded]="r.open" [attr.id]="'n-' + r.key"
                 [class.sel]="selected() === r.key" [class.drop]="dropKey() === r.key" (click)="toggleFolder(r.folder)"
                 (focus)="selected.set(r.key)" (contextmenu)="openMenu($event, { kind: 'folder', folder: r.folder })"
                 (dragover)="onConnOver($event, r.folder)" (dragleave)="dropKey() === r.key && dropKey.set('')" (drop)="onConnDrop($event, r.folder)">
              <span class="chev" [class.open]="r.open">›</span>
              <dm-icon name="folder" [size]="13" class="ficon" />
              @if (editingFolder() === r.folder.id) {
                <input class="rename" dmAutofocus [value]="r.folder.name" (click)="$event.stopPropagation()"
                       (keydown.enter)="renameFolder(r.folder, $any($event.target).value)" (keydown.escape)="editingFolder.set('')"
                       (blur)="renameFolder(r.folder, $any($event.target).value)" />
              } @else {
                <span class="name ellipsis" [class.strong]="r.match">{{ r.folder.name }}</span>
                <span class="count">{{ r.count }}</span>
              }
            </div>
          }
          @case ('conn') {
            <div class="row conn" role="treeitem" tabindex="0" draggable="true" [style.padding-left.px]="pad(r.depth)" [attr.aria-expanded]="r.open" [attr.id]="'n-' + r.key"
                 [class.sel]="selected() === r.key" (click)="toggleConn(r.conn)" (focus)="selected.set(r.key)"
                 (contextmenu)="openMenu($event, { kind: 'conn', conn: r.conn })"
                 (dragstart)="onConnDrag($event, r.conn)" (dragend)="dropKey.set('')">
              <span class="chev" [class.open]="r.open">›</span>
              <span class="dot" [style.background]="r.conn.color" [class.off]="!r.conn.connected"></span>
              <span class="name ellipsis">{{ r.conn.name }}</span>
              @if (r.count !== undefined) { <span class="count">{{ r.count }}</span> }
              @if (r.conn.readOnly) { <span class="badge ro" title="Read-only">RO</span> }
              @if (r.loading) { <span class="spin" aria-label="Loading"></span> }
              <span class="kind faint">{{ kindLabel(r.conn) }}</span>
            </div>
          }
          @case ('db') {
            <div class="row" role="treeitem" tabindex="0" [style.padding-left.px]="pad(r.depth)" [attr.aria-expanded]="r.open" [attr.id]="'n-' + r.key"
                 [class.sel]="selected() === r.key" (click)="toggle(r)" (focus)="selected.set(r.key)"
                 (contextmenu)="openMenu($event, { kind: 'db', connId: r.connId, database: r.database, scope: r.scope })"
                 [title]="r.isCurrent ? 'Database opened by this connection' : 'Opens its own connection when expanded'">
              <span class="chev" [class.open]="r.open">›</span>
              <svg class="icon db" width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
                <ellipse cx="8" cy="3.5" rx="5.5" ry="2" fill="none" stroke="currentColor" stroke-width="1.3"/>
                <path d="M2.5 3.5v9c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2v-9M2.5 8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2" fill="none" stroke="currentColor" stroke-width="1.3"/>
              </svg>
              <span class="name ellipsis" [class.strong]="r.isCurrent">{{ r.database }}</span>
              @if (r.count !== undefined) { <span class="count">{{ r.count }}</span> }
              @if (r.loading) { <span class="spin"></span> }
            </div>
          }
          @case ('schema') {
            <div class="row" role="treeitem" tabindex="0" [style.padding-left.px]="pad(r.depth)" [attr.aria-expanded]="r.open" [attr.id]="'n-' + r.key"
                 [class.sel]="selected() === r.key" (click)="toggle(r)" (focus)="selected.set(r.key)">
              <span class="chev" [class.open]="r.open">›</span>
              <span class="icon schema" aria-hidden="true">◫</span>
              <span class="name ellipsis" [class.strong]="r.isDefault">{{ r.schema }}</span>
              @if (r.count !== undefined) { <span class="count">{{ r.count }}</span> }
              @if (r.loading) { <span class="spin"></span> }
            </div>
          }
          @case ('table') {
            <div class="row" role="treeitem" tabindex="0" [style.padding-left.px]="pad(r.depth)" [attr.aria-expanded]="r.open" [attr.id]="'n-' + r.key"
                 [class.sel]="selected() === r.key" [class.hl]="highlight() === r.key"
                 (click)="$event.detail < 2 && toggle(r)" (dblclick)="cmds.openTableData(r.connId, r.database, r.table)"
                 (focus)="selected.set(r.key)"
                 (contextmenu)="openMenu($event, { kind: 'table', connId: r.connId, database: r.database, scope: r.scope, table: r.table })"
                 title="Double-click to open the data · right-click for actions">
              <span class="chev" [class.open]="r.open">›</span>
              <span class="icon" [class.view]="r.table.type === 'view'" aria-hidden="true">{{ r.table.type === 'view' ? '◇' : '▦' }}</span>
              <span class="name ellipsis">{{ r.table.name }}</span>
              @if (r.loading) { <span class="spin"></span> }
            </div>
          }
          @case ('column') {
            <div class="row col" role="treeitem" [style.padding-left.px]="pad(r.depth) + 18">
              <span class="icon" [class.pk]="r.column.pk" aria-hidden="true">{{ r.column.pk ? '⚿' : '·' }}</span>
              <span class="name ellipsis">{{ r.column.name }}</span>
              <span class="type faint ellipsis">{{ r.column.type }}{{ r.column.nullable ? '' : ' · not null' }}</span>
            </div>
          }
          @case ('note') {
            <div class="row note faint" [style.padding-left.px]="pad(r.depth) + 18">{{ r.text }}</div>
          }
        }
      } @empty {
        <div class="empty">
          <p>No connections yet.</p>
          <button class="btn primary" (click)="cmds.newConnection()">New connection</button>
        </div>
      }
    </div>
    <dm-scratch-list class="scratches" [filter]="filter()" />

    @if (menu(); as m) {
      <div class="menu" [style.left.px]="m.x" [style.top.px]="m.y" (dmClickOutside)="menu.set(null)">
        @switch (m.kind) {
          @case ('folder') {
            <button class="menu-item" (click)="menuAction('newfolder')">New folder inside</button>
            <button class="menu-item" (click)="menuAction('rename')">Rename…</button>
            <div class="menu-sep"></div>
            <button class="menu-item danger" (click)="menuAction('delete')">Delete folder…</button>
          }
          @case ('table') {
            <button class="menu-item" (click)="menuAction('data')">Open data<span class="hint">double-click</span></button>
            <button class="menu-item" (click)="menuAction('select')">Select top 100</button>
            <button class="menu-item" (click)="menuAction('scratch')">New scratch for this table</button>
            <button class="menu-item" (click)="menuAction('insert')">Insert name</button>
            <button class="menu-item" (click)="menuAction('copy')">Copy name</button>
            <button class="menu-item" (click)="menuAction('ddl')">Show DDL</button>
          }
          @case ('db') {
            <button class="menu-item" (click)="menuAction('newtab')">New tab on this database</button>
            <button class="menu-item" (click)="menuAction('use')">Use in current tab</button>
            <button class="menu-item" (click)="menuAction('copy')">Copy name</button>
          }
          @case ('conn') {
            @if (m.conn.connected) {
              <button class="menu-item" (click)="menuAction('newtab')">New tab on this connection</button>
              <button class="menu-item" (click)="menuAction('use')">Use in current tab</button>
              <button class="menu-item" (click)="menuAction('refresh')">Refresh</button>
              <button class="menu-item" (click)="menuAction('disconnect')">Disconnect</button>
            } @else {
              <button class="menu-item" (click)="menuAction('connect')">Connect</button>
            }
            <div class="menu-sep"></div>
            <button class="menu-item" (click)="menuAction('edit')">Edit…</button>
            <div class="menu-sep"></div>
            <div class="menu-label">Move to folder</div>
            <button class="menu-item" [class.active]="!m.conn.folderId" (click)="menuAction('move:')">Root</button>
            @for (f of flatFolders(); track f.id) {
              <button class="menu-item" [class.active]="m.conn.folderId === f.id" (click)="menuAction('move:' + f.id)">
                <span class="menu-indent" [style.padding-left.px]="f.depth * 12">{{ f.name }}</span>
              </button>
            }
          }
        }
      </div>
    }
  `,
  styles: `
    :host { display: flex; flex-direction: column; min-height: 0; background: var(--bg); }
    .head { display: flex; align-items: center; height: 34px; padding: 0 6px 0 12px; flex: none; }
    .title { font-size: var(--fs-xs); font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-muted); }
    .filter { padding: 0 8px 6px; flex: none; }
    .filter .input { height: 26px; background: var(--bg-panel); }
    .tree { flex: 1 1 auto; min-height: 90px; overflow: auto; padding-bottom: 12px; }
    .scratches { flex: 0 1 auto; max-height: 45%; }
    .row { display: flex; align-items: center; gap: 5px; height: 24px; padding: 0 8px 0 6px; cursor: pointer; white-space: nowrap; outline: none; }
    .row:hover { background: var(--bg-hover); }
    .row.sel:focus-visible, .row.sel:focus { background: var(--accent-soft); box-shadow: none; }
    .row.hl { background: var(--accent-soft); }
    .row.conn { height: 28px; font-weight: 600; margin-top: 2px; }
    .row.folder { font-weight: 500; }
    .row.drop { background: var(--accent-soft); box-shadow: inset 0 0 0 1px var(--accent); }
    .ficon { color: var(--text-faint); flex: none; }
    .rename { flex: 1; min-width: 0; height: 20px; padding: 0 4px; border: 1px solid var(--accent); border-radius: 3px; background: var(--bg-panel); outline: none; font-size: var(--fs); }
    .menu-indent { display: block; }
    .row.col { cursor: default; font-size: var(--fs-sm); }
    .row.note { cursor: default; font-size: var(--fs-xs); font-style: italic; }
    .chev { width: 12px; flex: none; text-align: center; color: var(--text-faint); transition: transform 0.12s; font-size: 14px; line-height: 1; }
    .chev.open { transform: rotate(90deg); }
    .dot.off { opacity: 0.35; }
    .icon { width: 14px; flex: none; text-align: center; color: var(--text-faint); font-size: 12px; }
    .icon.db { color: var(--accent); }
    .icon.view { color: var(--warn); }
    .icon.pk { color: var(--warn); }
    .name { min-width: 0; }
    .name.strong { font-weight: 600; }
    .count { flex: none; padding: 0 5px; height: 16px; line-height: 14px; border: 1px solid var(--border); border-radius: 4px;
             font-size: 10.5px; font-weight: 500; color: var(--text-faint); font-variant-numeric: tabular-nums; }
    .kind { margin-left: auto; font-size: var(--fs-xs); font-weight: 400; padding-left: 6px; }
    .type { margin-left: auto; padding-left: 8px; font-family: var(--font-mono); font-size: 11px; max-width: 55%; }
    .spin { width: 10px; height: 10px; border: 1.5px solid var(--border-strong); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; flex: none; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .empty { padding: 28px 16px; text-align: center; color: var(--text-muted); }
  `,
})
export class SchemaSidebar {
  readonly cmds = inject(Commands);
  readonly conns = inject(ConnectionStore);
  readonly schema = inject(SchemaStore);
  private tabs = inject(TabStore);
  private ui = inject(Ui);
  private tx = inject(TxStore);
  private el = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly filter = signal('');
  readonly expanded = signal<ReadonlySet<string>>(new Set());
  readonly selected = signal('');
  readonly highlight = signal('');
  readonly menu = signal<Menu | null>(null);
  readonly editingFolder = signal('');
  readonly dropKey = signal('');

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

  /** Folders in display order, with their nesting depth (for the move-to-folder menu). */
  readonly flatFolders = computed(() => {
    const folders = this.conns.folders();
    const ids = new Set(folders.map((f) => f.id));
    const byParent = new Map<string, ConnectionFolder[]>();
    for (const f of folders) {
      const parent = f.parentId && ids.has(f.parentId) ? f.parentId : '';
      const list = byParent.get(parent) ?? [];
      list.push(f);
      byParent.set(parent, list);
    }
    for (const list of byParent.values()) list.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    const out: { id: string; name: string; depth: number }[] = [];
    const walk = (parent: string, depth: number) => {
      for (const f of byParent.get(parent) ?? []) {
        out.push({ id: f.id, name: f.name, depth });
        walk(f.id, depth + 1);
      }
    };
    walk('', 0);
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

  async newFolder(parentId: string) {
    const f = await this.conns.createFolder('New folder', parentId);
    if (!f) return;
    if (parentId) this.expand(`f:${parentId}`);
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

  // ---- drag & drop: dropping a connection on a folder files it there ----

  onConnDrag(e: DragEvent, conn: ConnectionView) {
    e.dataTransfer?.setData(CONN_DRAG_TYPE, conn.id);
    e.dataTransfer?.setData('text/plain', conn.name);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  }

  onConnOver(e: DragEvent, folder: ConnectionFolder) {
    if (!e.dataTransfer?.types.includes(CONN_DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    this.dropKey.set(`f:${folder.id}`);
  }

  onConnDrop(e: DragEvent, folder: ConnectionFolder) {
    e.preventDefault();
    this.dropKey.set('');
    const id = e.dataTransfer?.getData(CONN_DRAG_TYPE);
    if (!id) return;
    this.expand(`f:${folder.id}`);
    void this.conns.moveToFolder(id, folder.id);
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
    if (action.startsWith('move:')) {
      if (m.kind === 'conn') void this.conns.moveToFolder(m.conn.id, action.slice(5));
      return;
    }
    switch (m.kind) {
      case 'folder': {
        switch (action) {
          case 'newfolder': return void this.newFolder(m.folder.id);
          case 'rename': return this.editingFolder.set(m.folder.id);
          case 'delete': {
            if (!confirm(`Delete the folder “${m.folder.name}”? Its connections and sub-folders move up one level.`)) return;
            return void this.conns.deleteFolder(m.folder.id);
          }
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
        }
        return;
      }
      case 'db': {
        const db = m.database || this.schema.databases()[m.connId]?.current || '';
        switch (action) {
          case 'newtab': return this.cmds.newTab(m.connId, m.database);
          case 'use': return this.useInTab(m.connId, m.database);
          case 'copy': return void this.cmds.copy(db);
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
          case 'edit': return this.cmds.editConnection(c);
        }
      }
    }
  }

  useInTab(connId: string, database: string) {
    const t = this.tabs.active();
    if (!t || !this.tx.confirmLeave(t.id)) return;
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
