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
  private conns = inject(ConnectionStore);
  private editor = inject(EditorBridge);
  private toasts = inject(Toasts);
  private confirm = inject(Confirm);
  readonly cmds = inject(Commands);

  readonly connId = input<string>('');
  /** Bumped by the parent after each run so the list refreshes. */
  readonly version = input(0);

  readonly search = signal('');
  readonly allConns = signal(false);
  readonly entries = signal<HistoryEntry[]>([]);
  readonly loading = signal(false);
  private scope = computed(() => (this.allConns() ? '' : this.connId()));
  private timer?: ReturnType<typeof setTimeout>;

  constructor() {
    effect(() => {
      this.scope();
      this.search();
      this.version();
      untracked(() => {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.reload(), 150);
      });
    });
  }

  async reload() {
    this.loading.set(true);
    try {
      this.entries.set(await this.api.listHistory(this.scope(), this.search(), 300));
    } catch (e) {
      this.toasts.error(errorText(e));
    } finally {
      this.loading.set(false);
    }
  }

  connName(id: string) { return this.conns.get(id)?.name ?? 'deleted connection'; }

  insert(e: HistoryEntry) {
    this.editor.insert(e.sql);
    this.editor.focus();
  }

  async clear() {
    const scope = this.scope();
    const what = scope ? `for “${this.connName(scope)}”` : 'for all connections';
    if (!(await this.confirm.ask(`Clear query history ${what}?`,
      { title: 'Clear history', confirmLabel: 'Clear', danger: true }))) return;
    await this.api.clearHistory(scope);
    await this.reload();
  }
}
