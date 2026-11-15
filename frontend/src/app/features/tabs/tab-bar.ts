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
  styles: `
    :host { display: flex; flex-direction: column; flex: none; min-width: 0; background: var(--bg); }
    .tabrow { display: flex; align-items: flex-end; height: 34px; padding-left: 6px; border-bottom: 1px solid var(--border); min-width: 0; }
    .tabs { display: flex; align-items: flex-end; height: 100%; min-width: 0; flex: 0 1 auto; overflow-x: auto; scrollbar-width: none; }
    .tab { position: relative; display: flex; align-items: center; gap: 6px; height: 30px; max-width: 300px; padding: 0 6px 0 12px; margin-right: 1px;
           border-radius: 6px 6px 0 0; color: var(--text-muted); cursor: pointer; white-space: nowrap; font-size: var(--fs-sm); flex: none; }
    .tab:hover { background: var(--bg-hover); color: var(--text); }
    .tab.on { background: var(--bg-panel); color: var(--text); box-shadow: 0 0 0 1px var(--border); clip-path: inset(-1px -1px 0 -1px); }
    .tab.on::before { content: ''; position: absolute; left: 0; right: 0; top: 0; height: 2px; border-radius: 6px 6px 0 0; background: var(--conn, var(--accent)); }
    .name { overflow: hidden; text-overflow: ellipsis; }
    .rename { width: 140px; height: 20px; padding: 0 4px; border: 1px solid var(--accent); border-radius: 3px; background: var(--bg-panel); outline: none; }
    .close { display: grid; place-items: center; width: 18px; height: 18px; padding: 0; border: 0; border-radius: 4px; background: none; color: var(--text-faint); cursor: pointer; }
    .close:hover { background: var(--bg-active); color: var(--text); }
    .close .x, .close .d { grid-area: 1 / 1; }
    .close .d { display: none; font-size: 8px; }
    .close.dirty:not(:hover) .x { visibility: hidden; }
    .close.dirty:not(:hover) .d { display: block; }
    .tab:not(:hover):not(.on) .close:not(.dirty) { visibility: hidden; }
    .add { margin: 0 6px 4px; flex: none; }
    .actions { display: flex; align-items: center; gap: 6px; height: 36px; padding: 0 8px; background: var(--bg-panel); border-bottom: 1px solid var(--border); min-width: 0; overflow-x: auto; scrollbar-width: none; }
    .actions > * { flex: none; }
    .actions > .spacer { flex: 1 1 auto; }
    .run { min-width: 62px; justify-content: center; }
    .btn.icon.on { color: var(--accent); }
    .dbtarget { display: inline-flex; align-items: center; gap: 3px; height: 24px; max-width: 170px; padding: 0 7px; border: 1px solid var(--border);
                border-radius: var(--radius); background: none; color: var(--text-muted); font-size: var(--fs-sm); cursor: pointer; }
    .dbtarget:hover:not(:disabled) { background: var(--bg-hover); color: var(--text); }
    .dbtarget:disabled { opacity: 0.6; cursor: default; }
    .dbname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dbmenu { width: 240px; }
    .txmode { height: 24px; padding: 0 8px; border: 1px solid var(--border); border-radius: var(--radius); background: none; color: var(--text-muted);
              font-size: var(--fs-sm); font-weight: 600; cursor: pointer; white-space: nowrap; }
    .txmode:hover { background: var(--bg-hover); color: var(--text); }
    .txmode.manual { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 45%, transparent); }
    .caret { color: var(--text-faint); font-size: 10px; margin-left: 2px; }
    .txopen { display: inline-flex; align-items: center; gap: 5px; height: 20px; padding: 0 8px; border-radius: 10px; background: var(--warn-soft);
              color: var(--warn); font-size: var(--fs-xs); font-weight: 700; font-variant-numeric: tabular-nums; }
    .pulse { width: 7px; height: 7px; border-radius: 50%; background: var(--warn); animation: txpulse 1.6s ease-in-out infinite; }
    @keyframes txpulse { 50% { opacity: 0.35; } }
    .vsep { width: 1px; height: 20px; background: var(--border); margin: 0 2px; }
    .txmenu { width: 300px; }
    .txmenu .menu-item { height: auto; padding: 6px 8px; align-items: flex-start; }
    .txmenu .menu-item span { display: flex; flex-direction: column; gap: 1px; }
    .txmenu .menu-item small { color: var(--text-muted); font-size: var(--fs-xs); white-space: normal; }
    .txmenu .menu-item:disabled { opacity: 0.5; cursor: default; }
    .tbl { color: var(--accent); font-size: 11px; }
    .where { color: var(--text-faint); }
    .spin { width: 9px; height: 9px; border: 1.5px solid var(--accent-soft); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .cdk-drag-preview { box-shadow: var(--shadow); background: var(--bg-panel); }
    .cdk-drag-placeholder { opacity: 0.3; }
  `,
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
