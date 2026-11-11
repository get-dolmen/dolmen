import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Api, errorText } from '../../core/api';
import { Commands } from '../../core/commands';
import { ConnectionStore } from '../../core/connection.store';
import { EditorBridge } from '../../core/editor-bridge';
import { Toasts } from '../../core/toast';
import type { HistoryEntry } from '../../core/models';

@Component({
  selector: 'dm-history-panel',
  imports: [FormsModule, DatePipe],
  template: `
    <div class="bar">
      <input class="input sm" type="search" placeholder="Search history…" [ngModel]="search()" (ngModelChange)="search.set($event)" />
      <label class="scope"><input type="checkbox" [ngModel]="allConns()" (ngModelChange)="allConns.set($event)" /> All connections</label>
      <span class="spacer"></span>
      <button class="btn ghost sm" (click)="reload()">Refresh</button>
      <button class="btn ghost sm danger" (click)="clear()" [disabled]="!entries().length">Clear</button>
    </div>
    <div class="list">
      @for (e of entries(); track e.id) {
        <div class="entry" [class.err]="e.status !== 'ok'" (dblclick)="insert(e)" title="Double-click to insert into the editor">
          <div class="meta">
            <span class="status" [attr.data-s]="e.status"></span>
            <span>{{ e.startedAt | date: 'MMM d, HH:mm:ss' }}</span>
            @if (allConns()) { <span class="faint">· {{ connName(e.connId) }}</span> }
            <span class="faint">· {{ e.durationMs.toLocaleString() }} ms</span>
            @if (e.status === 'ok' && e.rows >= 0) { <span class="faint">· {{ e.rows.toLocaleString() }} rows</span> }
            <span class="spacer"></span>
            <button class="btn ghost sm" (click)="insert(e)">Insert</button>
            <button class="btn ghost sm" (click)="cmds.copy(e.sql)">Copy</button>
          </div>
          <pre class="sql">{{ e.sql }}</pre>
          @if (e.error) { <div class="error">{{ e.error }}</div> }
        </div>
      } @empty {
        <p class="empty muted">{{ loading() ? 'Loading…' : 'No history yet. Statements you run appear here.' }}</p>
      }
    </div>
  `,
  styles: `
    :host { display: flex; flex-direction: column; height: 100%; min-height: 0; }
    .bar { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-bottom: 1px solid var(--border); }
    .bar .input { max-width: 280px; height: 24px; }
    .scope { display: flex; align-items: center; gap: 4px; font-size: var(--fs-sm); color: var(--text-muted); }
    .list { flex: 1; overflow: auto; }
    .entry { padding: 6px 12px 8px; border-bottom: 1px solid var(--border); }
    .entry:hover { background: var(--bg-hover); }
    .entry:not(:hover) .btn { visibility: hidden; }
    .meta { display: flex; align-items: center; gap: 6px; font-size: var(--fs-xs); color: var(--text-muted); height: 22px; }
    .status { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); }
    .status[data-s='error'] { background: var(--danger); }
    .status[data-s='cancelled'] { background: var(--warn); }
    .sql { margin: 2px 0 0; font: 12px/1.45 var(--font-mono); white-space: pre-wrap; word-break: break-word; max-height: 7.3em; overflow: hidden; user-select: text; }
    .error { margin-top: 3px; font-size: var(--fs-xs); color: var(--danger); user-select: text; }
    .empty { padding: 24px; text-align: center; }
  `,
})
export class HistoryPanel {
  private api = inject(Api);
  private conns = inject(ConnectionStore);
  private editor = inject(EditorBridge);
  private toasts = inject(Toasts);
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
    if (!confirm(`Clear query history ${what}?`)) return;
    await this.api.clearHistory(scope);
    await this.reload();
  }
}
