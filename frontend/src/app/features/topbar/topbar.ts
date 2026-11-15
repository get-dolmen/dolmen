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
  host: { '[class.mac]': 'isMacPlatform', '(dblclick)': 'onDoubleClick($event)' },
  templateUrl: './topbar.html',
  styleUrl: './topbar.scss',
})
export class Topbar {
  public readonly uiState = inject(Ui);
  public readonly commandService = inject(Commands);
  public readonly connectionStore = inject(ConnectionStore);
  private tabStore = inject(TabStore);
  public readonly transactionStore = inject(TxStore);
  private toastService = inject(Toasts);
  public readonly modifierKey = MOD;
  public readonly isMacPlatform = isMac;

  public readonly connection = computed(() => this.connectionStore.get(this.tabStore.active()?.connId));
  public readonly database = computed(() => this.tabStore.active()?.database ?? '');
  public readonly locked = computed(() => !!this.tabStore.active()?.locked);
  public readonly menu = signal<MenuPos | null>(null);
  public readonly menuOpen = computed(() => this.menu() !== null);

  /** macOS zooms the window on a title-bar double-click; Wails does not do it by itself. */
  public onDoubleClick(event: MouseEvent) {
    if (!isMac) return;
    const target = event.target as HTMLElement;
    if (target.closest('.nodrag, button, input, textarea, select, a')) return;
    WindowToggleMaximise();
  }

  public kindLabel(connection: ConnectionView) { return KIND_LABELS[connection.kind]; }

  public toggleMenu(event: MouseEvent) {
    const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
    this.menu.set(toggleMenuAt(this.menu(), bounds, MENU_WIDTH, MENU_HEIGHT));
  }

  public async choose(connection: ConnectionView) {
    this.menu.set(null);
    const tab = this.tabStore.active();
    if (tab?.locked) {
      this.toastService.error(`${tab.name} is locked to its connection and database. Unlock it first.`);
      return;
    }
    if (tab && tab.connId !== connection.id && !(await this.transactionStore.confirmLeave(tab.id))) return;
    if (tab) this.tabStore.setConnection(tab.id, connection.id);
    void this.connectionStore.ensureConnected(connection.id);
  }
}
