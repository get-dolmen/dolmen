import { Component, inject, signal } from '@angular/core';
import { CdkDrag, CdkDragDrop, CdkDropList } from '@angular/cdk/drag-drop';
import { Commands } from '../../core/commands';
import { ConnectionStore } from '../../core/connection.store';
import { RunStore } from '../../core/run.store';
import { TabStore, type EditorTab } from '../../core/tab.store';
import { MOD } from '../../core/ui';
import { Autofocus } from '../../shared/autofocus';
import { ClickOutside, clampMenu } from '../../shared/click-outside';
import { ScratchStore } from '../../core/scratch.store';

@Component({
  selector: 'dm-tab-bar',
  imports: [CdkDropList, CdkDrag, Autofocus, ClickOutside],
  template: `
    <div class="tabs" role="tablist" cdkDropList cdkDropListOrientation="horizontal" (cdkDropListDropped)="drop($event)">
      @for (t of tabs.tabs(); track t.id) {
        <div class="tab" role="tab" cdkDrag cdkDragLockAxis="x" [class.on]="t.id === tabs.activeId()"
             [attr.aria-selected]="t.id === tabs.activeId()" [style.--conn]="color(t)"
             (mousedown)="$event.button === 0 && tabs.activate(t.id)" (auxclick)="$event.button === 1 && cmds.closeTab(t.id)"
             (dblclick)="editing.set(t.id)" (contextmenu)="openMenu($event, t)" [title]="title(t)">
          @if (running(t)) { <span class="spin" aria-label="Running"></span> }
          @else if (t.kind === 'table') { <span class="tbl" aria-hidden="true">▦</span> }
          @if (editing() === t.id) {
            <input class="rename" [value]="t.name" (keydown.enter)="rename(t, $any($event.target).value)"
                   (keydown.escape)="editing.set('')" (blur)="rename(t, $any($event.target).value)" (mousedown)="$event.stopPropagation()" dmAutofocus />
          } @else {
            <span class="name">{{ t.name }}@if (t.kind === 'table') {<span class="where"> [{{ where(t) }}]</span>}</span>
          }
          <button class="close" [class.dirty]="t.dirty" (mousedown)="$event.stopPropagation()" (click)="cmds.closeTab(t.id)"
                  [attr.aria-label]="'Close ' + t.name" [title]="'Close (' + mod + 'W)'">
            <span class="x">×</span><span class="d" aria-hidden="true">●</span>
          </button>
        </div>
      }
    </div>
    @if (menu(); as m) {
      <div class="menu" [style.left.px]="m.x" [style.top.px]="m.y" (dmClickOutside)="menu.set(null)">
        <button class="menu-item" (click)="act('rename')">Rename</button>
        @if (m.t.kind === 'sql') {
          <button class="menu-item" (click)="act('save')">Save<span class="hint">{{ mod }}S</span></button>
          <button class="menu-item" (click)="act('export')">Save as file…</button>
          <button class="menu-item" (click)="act('duplicate')">Duplicate</button>
        }
        <div class="menu-sep"></div>
        <button class="menu-item" (click)="act('close')">Close<span class="hint">{{ mod }}W</span></button>
        <button class="menu-item" (click)="act('others')">Close other tabs</button>
        @if (m.t.kind === 'sql') {
          <div class="menu-sep"></div>
          <button class="menu-item danger" (click)="act('delete')">Delete scratch file…</button>
        }
      </div>
    }
    <button class="btn ghost icon sm add" (click)="cmds.newTab()" [title]="'New tab (' + mod + 'T)'" aria-label="New tab">＋</button>
  `,
  styles: `
    :host { display: flex; align-items: flex-end; height: 34px; background: var(--bg); border-bottom: 1px solid var(--border); padding-left: 6px; flex: none; min-width: 0; }
    .tabs { display: flex; align-items: flex-end; height: 100%; min-width: 0; overflow-x: auto; scrollbar-width: none; }
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
  readonly editing = signal('');
  readonly mod = MOD;

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

  act(action: string) {
    const m = this.menu();
    this.menu.set(null);
    if (!m) return;
    const id = m.t.id;
    switch (action) {
      case 'rename': return this.editing.set(id);
      case 'save': return void this.scratches.save(id);
      case 'export': return void this.scratches.exportFile(id);
      case 'duplicate': return void this.scratches.duplicate(id);
      case 'close': return this.cmds.closeTab(id);
      case 'others':
        for (const t of this.tabs.tabs()) if (t.id !== id) this.cmds.closeTab(t.id);
        return;
      case 'delete': return void this.scratches.remove(id);
    }
  }

  drop(e: CdkDragDrop<unknown>) {
    if (e.previousIndex !== e.currentIndex) this.tabs.move(e.previousIndex, e.currentIndex);
  }
}
