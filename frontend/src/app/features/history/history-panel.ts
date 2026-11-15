import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Api, errorText } from '../../core/api';
import { Commands } from '../../core/commands';
import { ConnectionStore } from '../../core/connection.store';
import { EditorBridge } from '../../core/editor-bridge';
import { Toasts } from '../../core/toast';
import { Confirm } from '../../shared/confirm';
import type { HistoryEntry } from '../../core/models';

@Component({
  selector: 'dm-history-panel',
  imports: [FormsModule, DatePipe],
  templateUrl: './history-panel.html',
  styleUrl: './history-panel.scss',
})
export class HistoryPanel {
  private api = inject(Api);
  private connectionStore = inject(ConnectionStore);
  private editorBridge = inject(EditorBridge);
  private toastService = inject(Toasts);
  private confirmDialog = inject(Confirm);
  public readonly commandService = inject(Commands);

  public readonly connId = input<string>('');
  /** Bumped by the parent after each run so the list refreshes. */
  public readonly version = input(0);

  public readonly search = signal('');
  public readonly allConnections = signal(false);
  public readonly entries = signal<HistoryEntry[]>([]);
  public readonly loading = signal(false);
  private readonly scope = computed(() => (this.allConnections() ? '' : this.connId()));
  private reloadTimer?: ReturnType<typeof setTimeout>;

  public constructor() {
    effect(() => {
      this.scope();
      this.search();
      this.version();
      untracked(() => {
        clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => this.reload(), 150);
      });
    });
  }

  public async reload() {
    this.loading.set(true);
    try {
      this.entries.set(await this.api.listHistory(this.scope(), this.search(), 300));
    } catch (error) {
      this.toastService.error(errorText(error));
    } finally {
      this.loading.set(false);
    }
  }

  public connectionName(connectionId: string) { return this.connectionStore.get(connectionId)?.name ?? 'deleted connection'; }

  public insert(entry: HistoryEntry) {
    this.editorBridge.insert(entry.sql);
    this.editorBridge.focus();
  }

  public async clear() {
    const scope = this.scope();
    const target = scope ? `for “${this.connectionName(scope)}”` : 'for all connections';
    if (!(await this.confirmDialog.ask(`Clear query history ${target}?`,
      { title: 'Clear history', confirmLabel: 'Clear', danger: true }))) return;
    await this.api.clearHistory(scope);
    await this.reload();
  }
}
