import { Component, inject, input, output, signal, viewChild } from '@angular/core';
import { Commands } from '../../core/commands';
import { RunStore, type InlineBlock } from '../../core/run.store';
import { ClickOutside, clampMenu } from '../../shared/click-outside';
import { ResultGrid } from './result-grid';
import { COPY_FORMATS, formatRows, type CopyFormat } from './copy';
import type { QueryResult } from '../../core/models';

/** Header height, and the grid's header and row heights (see gridTheme). */
export const INLINE_HEAD = 36;
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
  templateUrl: './inline-result.html',
  styleUrl: './inline-result.scss',
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
