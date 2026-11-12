import { Component, computed, inject, input, signal } from '@angular/core';
import { Commands } from '../../core/commands';
import { ConnectionStore } from '../../core/connection.store';
import { ScratchStore } from '../../core/scratch.store';
import { SchemaStore } from '../../core/schema.store';
import { TabStore } from '../../core/tab.store';
import { Ui } from '../../core/ui';
import { ClickOutside, clampMenu } from '../../shared/click-outside';
import { Autofocus } from '../../shared/autofocus';
import { Icon } from '../../shared/icon';
import type { ScratchInfo } from '../../core/models';
import { buildScratchTree, flattenTree, type FolderNode } from './scratch-tree';

const COLLAPSED_KEY = 'dolmen.scratches.collapsed';
const FOLDERS_KEY = 'dolmen.scratches.folders';
const DRAG_TYPE = 'application/x-dolmen-scratch';

/** Relative time for the scratch list ("just now", "5 min ago", "Mar 3"). */
export function ago(ms: number, now = Date.now()): string {
  const s = Math.round((now - ms) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.round(s / 86400)} d ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function loadSet(key: string): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(key) ?? '[]'));
  } catch {
    return new Set();
  }
}

type Menu =
  | { x: number; y: number; kind: 'file'; s: ScratchInfo }
  | { x: number; y: number; kind: 'folder'; f: FolderNode };

