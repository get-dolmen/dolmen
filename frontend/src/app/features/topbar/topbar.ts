import { Component, computed, inject, signal } from '@angular/core';
import { Commands } from '../../core/commands';
import { ConnectionStore } from '../../core/connection.store';
import { TxStore } from '../../core/tx.store';
import { TabStore } from '../../core/tab.store';
import { Ui, MOD, isMac } from '../../core/ui';
import { Toasts } from '../../core/toast';
import { ClickOutside, toggleMenuAt, type MenuPos } from '../../shared/click-outside';
import { Icon } from '../../shared/icon';
import { KIND_LABELS, type ConnectionView } from '../../core/models';
import { WindowToggleMaximise } from '../../../../wailsjs/runtime';

/** Room kept for the connection menu when it is placed under its button. */
const MENU_WIDTH = 260;
const MENU_HEIGHT = 320;

@Component({
  selector: 'dm-topbar',
  imports: [ClickOutside, Icon],
  host: { '[class.mac]': 'mac', '(dblclick)': 'onDblClick($event)' },
  templateUrl: './topbar.html',
  styleUrl: './topbar.scss',
})
export class Topbar {
  public readonly ui = inject(Ui);
  public readonly cmds = inject(Commands);
  public readonly conns = inject(ConnectionStore);
  private tabs = inject(TabStore);
  public readonly tx = inject(TxStore);
  private toasts = inject(Toasts);
  public readonly mod = MOD;
  public readonly mac = isMac;

  public readonly conn = computed(() => this.conns.get(this.tabs.active()?.connId));
  public readonly database = computed(() => this.tabs.active()?.database ?? '');
  public readonly locked = computed(() => !!this.tabs.active()?.locked);
  public readonly menu = signal<MenuPos | null>(null);
  public readonly menuOpen = computed(() => this.menu() !== null);

  /** macOS zooms the window on a title-bar double-click; Wails does not do it by itself. */
  public onDblClick(e: MouseEvent) {
    if (!isMac) return;
    const target = e.target as HTMLElement;
    if (target.closest('.nodrag, button, input, textarea, select, a')) return;
    WindowToggleMaximise();
  }

  public kind(c: ConnectionView) { return KIND_LABELS[c.kind]; }

  public toggleMenu(e: MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    this.menu.set(toggleMenuAt(this.menu(), r, MENU_WIDTH, MENU_HEIGHT));
  }

  public async choose(c: ConnectionView) {
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
