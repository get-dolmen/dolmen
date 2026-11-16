import { Component, effect, inject, input, untracked } from '@angular/core';
import { AgGridAngular } from 'ag-grid-angular';
import {
  AllCommunityModule,
  ModuleRegistry,
  themeQuartz,
  type CellKeyDownEvent,
  type ColDef,
  type FullWidthCellKeyDownEvent,
  type GridApi,
  type GridReadyEvent,
} from 'ag-grid-community';
import { Commands } from '../../core/commands';
import { isMac } from '../../core/ui';
import type { Cell, QueryResult } from '../../core/models';
import { cellText, displayCell } from '../../shared/cell';
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

const ROW_NUMBER_COLUMN: ColDef = {
  colId: '__row',
  headerName: '',
  valueGetter: (params) => (params.node?.rowIndex ?? 0) + 1,
  width: 56,
  pinned: 'left',
  sortable: false,
  resizable: false,
  suppressMovable: true,
  cellClass: 'rownum',
};

/** Estimates a column width from the header and a sample of values. */
function estimateColumnWidth(name: string, rows: Cell[][], columnIndex: number): number {
  let characters = name.length + 2;
  for (let rowIndex = 0; rowIndex < Math.min(rows.length, 60); rowIndex++) {
    const value = rows[rowIndex][columnIndex];
    characters = Math.max(characters, value === null ? 4 : String(value).length);
  }
  return Math.min(420, Math.max(70, characters * 7.4 + 24));
}

@Component({
  selector: 'dm-result-grid',
  imports: [AgGridAngular],
  templateUrl: './result-grid.html',
  styles: `
    :host {
      display: block;
      height: 100%;
    }
    .grid {
      height: 100%;
      width: 100%;
    }
    :host ::ng-deep .null {
      color: var(--null);
      font-style: italic;
    }
    :host ::ng-deep .num {
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
    :host ::ng-deep .rownum {
      color: var(--text-faint);
      text-align: right;
      background: var(--bg);
    }
  `,
})
export class ResultGrid {
  private commandService = inject(Commands);
  public readonly result = input.required<QueryResult>();
  /** Shows long text in a tooltip on hover (off inline, where it covers the code). */
  public readonly tooltips = input(true);
  public readonly theme = gridTheme;

  public readonly defaultColumnDefinition: ColDef = {
    sortable: true,
    resizable: true,
    minWidth: 60,
    suppressHeaderMenuButton: true,
    valueFormatter: (params) => displayCell(params.value),
    cellClass: (params) =>
      params.value === null ? 'null' : typeof params.value === 'number' ? 'num' : '',
    tooltipValueGetter: (params) =>
      this.tooltips() && typeof params.value === 'string' && params.value.length > 60
        ? params.value.slice(0, 2000)
        : undefined,
  };

  private gridApi?: GridApi;
  private shownResultId = '';
  private shownRowCount = 0;

  public constructor() {
    effect(() => {
      const result = this.result();
      untracked(() => this.renderResult(result));
    });
  }

  public onGridReady(event: GridReadyEvent) {
    this.gridApi = event.api;
    this.shownResultId = '';
    this.renderResult(this.result());
  }

  private renderResult(result: QueryResult) {
    const gridApi = this.gridApi;
    if (!gridApi) return;
    if (result.id === this.shownResultId) {
      // Same result with more rows (Fetch more): append without resetting scroll.
      if (result.rows.length > this.shownRowCount) {
        gridApi.applyTransaction({ add: result.rows.slice(this.shownRowCount) });
        this.shownRowCount = result.rows.length;
      }
      return;
    }
    const columns: ColDef[] = result.columns.map((column, columnIndex) => ({
      colId: `c${columnIndex}`,
      headerName: column.name,
      headerTooltip: column.type ? `${column.name} · ${column.type}` : column.name,
      valueGetter: (params) => (params.data as Cell[] | undefined)?.[columnIndex] ?? null,
      width: estimateColumnWidth(column.name, result.rows, columnIndex),
    }));
    gridApi.setGridOption('columnDefs', [ROW_NUMBER_COLUMN, ...columns]);
    gridApi.setGridOption('rowData', result.rows);
    this.shownResultId = result.id;
    this.shownRowCount = result.rows.length;
  }

  /** ⌘C / Ctrl+C copies the selected rows as TSV, or else the focused cell. */
  public onCellKeyDown(event: CellKeyDownEvent | FullWidthCellKeyDownEvent) {
    const keyboardEvent = event.event as KeyboardEvent | undefined;
    if (!('column' in event) || !keyboardEvent) return;
    if (
      keyboardEvent.key.toLowerCase() !== 'c' ||
      !(isMac ? keyboardEvent.metaKey : keyboardEvent.ctrlKey)
    )
      return;
    keyboardEvent.preventDefault();
    const selectedRows = this.gridApi?.getSelectedRows() as Cell[][] | undefined;
    if (selectedRows && selectedRows.length > 1) {
      void this.commandService.copy(rowsToTSV(this.result().columns, selectedRows, true));
    } else if (event.column.getColId() !== '__row') {
      void this.commandService.copy(cellText(event.value as Cell));
    } else if (event.data) {
      void this.commandService.copy(
        rowsToTSV(this.result().columns, [event.data as Cell[]], false),
      );
    }
  }

  public selectedRows(): Cell[][] {
    return (this.gridApi?.getSelectedRows() as Cell[][]) ?? [];
  }
}
