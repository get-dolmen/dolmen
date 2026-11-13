import { Component, computed, inject, signal } from '@angular/core';
import { Commands } from '../../core/commands';
import { ConnectionStore } from '../../core/connection.store';
import { TxStore } from '../../core/tx.store';
import { TabStore } from '../../core/tab.store';
import { Ui, MOD, isMac } from '../../core/ui';
import { Toasts } from '../../core/toast';
import { ClickOutside, clampMenu } from '../../shared/click-outside';
import { Icon } from '../../shared/icon';
import { KIND_LABELS, type ConnectionView } from '../../core/models';
import { WindowToggleMaximise } from '../../../../wailsjs/runtime';

@Component({
  selector: 'dm-topbar',
  imports: [ClickOutside, Icon],
  host: { '[class.mac]': 'mac', '(dblclick)': 'onDblClick($event)' },
  template: `
    <div class="left">
    <button class="conn nodrag" (click)="openMenu($event)" title="Connection used by this tab">
      @if (conn(); as c) {
        <span class="dot" [style.background]="c.color" [class.off]="!c.connected"></span>
        <span class="ellipsis">{{ c.name }}</span>
        @if (database(); as db) { <span class="db ellipsis">/ {{ db }}</span> }
        @if (c.readOnly) { <span class="badge ro">🔒 RO</span> }
        @if (locked()) { <dm-icon name="lock" [size]="12" class="lock" /> }
      } @else {
        <span class="faint">No connection</span>
      }
      <span class="caret">▾</span>
    </button>
    </div>

    <button class="search nodrag" (click)="ui.openPalette()">
      <span class="glass" aria-hidden="true">⌕</span>
      <span class="ph">Search tables, tabs, commands…</span>
      <span class="kbd">{{ mod }}P</span>
    </button>

    <div class="actions nodrag">
      @if (ui.scratchPosition() === 'left') {
        <button class="btn ghost icon" (click)="ui.scratchOpen.set(!ui.scratchOpen())" [class.on]="ui.scratchOpen()"
                [title]="ui.scratchOpen() ? 'Hide the scratches panel' : 'Show the scratches panel'"
                [attr.aria-label]="ui.scratchOpen() ? 'Hide scratches' : 'Show scratches'">
          <dm-icon name="panelLeft" [size]="16" />
        </button>
      }
      <button class="btn ghost icon" (click)="ui.sidebarOpen.set(!ui.sidebarOpen())" [class.on]="ui.sidebarOpen()"
              [title]="'Toggle explorer (' + mod + 'B)'" aria-label="Toggle explorer">
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="none" stroke="currentColor"/><rect x="10" y="3" width="4" height="10" fill="currentColor" opacity=".5"/></svg>
      </button>
      <button class="btn ghost icon" (click)="cmds.openSettings()" [title]="'Settings (' + mod + ',)'" aria-label="Settings">
        <dm-icon name="settings" [size]="16" />
      </button>
    </div>

    @if (menu(); as m) {
      <div class="menu" [style.left.px]="m.x" [style.top.px]="m.y" (dmClickOutside)="menu.set(null)">
        <div class="menu-label">Use in this tab</div>
        @for (c of conns.connections(); track c.id) {
          <button class="menu-item" [class.active]="c.id === conn()?.id" (click)="choose(c)">
            <span class="dot" [style.background]="c.color" [style.opacity]="c.connected ? 1 : 0.35"></span>
            <span class="ellipsis">{{ c.name }}</span>
            @if (c.readOnly) { <span class="badge ro">RO</span> }
            <span class="hint">{{ kind(c) }}</span>
          </button>
        } @empty {
          <div class="menu-label">No saved connections</div>
        }
        <div class="menu-sep"></div>
        <button class="menu-item" (click)="menu.set(null); cmds.newConnection()">New connection…</button>
        @if (conn(); as c) {
          <button class="menu-item" (click)="menu.set(null); cmds.editConnection(c)">Edit “{{ c.name }}”…</button>
        }
      </div>
    }
  `,
  styles: `
    /* Three columns with equal sides keep the search bar centred in the window. */
    :host { display: grid; grid-template-columns: minmax(max-content, 1fr) minmax(180px, 440px) minmax(max-content, 1fr); align-items: center; gap: 12px; height: 44px; padding: 0 10px; background: var(--bg); border-bottom: 1px solid var(--border);
            --wails-draggable: drag; flex: none; }
    /* Room for the macOS traffic lights, inside the left column so the centre stays centred. */
    :host(.mac) { height: 52px; }
    :host(.mac) .left { padding-left: 80px; }
    .nodrag { --wails-draggable: no-drag; }
    .left { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .conn { display: flex; align-items: center; gap: 7px; height: 30px; max-width: 260px; padding: 0 10px; border: 1px solid var(--border-strong); border-radius: var(--radius);
            background: var(--bg-panel); cursor: pointer; font-weight: 500; border-color: var(--accent); }
    .conn:hover { background: var(--accent-soft); }
    .db { color: var(--text-muted); font-weight: 400; }
    .lock { color: var(--warn); flex: none; }
    .dot.off { opacity: 0.35; }
    .caret { color: var(--text-faint); font-size: 10px; margin-left: 2px; }
    .search { display: flex; align-items: center; gap: 8px; width: 100%; min-width: 0; height: 30px; padding: 0 6px 0 10px; border: 1px solid var(--border); border-radius: var(--radius);
              background: var(--bg-sunken); color: var(--text-faint); cursor: text; text-align: left; }
    .search:hover { border-color: var(--border-strong); }
    .glass { font-size: 15px; }
    .ph { flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    .actions { display: flex; align-items: center; gap: 6px; justify-self: end; }
    .btn.icon.on { color: var(--accent); }
    .menu .badge { margin-left: 2px; }
  `,
})
export class Topbar {
  readonly ui = inject(Ui);
  readonly cmds = inject(Commands);
  readonly conns = inject(ConnectionStore);
  private tabs = inject(TabStore);
  readonly tx = inject(TxStore);
  private toasts = inject(Toasts);
  readonly mod = MOD;
  readonly mac = isMac;

  readonly conn = computed(() => this.conns.get(this.tabs.active()?.connId));
  readonly database = computed(() => this.tabs.active()?.database ?? '');
  readonly locked = computed(() => !!this.tabs.active()?.locked);
  readonly menu = signal<{ x: number; y: number } | null>(null);

  /** macOS zooms the window on a title-bar double-click; Wails does not do it by itself. */
  onDblClick(e: MouseEvent) {
    if (!isMac) return;
    const target = e.target as HTMLElement;
    if (target.closest('.nodrag, button, input, textarea, select, a')) return;
    WindowToggleMaximise();
  }

  kind(c: ConnectionView) { return KIND_LABELS[c.kind]; }

  openMenu(e: MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    this.menu.set(clampMenu(r.left, r.bottom + 4, 260, 320));
  }

  async choose(c: ConnectionView) {
    this.menu.set(null);
    const t = this.tabs.active();
    if (t?.locked) {
      this.toasts.error(`${t.name} is locked to its connection and database. Unlock it first.`);
      return;
    }
    if (t && t.connId !== c.id && !(await this.tx.confirmLeave(t.id))) return;
    if (t) this.tabs.setConnection(t.id, c.id);
    void this.conns.ensureConnected(c.id);
  }
}
