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
  templateUrl: './scratch-list.html',
  styleUrl: './scratch-list.scss',
})
export class ScratchList {
  public readonly store = inject(ScratchStore);
  public readonly tabs = inject(TabStore);
  public readonly cmds = inject(Commands);
  public readonly ui = inject(Ui);
  private conns = inject(ConnectionStore);
  private schema = inject(SchemaStore);

  public readonly filter = input('');
  public readonly collapsed = signal(localStorage.getItem(COLLAPSED_KEY) === '1');
  /** Collapsed folder keys (folders start expanded). */
  public readonly folded = signal<ReadonlySet<string>>(loadSet(FOLDERS_KEY));
  public readonly editing = signal('');
  public readonly dropKey = signal('');
  public readonly menu = signal<Menu | null>(null);
  public readonly ago = ago;

  public readonly tree = computed(() => {
    const dbs = this.schema.databases();
    return buildScratchTree(this.store.list(), {
      connections: this.conns.connections(),
      currentDb: (id) => dbs[id]?.current,
    });
  });

  public readonly rows = computed(() => flattenTree(this.tree(), this.folded(), this.filter()));

  public constructor() { void this.store.refresh(); }

  public toggle() {
    this.collapsed.update((v) => !v);
    try { localStorage.setItem(COLLAPSED_KEY, this.collapsed() ? '1' : '0'); } catch { /* storage unavailable */ }
  }

  public toggleFolder(key: string) {
    const s = new Set(this.folded());
    if (s.has(key)) s.delete(key); else s.add(key);
    this.setFolded(s);
  }

  private setFolded(s: Set<string>) {
    this.folded.set(s);
    try { localStorage.setItem(FOLDERS_KEY, JSON.stringify([...s])); } catch { /* storage unavailable */ }
  }

  public folderTitle(f: FolderNode) {
    const what = { conn: 'Connection', db: 'Database', table: 'Table', none: 'Scratches whose connection was deleted' }[f.level];
    return f.level === 'none' ? what : `${what} ${f.detail ? f.detail + '.' : ''}${f.label}: drop a scratch here to file it`;
  }

  // ---- drag & drop: dropping a scratch on a folder files it there ----

  public onDragStart(e: DragEvent, s: ScratchInfo) {
    e.dataTransfer?.setData(DRAG_TYPE, s.id);
    e.dataTransfer?.setData('text/plain', s.name);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  }

  public onDragOver(e: DragEvent, f: FolderNode) {
    if (f.level === 'none' || !e.dataTransfer?.types.includes(DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    this.dropKey.set(f.key);
  }

  public onDrop(e: DragEvent, f: FolderNode) {
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

  public openFileMenu(e: MouseEvent, s: ScratchInfo) {
    e.preventDefault();
    this.menu.set({ ...clampMenu(e.clientX, e.clientY, 220, 200), kind: 'file', s });
  }

  public openFolderMenu(e: MouseEvent, f: FolderNode) {
    e.preventDefault();
    this.menu.set({ ...clampMenu(e.clientX, e.clientY, 200, 120), kind: 'folder', f });
  }

  public act(action: string) {
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
      case 'lock': return void this.store.setLocked(s.id, true);
      case 'unlock': return void this.store.setLocked(s.id, false);
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

  public rename(s: ScratchInfo, name: string) {
    if (this.editing() !== s.id) return;
    this.editing.set('');
    if (name.trim() && name.trim() !== s.name) void this.store.rename(s.id, name);
  }
}
