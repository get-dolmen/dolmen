import {
  Component,
  ElementRef,
  OnDestroy,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AgGridAngular } from 'ag-grid-angular';
import type {
  CellClassParams,
  CellContextMenuEvent,
  CellKeyDownEvent,
  ColDef,
  FullWidthCellKeyDownEvent,
  GridApi,
  GridReadyEvent,
  ValueSetterParams,
} from 'ag-grid-community';
import { Api, errorText } from '../../core/api';
import { Commands } from '../../core/commands';
import { ConnectionStore } from '../../core/connection.store';
import { TabStore, type EditorTab } from '../../core/tab.store';
import { TableBridge, type TableHandle } from '../../core/table-bridge';
import { Toasts } from '../../core/toast';
import { TxStore } from '../../core/tx.store';
import { MOD, isMac } from '../../core/ui';
import { quoteIdentifier, qualified } from '../../core/sql';
import type { Cell, DbKind, TablePage } from '../../core/models';
import { Confirm } from '../../shared/confirm';
import { Icon } from '../../shared/icon';
import { ClickOutside, clampMenu } from '../../shared/click-outside';
import { displayCell } from '../../shared/cell';
import { gridTheme } from '../results/result-grid';
import { COPY_FORMATS, formatRows, type CopyFormat } from '../results/copy';
import { CellRangeSelection, rangeClassRules } from '../../shared/cell-range';
import {
  buildChanges,
  isChanged,
  normalizeEdit,
  previewSQL,
  rowChanged,
  type GridRow,
} from './changes';
import { ColumnHeader, type ColumnHeaderParams } from './column-header';

const PAGE_SIZES = [100, 500, 1000];
const REFRESH_SECONDS = [5, 10, 30, 60];

/** Editable view of one table: paging, filter, sort, and pending edits applied in one transaction. */
@Component({
  selector: 'dm-table-data',
  imports: [FormsModule, AgGridAngular, Icon, ClickOutside],
  templateUrl: './table-data.html',
  styleUrl: './table-data.scss',
})
export class TableData implements TableHandle, OnDestroy {
  private api = inject(Api);
  private commandService = inject(Commands);
  private connectionStore = inject(ConnectionStore);
  private tabStore = inject(TabStore);
  private tableBridge = inject(TableBridge);
  private toastService = inject(Toasts);
  private transactionStore = inject(TxStore);
  private confirmDialog = inject(Confirm);
  private whereInput = viewChild<ElementRef<HTMLInputElement>>('whereInput');
  private searchInput = viewChild<ElementRef<HTMLInputElement>>('search');

  public readonly tab = input.required<EditorTab>();
  public readonly theme = gridTheme;
  public readonly modifierKey = MOD;
  public readonly pageSizes = PAGE_SIZES;
  public readonly refreshChoices = REFRESH_SECONDS;

  public where = '';
  public orderBy = '';
  public readonly page = signal<TablePage | null>(null);
  public readonly offset = signal(0);
  public readonly limit = signal(100);
  public readonly loading = signal(false);
  public readonly applying = signal(false);
  public readonly error = signal('');
  public readonly previewOpen = signal(false);
  public readonly searchOpen = signal(false);
  public readonly quickFilter = signal('');
  public readonly copyMenu = signal<{ x: number; y: number } | null>(null);
  public readonly cellMenu = signal<{
    x: number;
    y: number;
    row: GridRow;
    colIndex: number;
    value: Cell | undefined;
  } | null>(null);
  public readonly sizeMenu = signal<{ x: number; y: number } | null>(null);
  public readonly copyFormats = COPY_FORMATS;
  public readonly totalCount = signal<number | null>(null);
  public readonly counting = signal(false);
  public readonly autoMenu = signal<{ x: number; y: number } | null>(null);
  public readonly autoRefresh = signal(false);
  public readonly refreshSeconds = signal(REFRESH_SECONDS[0]);
  private refreshTimer?: ReturnType<typeof setInterval>;
  /** Sort chosen from a column header; typing an ORDER BY replaces it. */
  private sortState = signal<{ col: string; dir: 'asc' | 'desc' } | null>(null);

