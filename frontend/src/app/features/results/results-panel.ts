import { Component, computed, inject, input, signal, viewChild } from '@angular/core';
import { DatePipe } from '@angular/common';
import { Commands } from '../../core/commands';
import { RunStore, type ResultsPanel as PanelKind } from '../../core/run.store';
import { ClickOutside, clampMenu } from '../../shared/click-outside';
import { HistoryPanel } from '../history/history-panel';
import { ResultGrid } from './result-grid';
import { COPY_FORMATS, formatRows, type CopyFormat } from './copy';
import { MOD } from '../../core/ui';
import type { QueryResult } from '../../core/models';

@Component({
  selector: 'dm-results-panel',
  imports: [ResultGrid, HistoryPanel, DatePipe, ClickOutside],
  template: `
    <div class="head">
      <div class="tabs" role="tablist">
        @for (r of run().results; track r.id; let i = $index) {
          <button role="tab" class="tab" [class.on]="run().panel === 'results' && run().activeResult === i"
                  [attr.aria-selected]="run().panel === 'results' && run().activeResult === i"
                  [title]="r.statement" (click)="runs.setActiveResult(tabId(), i)">
            {{ label(r, i) }}
          </button>
        }
        @if (!run().results.length) {
          <button role="tab" class="tab" [class.on]="run().panel === 'results'" (click)="setPanel('results')">Results</button>
        }
        <button role="tab" class="tab" [class.on]="run().panel === 'messages'" (click)="setPanel('messages')">
          Messages
          @if (errorCount()) { <span class="count err">{{ errorCount() }}</span> }
        </button>
        <button role="tab" class="tab" [class.on]="run().panel === 'history'" (click)="setPanel('history')">History</button>
      </div>
      <span class="spacer"></span>
      @if (run().panel === 'results' && current(); as r) {
        <span class="info">
          {{ r.rows.length.toLocaleString() }}{{ r.hasMore ? '+' : '' }} rows · {{ r.durationMs.toLocaleString() }} ms
        </span>
        @if (r.canFetchMore) {
          <button class="btn sm" (click)="fetchMore(r)" [disabled]="fetching()">{{ fetching() ? 'Fetching…' : 'Fetch more' }}</button>
        }
        <button class="btn sm" (click)="openMenu($event, 'copy')">Copy ▾</button>
        <button class="btn sm" (click)="openMenu($event, 'export')">Export ▾</button>
      }
    </div>

    <div class="body">
      @switch (run().panel) {
        @case ('results') {
          @if (current(); as r) {
            <dm-result-grid [result]="r" />
          } @else if (!run().running) {
            <div class="empty">
              <p>Run a query to see results here.</p>
              <p class="faint"><span class="kbd">{{ mod }}↵</span> runs the statement at the cursor &nbsp;·&nbsp; <span class="kbd">{{ mod }}⇧↵</span> runs the whole script</p>
            </div>
          }
        }
        @case ('messages') {
          <div class="messages">
            @for (m of run().messages; track $index) {
              <div class="msg" [attr.data-kind]="m.kind">
                <span class="time faint">{{ m.time | date: 'HH:mm:ss' }}</span>
                <div class="txt">
                  <div>{{ m.text }}</div>
                  @if (m.statement) { <pre>{{ m.statement }}</pre> }
                </div>
              </div>
            } @empty {
              <div class="empty"><p class="muted">No messages.</p></div>
            }
          </div>
        }
        @case ('history') {
          <dm-history-panel [connId]="connId()" [version]="run().messages.length" />
        }
      }
      @if (run().running) {
        <div class="running">
          <span class="spinner" aria-hidden="true"></span>
          <span>Running…</span>
          <button class="btn sm" (click)="runs.cancel(tabId())">Cancel <span class="kbd">Esc</span></button>
        </div>
      }
    </div>

    @if (menu(); as m) {
      <div class="menu" [style.left.px]="m.x" [style.top.px]="m.y" (dmClickOutside)="menu.set(null)">
        @if (m.kind === 'copy') {
          <div class="menu-label">Copy all rows</div>
          @for (f of formats; track f.id) {
            <button class="menu-item" (click)="copy('all', f.id)">{{ f.label }}<span class="hint">{{ hint(f.id) }}</span></button>
          }
          <div class="menu-sep"></div>
          <div class="menu-label">Copy selected rows</div>
          @for (f of formats; track f.id) {
            <button class="menu-item" (click)="copy('selected', f.id)">{{ f.label }}</button>
          }
          <div class="menu-sep"></div>
          <button class="menu-item" (click)="copyColumns()">Copy column names<span class="hint">{{ mod }}C</span></button>
        } @else {
          <button class="menu-item" (click)="export('csv')">Export as CSV…</button>
          <button class="menu-item" (click)="export('json')">Export as JSON…</button>
          @if (current()?.hasMore) {
            <div class="menu-sep"></div>
            <div class="menu-label">Exports fetch all remaining rows</div>
          }
        }
      </div>
    }
  `,
  styles: `
    :host { display: flex; flex-direction: column; min-height: 0; background: var(--bg-panel); }
    .head { display: flex; align-items: center; gap: 6px; height: 34px; padding: 0 8px 0 4px; border-bottom: 1px solid var(--border); background: var(--bg); flex: none; }
    .tabs { display: flex; height: 100%; overflow-x: auto; scrollbar-width: none; }
    .tab { display: flex; align-items: center; gap: 6px; height: 100%; padding: 0 10px; border: 0; background: none; color: var(--text-muted); cursor: pointer; white-space: nowrap; border-bottom: 2px solid transparent; font-size: var(--fs-sm); font-weight: 500; }
    .tab:hover { color: var(--text); }
    .tab.on { color: var(--text); border-bottom-color: var(--accent); }
    .count { min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px; font-size: 10px; line-height: 16px; text-align: center; background: var(--bg-active); }
    .count.err { background: var(--danger); color: white; }
    .info { font-size: var(--fs-xs); color: var(--text-muted); margin-right: 4px; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .body { flex: 1; position: relative; min-height: 0; }
    .empty { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; gap: 2px; color: var(--text-muted); text-align: center; padding: 16px; }
    .empty p { margin: 2px; }
    .messages { height: 100%; overflow: auto; padding: 4px 0; user-select: text; }
    .msg { display: flex; gap: 10px; padding: 5px 12px; border-left: 3px solid transparent; font-size: var(--fs-sm); }
    .msg[data-kind='error'] { border-left-color: var(--danger); background: var(--danger-soft); }
    .msg[data-kind='error'] .txt > div { color: var(--danger); }
    .msg[data-kind='ok'] { border-left-color: var(--accent); }
    .time { font-family: var(--font-mono); font-size: var(--fs-xs); padding-top: 1px; }
    .txt { min-width: 0; flex: 1; }
    .txt pre { margin: 3px 0 0; font: 11.5px/1.45 var(--font-mono); color: var(--text-muted); white-space: pre-wrap; word-break: break-word; max-height: 5.8em; overflow: hidden; }
    .running { position: absolute; left: 50%; top: 18px; transform: translateX(-50%); display: flex; align-items: center; gap: 10px; padding: 6px 8px 6px 12px; background: var(--bg-raised); border: 1px solid var(--border); border-radius: 20px; box-shadow: var(--shadow); font-size: var(--fs-sm); z-index: 5; }
    .running .kbd { margin-left: 4px; }
    .spinner { width: 14px; height: 14px; border: 2px solid var(--accent-soft); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
  `,
})
export class ResultsPanelComponent {
  readonly runs = inject(RunStore);
  private cmds = inject(Commands);
  readonly tabId = input.required<string>();
  readonly connId = input<string>('');
  readonly mod = MOD;

