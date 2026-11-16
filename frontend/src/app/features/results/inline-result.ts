import { Component, inject, input, output, signal, viewChild } from '@angular/core';
import { Commands } from '../../core/commands';
import { RunStore, type InlineBlock } from '../../core/run.store';
import { ClickOutside, clampMenu } from '../../shared/click-outside';
import { ResultGrid } from './result-grid';
import { COPY_FORMATS, formatRows, type CopyFormat } from './copy';
import type { QueryResult } from '../../core/models';

/** Header height, and the grid's header and row heights (see gridTheme). */
export const INLINE_HEADER_HEIGHT = 36;
const GRID_HEADER_HEIGHT = 30;
const GRID_ROW_HEIGHT = 26;
const GRID_SCROLLBAR_HEIGHT = 14;
const MAX_VISIBLE_ROWS = 10;
const ERROR_LINE_HEIGHT = 18;

/** Default height of an inline block, before the user resizes it. */
export function inlineHeight(result: QueryResult): number {
  if (result.error) {
    return (
      INLINE_HEADER_HEIGHT + 8 + Math.min(6, result.error.split('\n').length) * ERROR_LINE_HEIGHT
    );
  }
  if (!result.isQuery) return INLINE_HEADER_HEIGHT;
  const visibleRows = Math.max(1, Math.min(MAX_VISIBLE_ROWS, result.rows.length));
  return (
    INLINE_HEADER_HEIGHT +
    GRID_HEADER_HEIGHT +
    visibleRows * GRID_ROW_HEIGHT +
    GRID_SCROLLBAR_HEIGHT
  );
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
  private runStore = inject(RunStore);
  private commandService = inject(Commands);
  public readonly tabId = input.required<string>();
  public readonly block = input.required<InlineBlock>();
  /** From the tab's latest run: the backend still holds its rows for export. */
  public readonly live = input(false);
  public readonly closed = output<void>();
  public readonly resizeStart = output<PointerEvent>();
  public readonly resetHeight = output<void>();

  private resultGrid = viewChild(ResultGrid);
  public readonly fetching = signal(false);
  public readonly menu = signal<{ x: number; y: number; kind: 'copy' | 'export' } | null>(null);
  public readonly copyFormats = COPY_FORMATS;

  public summary(result: QueryResult): string {
    if (result.message) return result.message;
    const affected =
      result.rowsAffected >= 0
        ? `${result.rowsAffected.toLocaleString()} row${result.rowsAffected === 1 ? '' : 's'} affected`
        : 'Done';
    return `${affected} · ${result.durationMs.toLocaleString()} ms`;
  }

  public async fetchMore() {
    this.fetching.set(true);
    await this.runStore.fetchMore(this.tabId(), this.block().id);
    this.fetching.set(false);
  }

  public openMenu(event: MouseEvent, kind: 'copy' | 'export') {
    const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
    this.menu.set({
      ...clampMenu(bounds.right - 220, bounds.bottom + 4, 220, kind === 'copy' ? 330 : 80),
      kind,
    });
  }

  public copy(scope: 'all' | 'selected', format: CopyFormat) {
    this.menu.set(null);
    const result = this.block().result;
    const rows = scope === 'all' ? result.rows : (this.resultGrid()?.selectedRows() ?? []);
    void this.commandService.copy(formatRows(format, result.columns, rows, true));
  }

  public export(format: 'csv' | 'json') {
    this.menu.set(null);
    void this.runStore.export(this.tabId(), this.block().id, format);
  }
}