  private rows: GridRow[] = [];
  private deletedRowIds = new Set<string>();
  /** Bumped on every edit so the computed values refresh. */
  private editVersion = signal(0);
  private gridApi?: GridApi<GridRow>;
  private newRowSequence = 0;

  private connectionKind = computed<DbKind>(
    () => this.connectionStore.get(this.tab().connId)?.kind ?? 'postgres',
  );

  public readonly pending = computed(() => {
    this.editVersion();
    return this.rows.filter((row) => row.isNew || this.deletedRowIds.has(row.id) || rowChanged(row))
      .length;
  });

  public readonly preview = computed(() => {
    this.editVersion();
    const page = this.page();
    const table = this.tab().table;
    if (!page || !table) return [];
    const kind = this.connectionKind();
    const changes = buildChanges(page.columns, this.rows, this.deletedRowIds);
    return previewSQL(changes, qualified(kind, table.schema, table.name), (name) =>
      quoteIdentifier(kind, name),
    );
  });

  public readonly rangeLabel = computed(() => {
    const page = this.page();
    if (!page) return '';
    if (!page.rows.length) return 'No rows';
    const firstRow = (this.offset() + 1).toLocaleString();
    const lastRow = (this.offset() + page.rows.length).toLocaleString();
    const total = this.totalCount();
    if (total !== null) return `${firstRow}–${lastRow} of ${total.toLocaleString()}`;
    return `${firstRow}–${lastRow}${page.hasMore ? '+' : ''}`;
  });

  public readonly defaultColumnDefinition: ColDef<GridRow> = {
    sortable: false, // sorting happens in SQL so it covers every page
    resizable: true,
    minWidth: 80,
    suppressHeaderMenuButton: true,
    cellClassRules: rangeClassRules(() => this.cellRange),
  };
  /** Drag selection of a block of cells (AG Grid's own is Enterprise only). */
  private cellRange?: CellRangeSelection<GridRow>;
  private hostElement = inject<ElementRef<HTMLElement>>(ElementRef);

  public readonly rowId = (params: { data: GridRow }) => params.data.id;
  public readonly rowClassRules = {
    'row-new': (params: { data?: GridRow }) => !!params.data?.isNew,
    'row-deleted': (params: { data?: GridRow }) =>
      !!params.data && this.deletedRowIds.has(params.data.id),
  };

  public constructor() {
    effect(() => {
      const pendingChanges = this.pending();
      untracked(() => {
        this.tabStore.setDirty(this.tab().id, pendingChanges > 0);
        if (!pendingChanges) this.previewOpen.set(false);
      });
    });
  }

  public onGridReady(event: GridReadyEvent<GridRow>) {
    this.gridApi = event.api;
    this.cellRange = new CellRangeSelection(event.api, this.hostElement.nativeElement, '__row');
    this.tableBridge.attach(this.tab().id, this);
    void this.reload(0);
  }

  public ngOnDestroy() {
    this.cellRange?.destroy();
    this.stopAutoRefresh();
    this.tableBridge.detach(this.tab().id);
  }

  public openAutoRefreshMenu(event: MouseEvent) {
    const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const height = 40 + (REFRESH_SECONDS.length + 1) * 26;
    this.autoMenu.set(clampMenu(bounds.left, bounds.bottom + 4, 170, height));
  }

  public setAutoRefresh(seconds: number) {
    this.autoMenu.set(null);
    if (seconds > 0) this.refreshSeconds.set(seconds);
    this.autoRefresh.set(seconds > 0);
    this.startAutoRefresh();
  }

  public intervalLabel(seconds: number) {
    return seconds === 60 ? 'minute' : `${seconds} s`;
  }
  public autoRefreshLabel() {
    return this.intervalLabel(this.refreshSeconds());
  }

  private startAutoRefresh() {
    this.stopAutoRefresh();
    if (!this.autoRefresh()) return;
    this.refreshTimer = setInterval(() => void this.autoReload(), this.refreshSeconds() * 1000);
  }

