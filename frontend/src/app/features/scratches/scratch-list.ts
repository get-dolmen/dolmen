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
export function relativeTime(timestamp: number, now = Date.now()): string {
  const seconds = Math.round((now - timestamp) / 1000);
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  if (seconds < 7 * 86400) return `${Math.round(seconds / 86400)} d ago`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function loadSet(key: string): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(key) ?? '[]'));
  } catch {
    return new Set();
  }
}

type ContextMenu =
  | { x: number; y: number; kind: 'file'; scratch: ScratchInfo }
  | { x: number; y: number; kind: 'folder'; folder: FolderNode };

/** Scratch files, filed in connection → database → table folders, under the explorer. */
@Component({
  selector: 'dm-scratch-list',
  imports: [ClickOutside, Autofocus, Icon],
  templateUrl: './scratch-list.html',
  styleUrl: './scratch-list.scss',
})
export class ScratchList {
  public readonly scratchStore = inject(ScratchStore);
  public readonly tabStore = inject(TabStore);
  public readonly commandService = inject(Commands);
  public readonly uiState = inject(Ui);
  private connectionStore = inject(ConnectionStore);
  private schemaStore = inject(SchemaStore);

  public readonly filter = input('');
  public readonly collapsed = signal(localStorage.getItem(COLLAPSED_KEY) === '1');
  /** Collapsed folder keys (folders start expanded). */
  public readonly folded = signal<ReadonlySet<string>>(loadSet(FOLDERS_KEY));
  public readonly editingId = signal('');
  public readonly dropTargetKey = signal('');
  public readonly contextMenu = signal<ContextMenu | null>(null);
  public readonly relativeTime = relativeTime;

  public readonly tree = computed(() => {
    const databases = this.schemaStore.databases();
    return buildScratchTree(this.scratchStore.list(), {
      connections: this.connectionStore.connections(),
      currentDatabase: (connectionId) => databases[connectionId]?.current,
    });
  });

  public readonly rows = computed(() => flattenTree(this.tree(), this.folded(), this.filter()));
  /** Docked on the left, the panel itself is collapsed from the top bar. */
  public readonly isDockedLeft = computed(() => this.uiState.scratchPosition() === 'left');
  public readonly showsList = computed(() => this.isDockedLeft() || !this.collapsed());

  public constructor() { void this.scratchStore.refresh(); }

  public toggle() {
    // In the left dock the whole panel collapses, so there is no header left to click.
    if (this.isDockedLeft()) return this.uiState.scratchOpen.set(false);
    this.collapsed.update((value) => !value);
    try { localStorage.setItem(COLLAPSED_KEY, this.collapsed() ? '1' : '0'); } catch { /* storage unavailable */ }
  }

  public toggleFolder(key: string) {
    const folded = new Set(this.folded());
    if (folded.has(key)) folded.delete(key); else folded.add(key);
    this.setFolded(folded);
  }

  private setFolded(folded: Set<string>) {
    this.folded.set(folded);
    try {
      localStorage.setItem(FOLDERS_KEY, JSON.stringify([...folded]));
    } catch { /* storage unavailable */ }
  }

  public folderTitle(folder: FolderNode) {
    const kind = { conn: 'Connection', db: 'Database', table: 'Table', none: 'Scratches whose connection was deleted' }[folder.level];
    return folder.level === 'none'
      ? kind
      : `${kind} ${folder.detail ? folder.detail + '.' : ''}${folder.label}: drop a scratch here to file it`;
  }

  // ---- drag & drop: dropping a scratch on a folder files it there ----

  public onDragStart(event: DragEvent, scratch: ScratchInfo) {
    event.dataTransfer?.setData(DRAG_TYPE, scratch.id);
    event.dataTransfer?.setData('text/plain', scratch.name);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  }

  public onDragOver(event: DragEvent, folder: FolderNode) {
    if (folder.level === 'none' || !event.dataTransfer?.types.includes(DRAG_TYPE)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    this.dropTargetKey.set(folder.key);
  }

  public onDrop(event: DragEvent, folder: FolderNode) {
    event.preventDefault();
    this.dropTargetKey.set('');
    const scratchId = event.dataTransfer?.getData(DRAG_TYPE);
    if (!scratchId || folder.level === 'none') return;
    void this.scratchStore.moveTo(scratchId, {
      connId: folder.connId, database: folder.database, schema: folder.schema, table: folder.table,
    });
    // Make sure the destination is visible.
    const folded = new Set(this.folded());
    for (const key of [folder.key, `c:${folder.connId}`]) folded.delete(key);
    this.setFolded(folded);
  }

  // ---- menus ----

  public openFileMenu(event: MouseEvent, scratch: ScratchInfo) {
    event.preventDefault();
    this.contextMenu.set({ ...clampMenu(event.clientX, event.clientY, 220, 200), kind: 'file', scratch });
  }

  public openFolderMenu(event: MouseEvent, folder: FolderNode) {
    event.preventDefault();
    this.contextMenu.set({ ...clampMenu(event.clientX, event.clientY, 200, 120), kind: 'folder', folder });
  }

  public runMenuAction(action: string) {
    const menu = this.contextMenu();
    this.contextMenu.set(null);
    if (!menu) return;
    if (menu.kind === 'folder') {
      const folder = menu.folder;
      switch (action) {
        case 'new':
          return void this.scratchStore.createIn({
            connId: folder.connId, database: folder.database, schema: folder.schema, table: folder.table,
          });
        case 'collapse': return this.setFolded(new Set(this.allFolderKeys()));
        case 'expand': return this.setFolded(new Set());
      }
      return;
    }
    const scratch = menu.scratch;
    switch (action) {
      case 'open': return void this.scratchStore.open(scratch.id);
      case 'rename': return this.editingId.set(scratch.id);
      case 'lock': return void this.scratchStore.setLocked(scratch.id, true);
      case 'unlock': return void this.scratchStore.setLocked(scratch.id, false);
      case 'duplicate': return void this.scratchStore.duplicate(scratch.id);
      case 'export': return void this.scratchStore.exportFile(scratch.id);
      case 'untable': return void this.scratchStore.moveTo(scratch.id, {
        connId: scratch.connId, database: scratch.database ?? '', schema: '', table: '',
      });
      case 'delete': return void this.scratchStore.remove(scratch.id);
    }
  }

  private allFolderKeys(): string[] {
    const keys: string[] = [];
    const walk = (folder: FolderNode) => {
      keys.push(folder.key);
      for (const child of folder.children) if (child.kind === 'folder') walk(child);
    };
    this.tree().forEach(walk);
    return keys;
  }

  public rename(scratch: ScratchInfo, name: string) {
    if (this.editingId() !== scratch.id) return;
    this.editingId.set('');
    if (name.trim() && name.trim() !== scratch.name) void this.scratchStore.rename(scratch.id, name);
  }
}
