import { Injectable, inject, signal } from '@angular/core';
import { Api, errorText } from './api';
import { TabStore } from './tab.store';
import { TableBridge } from './table-bridge';
import { Toasts } from './toast';
import type { TxMode, TxStatus } from './models';

const CLOSED: TxStatus = { open: false, statements: 0, startedAt: 0 };

/** Per-tab transaction state for manual mode, and Commit / Rollback. */
@Injectable({ providedIn: 'root' })
export class TxStore {
  private api = inject(Api);
  private tabs = inject(TabStore);
  private tables = inject(TableBridge);
  private toasts = inject(Toasts);

  readonly status = signal<Record<string, TxStatus>>({});

  get(tabId: string): TxStatus { return this.status()[tabId] ?? CLOSED; }

  set(tabId: string, st: TxStatus | undefined) {
    this.status.set({ ...this.status(), [tabId]: st ?? CLOSED });
  }

  forget(tabId: string) {
    const s = { ...this.status() };
    delete s[tabId];
    this.status.set(s);
  }

  /** Switching mode is refused while a transaction is open. */
  setMode(tabId: string, mode: TxMode): boolean {
    if (this.get(tabId).open) {
      this.toasts.error('Commit or roll back the open transaction first.');
      return false;
    }
    this.tabs.setTxMode(tabId, mode);
    return true;
  }

  /**
   * Before a tab leaves its session (connection or database switch): asks to
   * confirm when a transaction is open, since the backend rolls it back.
   */
  confirmLeave(tabId: string): boolean {
    const tx = this.get(tabId);
    if (!tx.open) return true;
    if (!confirm(`This tab has an open transaction (${tx.statements} statements). Switching rolls it back. Continue?`)) return false;
    this.forget(tabId);
    return true;
  }

  commit(tabId = this.tabs.activeId()) { return this.end(tabId, true); }
  rollback(tabId = this.tabs.activeId()) { return this.end(tabId, false); }

  private async end(tabId: string, commit: boolean) {
    const n = this.get(tabId).statements;
    try {
      this.set(tabId, await (commit ? this.api.commit(tabId) : this.api.rollback(tabId)));
      this.toasts.success(`${commit ? 'Committed' : 'Rolled back'} ${n} statement${n === 1 ? '' : 's'}.`);
      // A data tab shows rows through the transaction: reload it to show the outcome.
      if (!commit) this.tables.get(tabId)?.refresh();
    } catch (e) {
      this.toasts.error(errorText(e));
    }
  }
}