/** Scratch files, filed in connection → database → table folders, under the explorer. */
@Component({
  selector: 'dm-scratch-list',
  imports: [ClickOutside, Autofocus, Icon],
  template: `
    <div class="head">
      <button class="toggle" (click)="toggle()" [attr.aria-expanded]="!collapsed()">
        <span class="chev" [class.open]="!collapsed()">›</span>
        <span class="title">Scratches</span>
        <span class="count">{{ store.list().length }}</span>
      </button>
      <span class="spacer"></span>
      <button class="ib" (click)="cmds.newTab()" title="New scratch" aria-label="New scratch"><dm-icon name="plus" [size]="14" /></button>
      <button class="ib" (click)="store.importFile()" title="Open a .sql file as scratch" aria-label="Open a SQL file"><dm-icon name="folderOpen" [size]="14" /></button>
      <button class="ib" (click)="ui.toggleScratchPosition()"
              [title]="ui.scratchPosition() === 'left' ? 'Move scratches under the explorer' : 'Move scratches to a left panel'"
              [attr.aria-label]="ui.scratchPosition() === 'left' ? 'Dock scratches in the explorer' : 'Dock scratches on the left'">
        <dm-icon [name]="ui.scratchPosition() === 'left' ? 'panelBottom' : 'panelLeft'" [size]="14" />
      </button>
    </div>

    @if (!collapsed()) {
      <div class="list" role="tree">
        @for (r of rows(); track r.node.key) {
          @if (r.node.kind === 'folder') {
            @let f = r.node;
            <div class="row folder" role="treeitem" [attr.aria-expanded]="r.open" [style.padding-left.px]="8 + r.depth * 14"
                 [class.drop]="dropKey() === f.key" (click)="toggleFolder(f.key)" (contextmenu)="openFolderMenu($event, f)"
                 (dragover)="onDragOver($event, f)" (dragleave)="dropKey() === f.key && dropKey.set('')" (drop)="onDrop($event, f)"
                 [title]="folderTitle(f)">
              <span class="chev" [class.open]="r.open">›</span>
              @switch (f.level) {
                @case ('conn') { <span class="dot" [style.background]="f.color"></span> }
                @case ('db') { <svg class="ficon db" width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><ellipse cx="8" cy="3.5" rx="5.5" ry="2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M2.5 3.5v9c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2v-9M2.5 8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2" fill="none" stroke="currentColor" stroke-width="1.3"/></svg> }
                @case ('table') { <dm-icon name="table" [size]="13" class="ficon tbl" /> }
                @default { <span class="dot none"></span> }
              }
              <span class="label ellipsis" [class.strong]="f.level === 'conn'">{{ f.label }}</span>
              @if (f.detail) { <span class="detail ellipsis">{{ f.detail }}</span> }
              <span class="n">{{ f.count }}</span>
            </div>
          } @else {
            @let s = r.node.scratch;
            <div class="row file" role="treeitem" tabindex="0" draggable="true" [style.padding-left.px]="8 + r.depth * 14 + 14"
                 [class.open]="store.openIds().has(s.id)" [class.active]="s.id === tabs.activeId()"
                 (click)="editing() !== s.id && store.open(s.id)" (keydown.enter)="store.open(s.id)" (keydown.f2)="editing.set(s.id)"
                 (contextmenu)="openFileMenu($event, s)" (dragstart)="onDragStart($event, s)" (dragend)="dropKey.set('')"
                 [title]="(s.preview || s.name) + '\\nDrag onto a folder to move it'">
              <dm-icon name="file" [size]="14" class="fi" />
              @if (editing() === s.id) {
                <input class="rename" dmAutofocus [value]="s.name" (click)="$event.stopPropagation()"
                       (keydown.enter)="rename(s, $any($event.target).value)" (keydown.escape)="editing.set('')"
                       (blur)="rename(s, $any($event.target).value)" />
              } @else {
                <span class="label ellipsis">{{ s.name }}</span>
                <span class="when">{{ ago(s.updatedAt) }}</span>
              }
            </div>
          }
        } @empty {
          <p class="empty">{{ filter() ? 'No scratch matches the filter.' : 'No scratch files yet.' }}</p>
        }
      </div>
    }

    @if (menu(); as m) {
      <div class="menu" [style.left.px]="m.x" [style.top.px]="m.y" (dmClickOutside)="menu.set(null)">
        @if (m.kind === 'file') {
          <button class="menu-item" (click)="act('open')">Open</button>
          <button class="menu-item" (click)="act('rename')">Rename<span class="hint">F2</span></button>
          <button class="menu-item" (click)="act('duplicate')">Duplicate</button>
          <button class="menu-item" (click)="act('export')">Save as file…</button>
          @if (m.s.table) {
            <button class="menu-item" (click)="act('untable')">Move out of “{{ m.s.table }}”</button>
          }
          <div class="menu-sep"></div>
          <button class="menu-item danger" (click)="act('delete')">Delete…</button>
        } @else {
          @if (m.f.level !== 'none') {
            <button class="menu-item" (click)="act('new')">New scratch here</button>
          }
          <button class="menu-item" (click)="act('collapse')">Collapse all</button>
          <button class="menu-item" (click)="act('expand')">Expand all</button>
        }
      </div>
    }
  `,
  styles: `
    :host { display: flex; flex-direction: column; min-height: 0; border-top: 1px solid var(--border); }
    .head { display: flex; align-items: center; height: 32px; padding: 0 6px 0 4px; flex: none; }
    .toggle { display: flex; align-items: center; gap: 5px; height: 26px; padding: 0 6px; border: 0; border-radius: 4px; background: none; cursor: pointer; }
    .toggle:hover { background: var(--bg-hover); }
    .chev { width: 12px; flex: none; text-align: center; color: var(--text-faint); transition: transform 0.12s; font-size: 14px; line-height: 1; }
    .chev.open { transform: rotate(90deg); }
    .title { font-size: var(--fs-xs); font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-muted); }
    .count { padding: 0 5px; height: 16px; line-height: 14px; border: 1px solid var(--border); border-radius: 4px; font-size: 10.5px; color: var(--text-faint); }
    .ib { display: inline-grid; place-items: center; width: 24px; height: 24px; padding: 0; border: 0; border-radius: 5px; background: none; color: var(--text-muted); cursor: pointer; }
    .ib:hover { background: var(--bg-hover); color: var(--text); }
    .list { flex: 1 1 auto; min-height: 0; overflow: auto; padding-bottom: 8px; }
    .row { display: flex; align-items: center; gap: 6px; height: 24px; padding-right: 10px; cursor: pointer; outline: none; white-space: nowrap; }
    .row:hover, .row:focus-visible { background: var(--bg-hover); }
    .row.drop { background: var(--accent-soft); box-shadow: inset 0 0 0 1px var(--accent); }
    .row.file.active { background: var(--accent-soft); }
    .label { min-width: 0; }
    .label.strong { font-weight: 600; }
    .detail { color: var(--text-faint); font-size: var(--fs-xs); min-width: 0; }
    .n { margin-left: auto; padding-left: 6px; font-size: 10.5px; color: var(--text-faint); font-variant-numeric: tabular-nums; }
    .dot.none { background: transparent; border: 1px dashed var(--text-faint); }
    .ficon { flex: none; }
    .ficon.db { color: var(--accent); }
    .ficon.tbl { color: var(--text-faint); }
    .fi { color: var(--text-faint); flex: none; }
    .row.open .fi { color: var(--accent); }
    .when { margin-left: auto; padding-left: 6px; font-size: var(--fs-xs); color: var(--text-faint); }
    .rename { flex: 1; min-width: 0; height: 20px; padding: 0 4px; border: 1px solid var(--accent); border-radius: 3px; background: var(--bg-panel); outline: none; font-size: var(--fs); }
    .empty { margin: 4px 14px 10px; font-size: var(--fs-xs); color: var(--text-faint); }
  `,
})
export class ScratchList {
  readonly store = inject(ScratchStore);
  readonly tabs = inject(TabStore);
  readonly cmds = inject(Commands);
  readonly ui = inject(Ui);
  private conns = inject(ConnectionStore);
  private schema = inject(SchemaStore);

