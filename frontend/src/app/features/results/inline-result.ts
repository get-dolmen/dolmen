import { Component, inject, input, output, signal, viewChild } from '@angular/core';
import { Commands } from '../../core/commands';
import { RunStore, type InlineBlock } from '../../core/run.store';
import { ClickOutside, clampMenu } from '../../shared/click-outside';
import { ResultGrid } from './result-grid';
import { COPY_FORMATS, formatRows, type CopyFormat } from './copy';
import type { QueryResult } from '../../core/models';

/** Header height, and the grid's header and row heights (see gridTheme). */
export const INLINE_HEAD = 28;
const GRID_HEAD = 30;
const GRID_ROW = 26;
const GRID_SCROLLBAR = 14;
const MAX_ROWS = 10;
const ERROR_LINE = 18;

/** Default height of an inline block, before the user resizes it. */
export function inlineHeight(r: QueryResult): number {
  if (r.error) return INLINE_HEAD + 8 + Math.min(6, r.error.split('\n').length) * ERROR_LINE;
  if (!r.isQuery) return INLINE_HEAD;
  return INLINE_HEAD + GRID_HEAD + Math.max(1, Math.min(MAX_ROWS, r.rows.length)) * GRID_ROW + GRID_SCROLLBAR;
}

/** One result shown in the editor under its statement. */
@Component({
  selector: 'dm-inline-result',
  imports: [ResultGrid, ClickOutside],
  template: `
    @let r = block().result;
    <div class="head" [class.err]="!!r.error">
      @if (r.error) {
        <span class="badge">Error</span>
      } @else if (r.isQuery) {
        <span class="info">{{ r.rows.length.toLocaleString() }}{{ r.hasMore ? '+' : '' }} row{{ r.rows.length === 1 && !r.hasMore ? '' : 's' }} · {{ r.durationMs.toLocaleString() }} ms</span>
      } @else {
        <span class="info">{{ summary(r) }}</span>
      }
      <span class="spacer"></span>
      @if (r.isQuery && !r.error) {
        @if (r.canFetchMore) {
          <button class="btn sm" (click)="fetchMore()" [disabled]="fetching()">{{ fetching() ? 'Fetching…' : 'Fetch more' }}</button>
        }
        <button class="btn sm" (click)="openMenu($event, 'copy')">Copy ▾</button>
        @if (live()) {
          <button class="btn sm" (click)="openMenu($event, 'export')">Export ▾</button>
        }
      }
      <button class="close" title="Close" aria-label="Close result" (click)="closed.emit()">×</button>
    </div>
    @if (r.error) {
      <pre class="error">{{ r.error }}</pre>
    } @else if (r.isQuery) {
      <dm-result-grid class="grid" [result]="r" />
    }
    <div class="grip" title="Drag to resize" (pointerdown)="resizeStart.emit($event)" (dblclick)="resetHeight.emit()"></div>

    @if (menu(); as m) {
      <div class="menu" [style.left.px]="m.x" [style.top.px]="m.y" (dmClickOutside)="menu.set(null)">
        @if (m.kind === 'copy') {
          <div class="menu-label">Copy all rows</div>
          @for (f of formats; track f.id) {
            <button class="menu-item" (click)="copy('all', f.id)">{{ f.label }}</button>
          }
          <div class="menu-sep"></div>
          <div class="menu-label">Copy selected rows</div>
          @for (f of formats; track f.id) {
            <button class="menu-item" (click)="copy('selected', f.id)">{{ f.label }}</button>
          }
        } @else {
          <button class="menu-item" (click)="export('csv')">Export as CSV…</button>
          <button class="menu-item" (click)="export('json')">Export as JSON…</button>
        }
      </div>
    }
  `,
  styles: `
    :host {
      display: flex; flex-direction: column; height: 100%; box-sizing: border-box;
      font-family: var(--font-ui); font-size: var(--fs-sm); color: var(--text);
      background: var(--bg-panel); border: 1px solid var(--border); border-left: 3px solid var(--accent);
      border-radius: var(--radius-sm); overflow: hidden; position: relative;
      /* Its size is set from outside: keep the grid's layout and style work
         separate from the editor's, which re-renders on every keystroke. */
      contain: strict;
    }
    :host(.has-error) { border-left-color: var(--danger); }
    .head { display: flex; align-items: center; gap: 6px; height: ${INLINE_HEAD - 2}px; padding: 0 4px 0 10px; flex: none; background: var(--bg); }
    .info { color: var(--text-muted); font-size: var(--fs-xs); white-space: nowrap; font-variant-numeric: tabular-nums; }
    .badge { color: var(--danger); font-size: var(--fs-xs); font-weight: 600; }
    .spacer { flex: 1; }
    .close { width: 22px; height: 22px; border: 0; border-radius: var(--radius-sm); background: none; color: var(--text-muted); cursor: pointer; font-size: 16px; line-height: 1; }
    .close:hover { background: var(--bg-hover); color: var(--text); }
    .grid { flex: 1; min-height: 0; border-top: 1px solid var(--border); }
    .error { flex: 1; margin: 0; padding: 4px 10px; overflow: auto; color: var(--danger); background: var(--danger-soft); font: 12px/${ERROR_LINE}px var(--font-mono); white-space: pre-wrap; word-break: break-word; user-select: text; }
    .grip { position: absolute; left: 0; right: 0; bottom: 0; height: 5px; cursor: row-resize; z-index: 3; }
    .grip:hover { background: var(--accent-soft); }
  `,
  host: { '[class.has-error]': '!!block().result.error' },
})
export class InlineResult {
  private runs = inject(RunStore);
  private cmds = inject(Commands);
  readonly tabId = input.required<string>();
  readonly block = input.required<InlineBlock>();
  /** From the tab's latest run: the backend still holds its rows for export. */
  readonly live = input(false);
  readonly closed = output<void>();
  readonly resizeStart = output<PointerEvent>();
  readonly resetHeight = output<void>();

  private grid = viewChild(ResultGrid);
  readonly fetching = signal(false);
  readonly menu = signal<{ x: number; y: number; kind: 'copy' | 'export' } | null>(null);
  readonly formats = COPY_FORMATS;

  summary(r: QueryResult): string {
    if (r.message) return r.message;
    const affected = r.rowsAffected >= 0 ? `${r.rowsAffected.toLocaleString()} row${r.rowsAffected === 1 ? '' : 's'} affected` : 'Done';
    return `${affected} · ${r.durationMs.toLocaleString()} ms`;
  }

  async fetchMore() {
    this.fetching.set(true);
    await this.runs.fetchMore(this.tabId(), this.block().id);
    this.fetching.set(false);
  }

  openMenu(e: MouseEvent, kind: 'copy' | 'export') {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    this.menu.set({ ...clampMenu(rect.right - 220, rect.bottom + 4, 220, kind === 'copy' ? 330 : 80), kind });
  }

  copy(what: 'all' | 'selected', format: CopyFormat) {
    this.menu.set(null);
    const r = this.block().result;
    const rows = what === 'all' ? r.rows : this.grid()?.selectedRows() ?? [];
    void this.cmds.copy(formatRows(format, r.columns, rows, true));
  }

  export(format: 'csv' | 'json') {
    this.menu.set(null);
    void this.runs.export(this.tabId(), this.block().id, format);
  }
}
