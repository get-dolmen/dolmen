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
  templateUrl: './topbar.html',
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