  private grid = viewChild(ResultGrid);
  readonly run = computed(() => this.runs.runs()[this.tabId()] ?? this.runs.get(this.tabId()));
  readonly current = computed(() => this.run().results[this.run().activeResult]);
  readonly errorCount = computed(() => this.run().messages.filter((m) => m.kind === 'error').length);
  readonly fetching = signal(false);
  readonly menu = signal<{ x: number; y: number; kind: 'copy' | 'export' } | null>(null);
  readonly formats = COPY_FORMATS;

  setPanel(p: PanelKind) { this.runs.setPanel(this.tabId(), p); }

  label(r: QueryResult, i: number) {
    const m = /\bfrom\s+([\w$#."`]+)/i.exec(r.statement);
    const name = m ? m[1].replace(/["`]/g, '').split('.').pop() : '';
    return name ? `${i + 1} · ${name}` : `Result ${i + 1}`;
  }

  async fetchMore(r: QueryResult) {
    this.fetching.set(true);
    await this.runs.fetchMore(this.tabId(), r.id);
    this.fetching.set(false);
  }

  openMenu(e: MouseEvent, kind: 'copy' | 'export') {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    this.menu.set({ ...clampMenu(rect.right - 220, rect.bottom + 4, 220, kind === 'copy' ? 380 : 120), kind });
  }

  hint(format: CopyFormat): string {
    return { tsv: 'spreadsheet', csv: 'Excel', json: 'API', markdown: 'docs' }[format];
  }

  copy(what: 'all' | 'selected', format: CopyFormat) {
    this.menu.set(null);
    const r = this.current();
    if (!r) return;
    const rows = what === 'all' ? r.rows : this.grid()?.selectedRows() ?? [];
    void this.cmds.copy(formatRows(format, r.columns, rows, true));
  }

  copyColumns() {
    this.menu.set(null);
    const r = this.current();
    if (r) void this.cmds.copy(r.columns.map((c) => c.name).join(', '));
  }

  export(format: 'csv' | 'json') {
    this.menu.set(null);
    const r = this.current();
    if (r) void this.runs.export(this.tabId(), r.id, format);
  }
}
