import { Component, effect, inject, input, untracked } from '@angular/core';
import { AgGridAngular } from 'ag-grid-angular';
import {
  AllCommunityModule, ModuleRegistry, themeQuartz,
  type CellKeyDownEvent, type ColDef, type FullWidthCellKeyDownEvent, type GridApi, type GridReadyEvent,
} from 'ag-grid-community';
import { Commands } from '../../core/commands';
import { isMac } from '../../core/ui';
import type { Cell, QueryResult } from '../../core/models';
import { rowsToTSV } from './tsv';

ModuleRegistry.registerModules([AllCommunityModule]);

/** AG Grid themed from the app's CSS tokens, so light/dark follow automatically. */
export const gridTheme = themeQuartz.withParams({
  backgroundColor: 'var(--bg-panel)',
  foregroundColor: 'var(--text)',
  headerBackgroundColor: 'var(--bg)',
  headerTextColor: 'var(--text-muted)',
  borderColor: 'var(--border)',
  accentColor: 'var(--accent)',
  chromeBackgroundColor: 'var(--bg)',
  oddRowBackgroundColor: 'var(--bg-hover)',
  selectedRowBackgroundColor: 'var(--accent-soft)',
  rowHoverColor: 'var(--bg-hover)',
  fontFamily: 'var(--font-mono)',
  headerFontFamily: 'var(--font-ui)',
  headerFontWeight: 600,
  cellFontWeight: 400,
  fontSize: 12,
  rowHeight: 26,
  headerHeight: 30,
  spacing: 4,
  cellHorizontalPadding: 10,
  wrapperBorder: false,
  wrapperBorderRadius: 0,
  columnBorder: true,
});

const ROWNUM: ColDef = {
  colId: '__row',
  headerName: '',
  valueGetter: (p) => (p.node?.rowIndex ?? 0) + 1,
  width: 56,
  pinned: 'left',
  sortable: false,
  resizable: false,
  suppressMovable: true,
  cellClass: 'rownum',
};

/** A cell never shows more than this: long text would be laid out in full on every scroll. */
const MAX_SHOWN = 500;

/** Text shown in a grid cell. Copy, export and tooltips read the full value. */
export function display(v: Cell): string {
  if (v === null || v === undefined) return 'NULL';
  const s = typeof v === 'string' ? v : String(v);
  return s.length > MAX_SHOWN ? s.slice(0, MAX_SHOWN) + '…' : s;
}

/** Estimates a column width from the header and a sample of values. */
function widthFor(name: string, rows: Cell[][], i: number): number {
  let chars = name.length + 2;
  for (let r = 0; r < Math.min(rows.length, 60); r++) {
    const v = rows[r][i];
    chars = Math.max(chars, v === null ? 4 : String(v).length);
  }
  return Math.min(420, Math.max(70, chars * 7.4 + 24));
}

@Component({
  selector: 'dm-result-grid',
  imports: [AgGridAngular],
  templateUrl: './result-grid.html',
  styles: `
    :host { display: block; height: 100%; }
    .grid { height: 100%; width: 100%; }
    :host ::ng-deep .null { color: var(--null); font-style: italic; }
    :host ::ng-deep .num { text-align: right; font-variant-numeric: tabular-nums; }
    :host ::ng-deep .rownum { color: var(--text-faint); text-align: right; background: var(--bg); }
  `,
})
export class ResultGrid {
  private cmds = inject(Commands);
  public readonly result = input.required<QueryResult>();
  /** Shows long text in a tooltip on hover (off inline, where it covers the code). */
  public readonly tooltips = input(true);
  public readonly theme = gridTheme;

  public readonly defaultColDef: ColDef = {
    sortable: true,
    resizable: true,
    minWidth: 60,
    suppressHeaderMenuButton: true,
    valueFormatter: (p) => display(p.value),
    cellClass: (p) => (p.value === null ? 'null' : typeof p.value === 'number' ? 'num' : ''),
    tooltipValueGetter: (p) => (this.tooltips() && typeof p.value === 'string' && p.value.length > 60 ? p.value.slice(0, 2000) : undefined),
  };

  private api?: GridApi;
  private shownId = '';
  private shownRows = 0;

  public constructor() {
    effect(() => {
      const r = this.result();
      untracked(() => this.render(r));
    });
  }

  public onReady(e: GridReadyEvent) {
    this.api = e.api;
    this.shownId = '';
    this.render(this.result());
  }

  private render(r: QueryResult) {
    const api = this.api;
    if (!api) return;
    if (r.id === this.shownId) {
      // Same result with more rows (Fetch more): append without resetting scroll.
      if (r.rows.length > this.shownRows) {
        api.applyTransaction({ add: r.rows.slice(this.shownRows) });
        this.shownRows = r.rows.length;
      }
      return;
    }
    const cols: ColDef[] = r.columns.map((c, i) => ({
      colId: `c${i}`,
      headerName: c.name,
      headerTooltip: c.type ? `${c.name} · ${c.type}` : c.name,
      valueGetter: (p) => (p.data as Cell[] | undefined)?.[i] ?? null,
      width: widthFor(c.name, r.rows, i),
    }));
    api.setGridOption('columnDefs', [ROWNUM, ...cols]);
    api.setGridOption('rowData', r.rows);
    this.shownId = r.id;
    this.shownRows = r.rows.length;
  }

  /** ⌘C / Ctrl+C copies the selected rows as TSV, or else the focused cell. */
  public onKey(e: CellKeyDownEvent | FullWidthCellKeyDownEvent) {
    const ev = e.event as KeyboardEvent | undefined;
    if (!('column' in e) || !ev || ev.key.toLowerCase() !== 'c' || !(isMac ? ev.metaKey : ev.ctrlKey)) return;
    ev.preventDefault();
    const selected = this.api?.getSelectedRows() as Cell[][] | undefined;
    if (selected && selected.length > 1) {
      void this.cmds.copy(rowsToTSV(this.result().columns, selected, true));
    } else if (e.column.getColId() !== '__row') {
      const v = e.value as Cell;
      void this.cmds.copy(v === null ? '' : String(v));
    } else if (e.data) {
      void this.cmds.copy(rowsToTSV(this.result().columns, [e.data as Cell[]], false));
    }
  }

  public selectedRows(): Cell[][] {
    return (this.api?.getSelectedRows() as Cell[][]) ?? [];
  }
}