  private stopAutoRefresh() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
  }

  /** Refreshes the current page unless the user is busy with it. */
  private async autoReload() {
    if (!this.autoRefresh() || document.visibilityState !== 'visible') return;
    if (this.loading() || this.applying() || this.counting() || this.pending()) return;
    if (this.gridApi?.getEditingCells().length) return;
    const selectedRowIds = new Set((this.gridApi?.getSelectedRows() ?? []).map((row) => row.id));
    await this.reload(this.offset(), true);
    if (selectedRowIds.size) {
      this.gridApi?.forEachNode((node) =>
        node.setSelected(!!node.data && selectedRowIds.has(node.data.id)),
      );
    }
  }

  public setPageSize(size: number) {
    this.sizeMenu.set(null);
    this.limit.set(size);
    void this.reload(0);
  }

  public openPageSizeMenu(event: MouseEvent) {
    const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const height = 40 + PAGE_SIZES.length * 26;
    this.sizeMenu.set(clampMenu(bounds.right - 140, bounds.bottom + 4, 140, height));
  }

  public refresh() {
    void this.reload(this.offset());
  }

  public onOrderByEnter() {
    this.sortState.set(null);
    void this.reload(0);
  }

  private tablePageRequest(offset: number) {
    const table = this.tab().table!;
    return {
      schema: table.schema,
      table: table.name,
      type: table.type,
      where: this.where,
      orderBy: this.orderBy,
      offset: Math.max(0, offset),
      limit: this.limit(),
    };
  }

  public async reload(offset: number, silent = false) {
    if (
      !silent &&
      this.pending() &&
      !(await this.confirmDialog.ask(`Discard ${this.pending()} pending change(s)?`, {
        title: 'Discard changes',
        confirmLabel: 'Discard',
        danger: true,
      }))
    )
      return;
    const tab = this.tab();
    if (!tab.table) return;
    if (!(await this.connectionStore.ensureConnected(tab.connId))) return;
    if (!silent) {
      this.loading.set(true);
      this.error.set('');
    }
    this.totalCount.set(null);
    try {
      const { page, tx: transactionStatus } = await this.api.readTable(
        tab.id,
        tab.connId,
        tab.database,
        tab.txMode === 'manual',
        this.tablePageRequest(offset),
      );
      this.transactionStore.set(tab.id, transactionStatus);
      this.offset.set(page.offset);
      this.setPage(page);
      if (silent) this.error.set('');
    } catch (error) {
      this.error.set(errorText(error));
    } finally {
      if (!silent) this.loading.set(false);
    }
  }

  /** Counts every row matching the current filter, not just the loaded page. */
  public async countRows() {
    if (this.counting()) return;
    const tab = this.tab();
    if (!tab.table) return;
    if (!(await this.connectionStore.ensureConnected(tab.connId))) return;
    this.counting.set(true);
    this.error.set('');
    try {
      const { count, tx: transactionStatus } = await this.api.countTableRows(
        tab.id,
        tab.connId,
        tab.database,
        tab.txMode === 'manual',
        this.tablePageRequest(this.offset()),
      );
      this.transactionStore.set(tab.id, transactionStatus);
      this.totalCount.set(count);
    } catch (error) {
      this.error.set(errorText(error));
    } finally {
      this.counting.set(false);
    }
  }

  private setPage(page: TablePage) {
    this.page.set(page);
    this.deletedRowIds = new Set();
    this.rows = page.rows.map((cells, index) => ({
      id: `o${index}`,
      isNew: false,
      orig: cells,
      cells: [...cells],
    }));
    this.gridApi?.setGridOption('columnDefs', this.columnDefinitions(page));
    this.gridApi?.setGridOption('rowData', this.rows);
    this.editVersion.update((version) => version + 1);
  }

  private columnDefinitions(page: TablePage): ColDef<GridRow>[] {
    const rowNumberColumn: ColDef<GridRow> = {
      colId: '__row',
      headerName: '',
      width: 52,
      pinned: 'left',
      resizable: false,
      editable: false,
      cellClass: 'rownum',
      // Numbered from the page position, so rows added on top do not shift the numbers.
      valueGetter: (params) =>
        !params.data
          ? ''
          : params.data.isNew
            ? '+'
            : Number(params.data.id.slice(1)) + 1 + this.offset(),
    };
    return [
      rowNumberColumn,
      ...page.columns.map((column, columnIndex): ColDef<GridRow> => ({
        colId: `c${columnIndex}`,
        headerName: column.name,
        headerComponent: ColumnHeader,
        headerComponentParams: {
          column,
          sort: () => (this.sortState()?.col === column.name ? this.sortState()!.dir : null),
          onSort: () => this.sortBy(column.name),
          onFilter: () => this.filterByColumn(column.name),
        } satisfies ColumnHeaderParams,
        width: this.columnWidth(column.name, page.rows, columnIndex),
        valueGetter: (params) => params.data?.cells[columnIndex],
        valueSetter: (params: ValueSetterParams<GridRow>) =>
          this.setCell(params.data, columnIndex, params.newValue),
        valueFormatter: (params) =>
          params.value === undefined ? 'DEFAULT' : displayCell(params.value as Cell),
        editable: (params) =>
          page.editable &&
          column.editable &&
          !!params.data &&
          !this.deletedRowIds.has(params.data.id),
        cellClass: (params: CellClassParams<GridRow>) =>
          [
            params.value === null
              ? 'null'
              : params.value === undefined
                ? 'default'
                : typeof params.value === 'number'
                  ? 'num'
                  : '',
            params.data && isChanged(params.data, columnIndex) ? 'changed' : '',
          ].filter(Boolean),
        tooltipValueGetter: (params) =>
          typeof params.value === 'string' && params.value.length > 60
            ? params.value.slice(0, 2000)
            : undefined,
      })),
    ];
  }

  /** Estimated width of a column from its name and its first values. */
  private columnWidth(name: string, rows: Cell[][], columnIndex: number): number {
    const sample = rows.slice(0, 50).map((cells) => String(cells[columnIndex] ?? 'NULL').length);
    return Math.min(360, Math.max(110, Math.max(name.length + 6, ...sample) * 7.4 + 24));
  }

  /** Header sort cycles ascending → descending → none, and sorts in the database. */
  private sortBy(columnName: string) {
    const current = this.sortState();
    const nextDirection =
      current?.col !== columnName ? 'asc' : current.dir === 'asc' ? 'desc' : null;
    this.sortState.set(nextDirection ? { col: columnName, dir: nextDirection } : null);
    this.orderBy = nextDirection
      ? `${quoteIdentifier(this.connectionKind(), columnName)} ${nextDirection.toUpperCase()}`
      : '';
    void this.reload(0);
  }

  /** Header filter icon: starts a condition on that column in the WHERE box. */
  private filterByColumn(columnName: string) {
    const condition = `${quoteIdentifier(this.connectionKind(), columnName)} = `;
    this.where = this.where.trim() ? `${this.where.trim()} AND ${condition}` : condition;
    const element = this.whereInput()?.nativeElement;
    if (element) {
      element.value = this.where;
      element.focus();
      element.setSelectionRange(element.value.length, element.value.length);
    }
  }

  private setCell(row: GridRow, columnIndex: number, value: unknown): boolean {
    const nextValue = (value === undefined ? null : value) as Cell;
    const normalized = normalizeEdit(row, columnIndex, nextValue);
    if (Object.is(row.cells[columnIndex], normalized)) return false;
    row.cells[columnIndex] = normalized;
    this.editVersion.update((version) => version + 1);
    return true;
  }

  public addRow() {
    const page = this.page();
    if (!page?.editable) return;
    const row: GridRow = {
      id: `n${++this.newRowSequence}`,
      isNew: true,
      orig: [],
      cells: page.columns.map(() => undefined),
    };
    // New rows go on top, where they are visible, and editing starts right away.
    this.rows.unshift(row);
    const gridApi = this.gridApi;
    gridApi?.applyTransaction({ add: [row], addIndex: 0 });
    this.editVersion.update((version) => version + 1);
    const firstEditableColumn = page.columns.findIndex((column) => column.editable);
    if (gridApi && firstEditableColumn >= 0) {
      gridApi.stopEditing();
      gridApi.deselectAll();
      this.cellRange?.clear();
      gridApi.ensureIndexVisible(0, 'top');
      gridApi.setFocusedCell(0, `c${firstEditableColumn}`);
      gridApi.startEditingCell({ rowIndex: 0, colKey: `c${firstEditableColumn}` });
    }
  }

  /** Marks the selected rows (or the focused one) as deleted; a second click restores them. */
  public deleteRows() {
    const gridApi = this.gridApi;
    if (!gridApi) return;
    let rowNodes = this.selectedRows().flatMap((row) => {
      const node = gridApi.getRowNode(row.id);
      return node ? [node] : [];
    });
    if (!rowNodes.length) {
      const focusedCell = gridApi.getFocusedCell();
      const node = focusedCell ? gridApi.getDisplayedRowAtIndex(focusedCell.rowIndex) : undefined;
      rowNodes = node ? [node] : [];
    }
    const removedRows: GridRow[] = [];
    for (const node of rowNodes) {
      const row = node.data;
      if (!row) continue;
      if (row.isNew) removedRows.push(row);
      else if (this.deletedRowIds.has(row.id)) this.deletedRowIds.delete(row.id);
      else this.deletedRowIds.add(row.id);
    }
    if (removedRows.length) {
      this.rows = this.rows.filter((row) => !removedRows.includes(row));
      gridApi.applyTransaction({ remove: removedRows });
    }
    gridApi.redrawRows({ rowNodes: rowNodes.filter((node) => !removedRows.includes(node.data!)) });
    gridApi.deselectAll();
    this.editVersion.update((version) => version + 1);
  }

  public setFocusedCellNull() {
    const gridApi = this.gridApi;
    const focusedCell = gridApi?.getFocusedCell();
    if (!gridApi || !focusedCell || focusedCell.column.getColId() === '__row') return;
    const node = gridApi.getDisplayedRowAtIndex(focusedCell.rowIndex);
    const columnDefinition = focusedCell.column.getColDef();
    const editable =
      typeof columnDefinition.editable === 'function'
        ? columnDefinition.editable({ data: node?.data } as never)
        : columnDefinition.editable;
    if (!node?.data || !editable) return;
    node.setDataValue(focusedCell.column, null);
  }

  public revert() {
    const page = this.page();
    if (page) this.setPage(page);
  }

  public togglePreview() {
    this.gridApi?.stopEditing();
    this.previewOpen.update((open) => !open);
  }

  public copyPreview() {
    void this.commandService.copy(this.preview().join('\n\n'));
  }

  public toggleSearch() {
    const open = !this.searchOpen();
    this.searchOpen.set(open);
    if (open) setTimeout(() => this.searchInput()?.nativeElement.focus());
    else this.setQuickFilter('');
  }

  public setQuickFilter(text: string) {
    this.quickFilter.set(text);
    this.gridApi?.setGridOption('quickFilterText', text);
  }

  public copyPage(format: CopyFormat = 'tsv') {
    const page = this.page();
    if (!page) return;
    this.copyMenu.set(null);
    const rows = this.rows.filter((row) => !row.isNew).map((row) => row.cells as Cell[]);
    void this.commandService.copy(formatRows(format, page.columns, rows, true));
  }

  public copySelected(format: CopyFormat) {
    const page = this.page();
    if (!page) return;
    this.copyMenu.set(null);
    const block = this.selectedBlock();
    const rows = block
      ? block.rows
      : this.selectedRows().map((row) => row.cells.map((cell) => cell ?? null) as Cell[]);
    if (!rows.length) return;
    void this.commandService.copy(
      formatRows(format, block ? block.columns : page.columns, rows, true),
    );
  }

  public openCopyMenu(event: MouseEvent) {
    const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
    this.copyMenu.set(clampMenu(bounds.right - 210, bounds.bottom + 4, 210, 360));
  }

  // ---------- cell context menu ----------

  public onCellContextMenu(event: CellContextMenuEvent<GridRow>) {
    const mouseEvent = event.event as MouseEvent | undefined;
    if (!mouseEvent || !event.data) return;
    mouseEvent.preventDefault();
    const columnId = event.column.getColId();
    const columnIndex = /^c\d+$/.test(columnId) ? Number(columnId.slice(1)) : -1;
    // Keyboard-opened menus (Shift+F10) carry no pointer coordinates.
    const pointerX = mouseEvent instanceof MouseEvent ? mouseEvent.clientX : 8;
    const pointerY = mouseEvent instanceof MouseEvent ? mouseEvent.clientY : 8;
    this.cellMenu.set({
      ...clampMenu(pointerX, pointerY, 230, 300),
      row: event.data,
      colIndex: columnIndex,
      value: columnIndex >= 0 ? event.data.cells[columnIndex] : undefined,
    });
  }

  public selectedCount(): number {
    return this.selectedRows().length;
  }

  /**
   * Rows covered by the drag selection, or else the grid's selected rows
   * (set by actions on one row, such as the cell menu's delete).
   */
  private selectedRows(): GridRow[] {
    const cellRange = this.cellRange;
    if (cellRange?.active) {
      const [firstRow, lastRow] = cellRange.rows();
      const rows: GridRow[] = [];
      for (let rowIndex = firstRow; rowIndex <= lastRow; rowIndex++) {
        const row = this.gridApi?.getDisplayedRowAtIndex(rowIndex)?.data;
        if (row) rows.push(row);
      }
      return rows;
    }
    return (this.gridApi?.getSelectedRows() as GridRow[] | undefined) ?? [];
  }

  /** Data-column indexes covered by the drag selection, in display order. */
  private selectedColumnIndexes(): number[] {
    return (this.cellRange?.columns() ?? []).flatMap((column) => {
      const match = /^c(\d+)$/.exec(column.getColId());
      return match ? [Number(match[1])] : [];
    });
  }

  /** The dragged block of cells, already narrowed to its columns. */
  private selectedBlock(): { columns: TablePage['columns']; rows: Cell[][] } | null {
    const page = this.page();
    if (!page || !this.cellRange?.active) return null;
    const rows = this.selectedRows();
    if (!rows.length) return null;
    const selectedIndexes = this.selectedColumnIndexes();
    const columnIndexes = selectedIndexes.length
      ? selectedIndexes
      : page.columns.map((_, index) => index);
    return {
      columns: columnIndexes.map((index) => page.columns[index]),
      rows: rows.map((row) => columnIndexes.map((index) => (row.cells[index] ?? null) as Cell)),
    };
  }

  public onCellKeyDown(event: CellKeyDownEvent<GridRow> | FullWidthCellKeyDownEvent<GridRow>) {
    const keyboardEvent = event.event as KeyboardEvent | undefined;
    if (!('column' in event) || !keyboardEvent) return;
    const copyKey =
      keyboardEvent.key.toLowerCase() === 'c' &&
      (isMac ? keyboardEvent.metaKey : keyboardEvent.ctrlKey);
    if (!copyKey) return;
    keyboardEvent.preventDefault();
    const block = this.selectedBlock();
    if (!block) {
      const value = event.value as Cell;
      void this.commandService.copy(value === null || value === undefined ? '' : String(value));
    } else if (block.rows.length === 1 && block.columns.length === 1) {
      const value = block.rows[0][0];
      void this.commandService.copy(value === null ? '' : String(value));
    } else {
      void this.commandService.copy(formatRows('tsv', block.columns, block.rows, true));
    }
  }

  private contextMenuColumn() {
    const menu = this.cellMenu();
    return menu && menu.colIndex >= 0 ? this.page()?.columns[menu.colIndex] : undefined;
  }

  /** Whether the cell under the menu can be edited right now. */
  private isCellEditable() {
    const menu = this.cellMenu();
    const column = this.contextMenuColumn();
    return (
      !!menu &&
      !!column &&
      !!this.page()?.editable &&
      column.editable &&
      !this.deletedRowIds.has(menu.row.id)
    );
  }

  public canSetCellNull() {
    const menu = this.cellMenu();
    return !!menu && this.isCellEditable() && menu.value !== null;
  }

  public isCellChanged() {
    const menu = this.cellMenu();
    return !!menu && menu.colIndex >= 0 && !menu.row.isNew && isChanged(menu.row, menu.colIndex);
  }

  public isCellRowDeleted() {
    const menu = this.cellMenu();
    return !!menu && this.deletedRowIds.has(menu.row.id);
  }

  public copyCellValue() {
    const menu = this.cellMenu();
    if (!menu || menu.colIndex < 0) return;
    this.cellMenu.set(null);
    void this.commandService.copy(
      menu.value === null || menu.value === undefined ? '' : String(menu.value),
    );
  }

  public copyCellColumn() {
    const column = this.contextMenuColumn();
    this.cellMenu.set(null);
    if (column) void this.commandService.copy(column.name);
  }

  public copyCellRow() {
    const menu = this.cellMenu();
    const page = this.page();
    if (!menu || !page) return;
    this.cellMenu.set(null);
    const rows = [menu.row.cells.map((cell) => cell ?? null) as Cell[]];
    void this.commandService.copy(formatRows('tsv', page.columns, rows, true));
  }

  public copyCellSelection() {
    this.cellMenu.set(null);
    this.copySelected('tsv');
  }

  /** Starts a WHERE condition on the clicked column with the clicked value. */
  public filterByCell() {
    const menu = this.cellMenu();
    const column = this.contextMenuColumn();
    if (!menu || !column || menu.value === undefined) return;
    const identifier = quoteIdentifier(this.connectionKind(), column.name);
    let condition: string;
    if (menu.value === null) condition = `${identifier} IS NULL`;
    else if (typeof menu.value === 'number') condition = `${identifier} = ${menu.value}`;
    else if (typeof menu.value === 'boolean')
      condition = `${identifier} = ${menu.value ? 'TRUE' : 'FALSE'}`;
    else condition = `${identifier} = '${String(menu.value).replace(/'/g, "''")}'`;
    this.where = condition;
    this.cellMenu.set(null);
    void this.reload(0);
  }

  public setCellNull() {
    const menu = this.cellMenu();
    if (!menu || !this.isCellEditable()) return;
    this.cellMenu.set(null);
    this.gridApi?.getRowNode(menu.row.id)?.setDataValue(`c${menu.colIndex}`, null);
  }

  public revertCell() {
    const menu = this.cellMenu();
    if (!menu || !this.isCellChanged()) return;
    this.cellMenu.set(null);
    this.setCell(menu.row, menu.colIndex, menu.row.orig[menu.colIndex]);
    const node = this.gridApi?.getRowNode(menu.row.id);
    if (node) this.gridApi?.refreshCells({ rowNodes: [node] });
  }

  public deleteCellRow() {
    const menu = this.cellMenu();
    this.cellMenu.set(null);
    if (!menu) return;
    const node = this.gridApi?.getRowNode(menu.row.id);
    if (!node) return;
    this.gridApi?.deselectAll();
    this.cellRange?.clear(); // the menu acts on its own row, not on the dragged block
    node.setSelected(true);
    this.deleteRows();
  }

  public showTableDefinition() {
    const tab = this.tab();
    if (!tab.table) return;
    void this.commandService.showDDL(
      tab.connId,
      { schema: tab.table.schema, name: tab.table.name, type: tab.table.type as 'table' | 'view' },
      tab.database,
    );
  }

  public async apply() {
    const page = this.page();
    const tab = this.tab();
    if (!page?.editable || !tab.table || this.applying()) return;
    this.gridApi?.stopEditing();
    const changes = buildChanges(page.columns, this.rows, this.deletedRowIds);
    if (!changes.length) return;
    this.applying.set(true);
    this.error.set('');
    try {
      const manual = tab.txMode === 'manual';
      const { result, tx: transactionStatus } = await this.api.applyTableChanges(
        tab.id,
        tab.connId,
        tab.database,
        manual,
        { schema: tab.table.schema, table: tab.table.name, changes },
      );
      this.transactionStore.set(tab.id, transactionStatus);
      const parts = [
        result.inserted && `${result.inserted} inserted`,
        result.updated && `${result.updated} updated`,
        result.deleted && `${result.deleted} deleted`,
      ].filter(Boolean);
      const suffix = manual ? ' (in the open transaction, not committed yet)' : '';
      this.toastService.success(`${tab.name}: ${parts.join(' · ')}${suffix}`);
      this.previewOpen.set(false);
      this.deletedRowIds = new Set();
      this.rows = [];
      this.editVersion.update((version) => version + 1);
      await this.reload(this.offset());
    } catch (error) {
      // Nothing was written (single transaction); keep the edits so they can be fixed.
      this.error.set(errorText(error));
    } finally {
      this.applying.set(false);
    }
  }
}
