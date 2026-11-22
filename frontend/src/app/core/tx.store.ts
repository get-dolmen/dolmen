import { Injectable, inject, signal } from '@angular/core';
import { Events } from '@wailsio/runtime';
import { Api, errorText } from './api';
import { TabStore } from './tab.store';
import { TableBridge } from './table-bridge';
import { Toasts } from './toast';
import { Confirm } from '../shared/confirm';
import type { TxExpiredEvent, TxMode, TxStatus } from './models';

const CLOSED: TxStatus = { open: false, statements: 0, startedAt: 0 };

/** Per-tab transaction state for manual mode, and Commit / Rollback. */
@Injectable({ providedIn: 'root' })
export class TxStore {
  private api = inject(Api);
  private tabStore = inject(TabStore);
  private tables = inject(TableBridge);
  private toastService = inject(Toasts);
  private confirmDialog = inject(Confirm);

  public readonly status = signal<Record<string, TxStatus>>({});

  public constructor() {
    // The backend rolls back transactions left idle: reflect it and explain why.
    Events.On('tx:expired', ({ data: event }: { data: TxExpiredEvent }) => {
      this.set(event.tabId, undefined);
      this.tables.get(event.tabId)?.refresh();
      const minutes = Math.round(event.timeoutMs / 60_000);
      const statements = `${event.statements} statement${event.statements === 1 ? '' : 's'}`;
      this.toastService.error(
        `Transaction rolled back after ${minutes} minutes of inactivity (${statements}).`,
      );
    });
  }

  public get(tabId: string): TxStatus {
    return this.status()[tabId] ?? CLOSED;
  }

  public set(tabId: string, transactionStatus: TxStatus | undefined) {
    this.status.set({ ...this.status(), [tabId]: transactionStatus ?? CLOSED });
  }

  public forget(tabId: string) {
    const statusByTab = { ...this.status() };
    delete statusByTab[tabId];
    this.status.set(statusByTab);
  }

  /** Switching mode is refused while a transaction is open. */
  public setMode(tabId: string, mode: TxMode): boolean {
    if (this.get(tabId).open) {
      this.toastService.error('Commit or roll back the open transaction first.');
      return false;
    }
    this.tabStore.setTxMode(tabId, mode);
    return true;
  }

  /**
   * Before a tab leaves its session (connection or database switch): asks to
   * confirm when a transaction is open, since the backend rolls it back.
   */
  public async confirmLeave(tabId: string): Promise<boolean> {
    const transaction = this.get(tabId);
    if (!transaction.open) return true;
    if (
      !(await this.confirmDialog.ask(
        `This tab has an open transaction (${transaction.statements} statements). Switching rolls it back.`,
        { title: 'Leave transaction', confirmLabel: 'Roll back and switch', danger: true },
      ))
    )
      return false;
    this.forget(tabId);
    return true;
  }

  public commit(tabId = this.tabStore.activeId()) {
    return this.end(tabId, true);
  }
  public rollback(tabId = this.tabStore.activeId()) {
    return this.end(tabId, false);
  }

  private async end(tabId: string, commit: boolean) {
    const statementCount = this.get(tabId).statements;
    try {
      this.set(tabId, await (commit ? this.api.commit(tabId) : this.api.rollback(tabId)));
      this.toastService.success(
        `${commit ? 'Committed' : 'Rolled back'} ${statementCount} statement${statementCount === 1 ? '' : 's'}.`,
      );
      // A data tab shows rows through the transaction: reload it to show the outcome.
      if (!commit) this.tables.get(tabId)?.refresh();
    } catch (error) {
      this.toastService.error(errorText(error));
    }
  }
}