  readonly filter = input('');
  readonly collapsed = signal(localStorage.getItem(COLLAPSED_KEY) === '1');
  /** Collapsed folder keys (folders start expanded). */
  readonly folded = signal<ReadonlySet<string>>(loadSet(FOLDERS_KEY));
  readonly editing = signal('');
  readonly dropKey = signal('');
  readonly menu = signal<Menu | null>(null);
  readonly ago = ago;

  readonly tree = computed(() => {
    const dbs = this.schema.databases();
    return buildScratchTree(this.store.list(), {
      connections: this.conns.connections(),
      currentDb: (id) => dbs[id]?.current,
    });
  });

  readonly rows = computed(() => flattenTree(this.tree(), this.folded(), this.filter()));

  constructor() { void this.store.refresh(); }

  toggle() {
    this.collapsed.update((v) => !v);
    try { localStorage.setItem(COLLAPSED_KEY, this.collapsed() ? '1' : '0'); } catch { /* storage unavailable */ }
  }

  toggleFolder(key: string) {
    const s = new Set(this.folded());
    if (s.has(key)) s.delete(key); else s.add(key);
    this.setFolded(s);
  }

  private setFolded(s: Set<string>) {
    this.folded.set(s);
    try { localStorage.setItem(FOLDERS_KEY, JSON.stringify([...s])); } catch { /* storage unavailable */ }
  }

  folderTitle(f: FolderNode) {
    const what = { conn: 'Connection', db: 'Database', table: 'Table', none: 'Scratches whose connection was deleted' }[f.level];
    return f.level === 'none' ? what : `${what} ${f.detail ? f.detail + '.' : ''}${f.label}: drop a scratch here to file it`;
  }

  // ---- drag & drop: dropping a scratch on a folder files it there ----

  onDragStart(e: DragEvent, s: ScratchInfo) {
    e.dataTransfer?.setData(DRAG_TYPE, s.id);
    e.dataTransfer?.setData('text/plain', s.name);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  }

  onDragOver(e: DragEvent, f: FolderNode) {
    if (f.level === 'none' || !e.dataTransfer?.types.includes(DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    this.dropKey.set(f.key);
  }

  onDrop(e: DragEvent, f: FolderNode) {
    e.preventDefault();
    this.dropKey.set('');
    const id = e.dataTransfer?.getData(DRAG_TYPE);
    if (!id || f.level === 'none') return;
    void this.store.moveTo(id, { connId: f.connId, database: f.database, schema: f.schema, table: f.table });
    // Make sure the destination is visible.
    const s = new Set(this.folded());
    for (const k of [f.key, `c:${f.connId}`]) s.delete(k);
    this.setFolded(s);
  }

  // ---- menus ----

  openFileMenu(e: MouseEvent, s: ScratchInfo) {
    e.preventDefault();
    this.menu.set({ ...clampMenu(e.clientX, e.clientY, 220, 200), kind: 'file', s });
  }

  openFolderMenu(e: MouseEvent, f: FolderNode) {
    e.preventDefault();
    this.menu.set({ ...clampMenu(e.clientX, e.clientY, 200, 120), kind: 'folder', f });
  }

  act(action: string) {
    const m = this.menu();
    this.menu.set(null);
    if (!m) return;
    if (m.kind === 'folder') {
      const f = m.f;
      switch (action) {
        case 'new': return void this.store.createIn({ connId: f.connId, database: f.database, schema: f.schema, table: f.table });
        case 'collapse': return this.setFolded(new Set(this.allFolderKeys()));
        case 'expand': return this.setFolded(new Set());
      }
      return;
    }
    const s = m.s;
    switch (action) {
      case 'open': return void this.store.open(s.id);
      case 'rename': return this.editing.set(s.id);
      case 'duplicate': return void this.store.duplicate(s.id);
      case 'export': return void this.store.exportFile(s.id);
      case 'untable': return void this.store.moveTo(s.id, { connId: s.connId, database: s.database ?? '', schema: '', table: '' });
      case 'delete': return void this.store.remove(s.id);
    }
  }

  private allFolderKeys(): string[] {
    const keys: string[] = [];
    const walk = (f: FolderNode) => {
      keys.push(f.key);
      for (const c of f.children) if (c.kind === 'folder') walk(c);
    };
    this.tree().forEach(walk);
    return keys;
  }

  rename(s: ScratchInfo, name: string) {
    if (this.editing() !== s.id) return;
    this.editing.set('');
    if (name.trim() && name.trim() !== s.name) void this.store.rename(s.id, name);
  }
}
