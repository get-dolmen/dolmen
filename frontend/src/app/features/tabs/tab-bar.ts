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

@Component({
  selector: 'dm-tab-bar',
  imports: [CdkDropList, CdkDrag, Autofocus, ClickOutside, Icon],
  templateUrl: './tab-bar.html',
  styleUrl: './tab-bar.scss',
})
export class TabBar {
  readonly tabs = inject(TabStore);
  readonly cmds = inject(Commands);
  private conns = inject(ConnectionStore);
  private runs = inject(RunStore);
  private scratches = inject(ScratchStore);
  private schema = inject(SchemaStore);
  readonly tx = inject(TxStore);
  readonly ui = inject(Ui);
  readonly editing = signal('');
  readonly mod = MOD;
  readonly txMenu = signal<{ x: number; y: number } | null>(null);
  readonly dbMenu = signal<{ x: number; y: number } | null>(null);
  readonly tab = computed(() => this.tabs.active());
  readonly txState = computed(() => this.tx.get(this.tabs.activeId()));
  readonly since = computed(() => new Date(this.txState().startedAt).toLocaleTimeString());
  readonly readOnly = computed(() => !!this.conns.get(this.tabs.active()?.connId)?.readOnly);
  readonly dbInfo = computed(() => {
    const t = this.tab();
    return t?.kind === 'sql' ? this.schema.databases()[t.connId] : undefined;
  });
  readonly showDb = computed(() => !!this.dbInfo()?.supported && (this.dbInfo()?.databases.length ?? 0) > 1);
  readonly dbLabel = computed(() => {
    const t = this.tab();
    if (!t) return '';
    return t.database || this.dbInfo()?.current || 'default';
  });

  openTxMenu(e: MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    this.txMenu.set(clampMenu(r.right - 300, r.bottom + 4, 300, 160));
  }

  setMode(mode: 'auto' | 'manual') {
    const t = this.tabs.active();
    if (t && this.tx.setMode(t.id, mode)) this.txMenu.set(null);
  }

  openDbMenu(e: MouseEvent) {
    const t = this.tab();
    if (!t || t.locked) return;
    if (!this.dbInfo()) void this.schema.loadDatabases(t.connId);
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    this.dbMenu.set(clampMenu(r.right - 240, r.bottom + 4, 240, 260));
  }

  isCurrentDb(db: string) {
    const t = this.tab();
    return !!t && (t.database || this.dbInfo()?.current || '') === db;
  }

  async chooseDb(db: string) {
    this.dbMenu.set(null);
    const t = this.tab();
    const info = this.dbInfo();
    if (!t || !info || t.locked) return;
    const next = db === info.current ? '' : db;
    if ((t.database || '') === next) return;
    if (!(await this.tx.confirmLeave(t.id))) return;
    this.tabs.setConnection(t.id, t.connId, next);
  }

  color(t: EditorTab) { return this.conns.get(t.connId)?.color ?? null; }
  /** "connection" or "connection/database" for data tabs. */
  where(t: EditorTab) {
    const c = this.conns.get(t.connId)?.name ?? '?';
    return t.database ? `${c}/${t.database}` : c;
  }

  running(t: EditorTab) { return !!this.runs.runs()[t.id]?.running; }

  title(t: EditorTab) {
    const c = this.conns.get(t.connId);
    return `${t.name}${c ? ' · ' + c.name : ''}\nDouble-click to rename`;
  }

  rename(t: EditorTab, name: string) {
    if (this.editing() !== t.id) return;
    this.editing.set('');
    if (!name.trim() || name.trim() === t.name) return;
    // SQL tabs are scratch files: rename the file; data tabs only change their label.
    if (t.kind === 'sql') void this.scratches.rename(t.id, name);
    else this.tabs.rename(t.id, name);
  }

  readonly menu = signal<{ x: number; y: number; t: EditorTab } | null>(null);

  openMenu(e: MouseEvent, t: EditorTab) {
    e.preventDefault();
    this.menu.set({ ...clampMenu(e.clientX, e.clientY, 210, 240), t });
  }

  async act(action: string) {
    const m = this.menu();
    this.menu.set(null);
    if (!m) return;
    const id = m.t.id;
    switch (action) {
      case 'rename': return this.editing.set(id);
      case 'save': return void this.scratches.save(id);
      case 'export': return void this.scratches.exportFile(id);
      case 'duplicate': return void this.scratches.duplicate(id);
      case 'close': return void this.cmds.closeTab(id);
      case 'others':
        for (const t of this.tabs.tabs()) if (t.id !== id) await this.cmds.closeTab(t.id);
        return;
      case 'delete': return void this.scratches.remove(id);
    }
  }

  drop(e: CdkDragDrop<unknown>) {
    if (e.previousIndex !== e.currentIndex) this.tabs.move(e.previousIndex, e.currentIndex);
  }
}
