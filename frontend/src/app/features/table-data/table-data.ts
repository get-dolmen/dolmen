import { Component, ElementRef, OnDestroy, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AgGridAngular } from 'ag-grid-angular';
import type { CellClassParams, CellContextMenuEvent, CellKeyDownEvent, ColDef, FullWidthCellKeyDownEvent, GridApi, GridReadyEvent, ValueSetterParams } from 'ag-grid-community';
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
import { displayCell, gridTheme } from '../results/result-grid';
import { COPY_FORMATS, formatRows, type CopyFormat } from '../results/copy';
import { CellRangeSelection, rangeClassRules } from '../../shared/cell-range';
import { buildChanges, isChanged, normalizeEdit, previewSQL, rowChanged, type GridRow } from './changes';
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
  private cmds = inject(Commands);
  private conns = inject(ConnectionStore);
  private tabs = inject(TabStore);
  private bridge = inject(TableBridge);
  private toasts = inject(Toasts);
  private tx = inject(TxStore);
  private confirm = inject(Confirm);
  private whereInput = viewChild<ElementRef<HTMLInputElement>>('whereInput');
  private searchInput = viewChild<ElementRef<HTMLInputElement>>('search');

  public readonly tab = input.required<EditorTab>();
  public readonly theme = gridTheme;
  public readonly mod = MOD;
  public readonly sizes = PAGE_SIZES;
  public readonly refreshChoices = REFRESH_SECONDS;
  /** Click-and-drag selects a block of cells, like a spreadsheet. */

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
  public readonly quick = signal('');
  public readonly copyMenu = signal<{ x: number; y: number } | null>(null);
  public readonly cellMenu = signal<{ x: number; y: number; row: GridRow; colIndex: number; value: Cell | undefined } | null>(null);
  public readonly sizeMenu = signal<{ x: number; y: number } | null>(null);
  public readonly formats = COPY_FORMATS;
  public readonly totalCount = signal<number | null>(null);
  public readonly counting = signal(false);
  public readonly autoMenu = signal<{ x: number; y: number } | null>(null);
  public readonly autoRefresh = signal(false);
  public readonly refreshSeconds = signal(REFRESH_SECONDS[0]);
  private refreshTimer?: ReturnType<typeof setInterval>;
  /** Sort chosen from a column header; typing an ORDER BY replaces it. */
  private sortState = signal<{ col: string; dir: 'asc' | 'desc' } | null>(null);

  private rows: GridRow[] = [];
  private deleted = new Set<string>();
  private version = signal(0); // bumped on every edit so computed values refresh
  private grid?: GridApi<GridRow>;
  private seq = 0;

  private kind = computed<DbKind>(() => this.conns.get(this.tab().connId)?.kind ?? 'postgres');

  public readonly pending = computed(() => {
    this.version();
    return this.rows.filter((r) => r.isNew || this.deleted.has(r.id) || rowChanged(r)).length;
  });

  public readonly preview = computed(() => {
    this.version();
    const p = this.page();
    const t = this.tab().table;
    if (!p || !t) return [];
    const k = this.kind();
    return previewSQL(buildChanges(p.columns, this.rows, this.deleted), qualified(k, t.schema, t.name), (n) => quoteIdentifier(k, n));
  });

  public readonly rangeText = computed(() => {
    const p = this.page();
    if (!p) return '';
    if (!p.rows.length) return 'No rows';
    const from = (this.offset() + 1).toLocaleString();
    const to = (this.offset() + p.rows.length).toLocaleString();
    const total = this.totalCount();
    if (total !== null) return `${from}–${to} of ${total.toLocaleString()}`;
    return `${from}–${to}${p.hasMore ? '+' : ''}`;
  });

  public readonly defaultColDef: ColDef<GridRow> = {
    sortable: false, // sorting happens in SQL so it covers every page
    resizable: true,
    minWidth: 80,
    suppressHeaderMenuButton: true,
    cellClassRules: rangeClassRules(() => this.range),
  };
  /** Drag selection of a block of cells (AG Grid's own is Enterprise only). */
  private range?: CellRangeSelection<GridRow>;
  private host = inject<ElementRef<HTMLElement>>(ElementRef);

  public readonly rowId = (p: { data: GridRow }) => p.data.id;
  public readonly rowClassRules = {
    'row-new': (p: { data?: GridRow }) => !!p.data?.isNew,
    'row-deleted': (p: { data?: GridRow }) => !!p.data && this.deleted.has(p.data.id),
  };

  public constructor() {
    effect(() => {
      const n = this.pending();
      untracked(() => {
        this.tabs.setDirty(this.tab().id, n > 0);
        if (!n) this.previewOpen.set(false);
      });
    });
  }

  public onReady(e: GridReadyEvent<GridRow>) {
    this.grid = e.api;
    this.range = new CellRangeSelection(e.api, this.host.nativeElement, '__row');
    this.bridge.attach(this.tab().id, this);
    void this.reload(0);
  }

  public ngOnDestroy() {
    this.range?.destroy();
    this.stopAutoRefresh();
    this.bridge.detach(this.tab().id);
  }

  public openAutoMenu(e: MouseEvent) {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    this.autoMenu.set(clampMenu(rect.left, rect.bottom + 4, 170, 40 + (REFRESH_SECONDS.length + 1) * 26));
  }

  public setAutoRefresh(seconds: number) {
    this.autoMenu.set(null);
    if (seconds > 0) this.refreshSeconds.set(seconds);
    this.autoRefresh.set(seconds > 0);
    this.startAutoRefresh();
  }

  public label(seconds: number) { return seconds === 60 ? 'minute' : `${seconds} s`; }
  public autoLabel() { return this.label(this.refreshSeconds()); }

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
    if (this.grid?.getEditingCells().length) return;
    const selected = new Set((this.grid?.getSelectedRows() ?? []).map((r) => r.id));
    await this.reload(this.offset(), true);
    if (selected.size) {
      this.grid?.forEachNode((n) => n.setSelected(!!n.data && selected.has(n.data.id)));
    }
  }

  public setLimit(n: number) {
    this.sizeMenu.set(null);
    this.limit.set(n);
    void this.reload(0);
  }

  public openSizeMenu(e: MouseEvent) {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    this.sizeMenu.set(clampMenu(rect.right - 140, rect.bottom + 4, 140, 40 + PAGE_SIZES.length * 26));
  }

  public refresh() { void this.reload(this.offset()); }

  public onOrderByEnter() {
    this.sortState.set(null);
    void this.reload(0);
  }

  private pageRequest(offset: number) {
    const t = this.tab();
    return {
      schema: t.table!.schema, table: t.table!.name, type: t.table!.type,
      where: this.where, orderBy: this.orderBy, offset: Math.max(0, offset), limit: this.limit(),
    };
  }

  public async reload(offset: number, silent = false) {
    if (!silent && this.pending() && !(await this.confirm.ask(`Discard ${this.pending()} pending change(s)?`,
      { title: 'Discard changes', confirmLabel: 'Discard', danger: true }))) return;
    const t = this.tab();
    if (!t.table) return;
    if (!(await this.conns.ensureConnected(t.connId))) return;
    if (!silent) {
      this.loading.set(true);
      this.error.set('');
    }
    this.totalCount.set(null);
    try {
      const { page: p, tx } = await this.api.readTable(t.id, t.connId, t.database, t.txMode === 'manual', this.pageRequest(offset));
      this.tx.set(t.id, tx);
      this.offset.set(p.offset);
      this.setPage(p);
      if (silent) this.error.set('');
    } catch (e) {
      this.error.set(errorText(e));
    } finally {
      if (!silent) this.loading.set(false);
    }
  }

  /** Counts every row matching the current filter, not just the loaded page. */
  public async countRows() {
    if (this.counting()) return;
    const t = this.tab();
    if (!t.table) return;
    if (!(await this.conns.ensureConnected(t.connId))) return;
    this.counting.set(true);
    this.error.set('');
    try {
      const { count, tx } = await this.api.countTableRows(t.id, t.connId, t.database, t.txMode === 'manual', this.pageRequest(this.offset()));
      this.tx.set(t.id, tx);
      this.totalCount.set(count);
    } catch (e) {
      this.error.set(errorText(e));
    } finally {
      this.counting.set(false);
    }
  }

  private setPage(p: TablePage) {
    this.page.set(p);
    this.deleted = new Set();
    this.rows = p.rows.map((r, i) => ({ id: `o${i}`, isNew: false, orig: r, cells: [...r] }));
    this.grid?.setGridOption('columnDefs', this.columnDefs(p));
    this.grid?.setGridOption('rowData', this.rows);
    this.version.update((v) => v + 1);
  }

  private columnDefs(p: TablePage): ColDef<GridRow>[] {
    const rownum: ColDef<GridRow> = {
      colId: '__row', headerName: '', width: 52, pinned: 'left', resizable: false, editable: false, cellClass: 'rownum',
      // Numbered from the page position, so rows added on top do not shift the numbers.
      valueGetter: (v) => (!v.data ? '' : v.data.isNew ? '+' : Number(v.data.id.slice(1)) + 1 + this.offset()),
    };
    return [rownum, ...p.columns.map((c, i): ColDef<GridRow> => ({
      colId: `c${i}`,
      headerName: c.name,
      headerComponent: ColumnHeader,
      headerComponentParams: {
        column: c,
        sort: () => (this.sortState()?.col === c.name ? this.sortState()!.dir : null),
        onSort: () => this.sortBy(c.name),
        onFilter: () => this.filterOn(c.name),
      } satisfies ColumnHeaderParams,
      width: Math.min(360, Math.max(110, Math.max(c.name.length + 6, ...p.rows.slice(0, 50).map((r) => String(r[i] ?? 'NULL').length)) * 7.4 + 24)),
      valueGetter: (v) => v.data?.cells[i],
      valueSetter: (v: ValueSetterParams<GridRow>) => this.setCell(v.data, i, v.newValue),
      valueFormatter: (v) => (v.value === undefined ? 'DEFAULT' : displayCell(v.value as Cell)),
      editable: (v) => p.editable && c.editable && !!v.data && !this.deleted.has(v.data.id),
      cellClass: (v: CellClassParams<GridRow>) => [
        v.value === null ? 'null' : v.value === undefined ? 'default' : typeof v.value === 'number' ? 'num' : '',
        v.data && isChanged(v.data, i) ? 'changed' : '',
      ].filter(Boolean),
      tooltipValueGetter: (v) => (typeof v.value === 'string' && v.value.length > 60 ? v.value.slice(0, 2000) : undefined),
    }))];
  }

  /** Header sort cycles ascending → descending → none, and sorts in the database. */
  private sortBy(col: string) {
    const cur = this.sortState();
    const next = cur?.col !== col ? 'asc' : cur.dir === 'asc' ? 'desc' : null;
    this.sortState.set(next ? { col, dir: next } : null);
    this.orderBy = next ? `${quoteIdentifier(this.kind(), col)} ${next.toUpperCase()}` : '';
    void this.reload(0);
  }

  /** Header filter icon: starts a condition on that column in the WHERE box. */
  private filterOn(col: string) {
    const cond = `${quoteIdentifier(this.kind(), col)} = `;
    this.where = this.where.trim() ? `${this.where.trim()} AND ${cond}` : cond;
    const el = this.whereInput()?.nativeElement;
    if (el) {
      el.value = this.where;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }

  private setCell(row: GridRow, i: number, value: unknown): boolean {
    const v = (value === undefined ? null : value) as Cell;
    const next = normalizeEdit(row, i, v);
    if (Object.is(row.cells[i], next)) return false;
    row.cells[i] = next;
    this.version.update((x) => x + 1);
    return true;
  }

  public addRow() {
    const p = this.page();
    if (!p?.editable) return;
    const row: GridRow = { id: `n${++this.seq}`, isNew: true, orig: [], cells: p.columns.map(() => undefined) };
    // New rows go on top, where they are visible, and editing starts right away.
    this.rows.unshift(row);
    const api = this.grid;
    api?.applyTransaction({ add: [row], addIndex: 0 });
    this.version.update((x) => x + 1);
    const first = p.columns.findIndex((c) => c.editable);
    if (api && first >= 0) {
      api.stopEditing();
      api.deselectAll();
      this.range?.clear();
      api.ensureIndexVisible(0, 'top');
      api.setFocusedCell(0, `c${first}`);
      api.startEditingCell({ rowIndex: 0, colKey: `c${first}` });
    }
  }

  /** Marks the selected rows (or the focused one) as deleted; a second click restores them. */
  public deleteRows() {
    const api = this.grid;
    if (!api) return;
    let nodes = this.selectionRows().flatMap((r) => {
      const n = api.getRowNode(r.id);
      return n ? [n] : [];
    });
    if (!nodes.length) {
      const f = api.getFocusedCell();
      const n = f ? api.getDisplayedRowAtIndex(f.rowIndex) : undefined;
      nodes = n ? [n] : [];
    }
    const remove: GridRow[] = [];
    for (const n of nodes) {
      const r = n.data;
      if (!r) continue;
      if (r.isNew) remove.push(r);
      else if (this.deleted.has(r.id)) this.deleted.delete(r.id);
      else this.deleted.add(r.id);
    }
    if (remove.length) {
      this.rows = this.rows.filter((r) => !remove.includes(r));
      api.applyTransaction({ remove });
    }
    api.redrawRows({ rowNodes: nodes.filter((n) => !remove.includes(n.data!)) });
    api.deselectAll();
    this.version.update((x) => x + 1);
  }

  public setNull() {
    const api = this.grid;
    const f = api?.getFocusedCell();
    if (!api || !f || f.column.getColId() === '__row') return;
    const node = api.getDisplayedRowAtIndex(f.rowIndex);
    const def = f.column.getColDef();
    if (!node?.data || !(typeof def.editable === 'function' ? def.editable({ data: node.data } as any) : def.editable)) return;
    node.setDataValue(f.column, null);
  }

  public revert() {
    const p = this.page();
    if (p) this.setPage(p);
  }

  public togglePreview() {
    this.grid?.stopEditing();
    this.previewOpen.update((v) => !v);
  }

  public copyPreview() { void this.cmds.copy(this.preview().join('\n\n')); }

  public toggleSearch() {
    const open = !this.searchOpen();
    this.searchOpen.set(open);
    if (open) setTimeout(() => this.searchInput()?.nativeElement.focus());
    else this.setQuick('');
  }

  public setQuick(q: string) {
    this.quick.set(q);
    this.grid?.setGridOption('quickFilterText', q);
  }

  public copyPage(format: CopyFormat = 'tsv') {
    const p = this.page();
    if (!p) return;
    this.copyMenu.set(null);
    void this.cmds.copy(formatRows(format, p.columns, this.rows.filter((r) => !r.isNew).map((r) => r.cells as Cell[]), true));
  }

  public copySelected(format: CopyFormat) {
    const p = this.page();
    if (!p) return;
    this.copyMenu.set(null);
    const sel = this.selectionData();
    const rows = sel ? sel.rows : this.selectionRows().map((r) => r.cells.map((v) => v ?? null) as Cell[]);
    if (!rows.length) return;
    void this.cmds.copy(formatRows(format, sel ? sel.columns : p.columns, rows, true));
  }

  public openCopyMenu(e: MouseEvent) {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    this.copyMenu.set(clampMenu(rect.right - 210, rect.bottom + 4, 210, 360));
  }

  // ---------- cell context menu ----------

  public onCellMenu(e: CellContextMenuEvent<GridRow>) {
    const ev = e.event as MouseEvent | undefined;
    if (!ev || !e.data) return;
    ev.preventDefault();
    const colId = e.column.getColId();
    const colIndex = /^c\d+$/.test(colId) ? Number(colId.slice(1)) : -1;
    // Keyboard-opened menus (Shift+F10) carry no pointer coordinates.
    const x = ev instanceof MouseEvent ? ev.clientX : 8;
    const y = ev instanceof MouseEvent ? ev.clientY : 8;
    this.cellMenu.set({
      ...clampMenu(x, y, 230, 300),
      row: e.data,
      colIndex,
      value: colIndex >= 0 ? e.data.cells[colIndex] : undefined,
    });
  }

  public selectedCount(): number { return this.selectionRows().length; }

  /**
   * Rows covered by the drag selection, or else the grid's selected rows
   * (set by actions on one row, such as the cell menu's delete).
   */
  private selectionRows(): GridRow[] {
    const r = this.range;
    if (r?.active) {
      const [from, to] = r.rows();
      const rows: GridRow[] = [];
      for (let i = from; i <= to; i++) {
        const data = this.grid?.getDisplayedRowAtIndex(i)?.data;
        if (data) rows.push(data);
      }
      return rows;
    }
    return (this.grid?.getSelectedRows() as GridRow[] | undefined) ?? [];
  }

  /** Data-column indexes covered by the drag selection, in display order. */
  private selectionColumns(): number[] {
    return (this.range?.columns() ?? []).flatMap((c) => {
      const m = /^c(\d+)$/.exec(c.getColId());
      return m ? [Number(m[1])] : [];
    });
  }

  /** The dragged block of cells, already narrowed to its columns. */
  private selectionData(): { columns: TablePage['columns']; rows: Cell[][] } | null {
    const p = this.page();
    if (!p || !this.range?.active) return null;
    const rows = this.selectionRows();
    if (!rows.length) return null;
    const idx = this.selectionColumns();
    const cols = idx.length ? idx : p.columns.map((_, i) => i);
    return {
      columns: cols.map((i) => p.columns[i]),
      rows: rows.map((r) => cols.map((i) => (r.cells[i] ?? null) as Cell)),
    };
  }

  public onCellKey(e: CellKeyDownEvent<GridRow> | FullWidthCellKeyDownEvent<GridRow>) {
    const ev = e.event as KeyboardEvent | undefined;
    if (!('column' in e) || !ev || ev.key.toLowerCase() !== 'c' || !(isMac ? ev.metaKey : ev.ctrlKey)) return;
    ev.preventDefault();
    const sel = this.selectionData();
    if (!sel) {
      const v = e.value as Cell;
      void this.cmds.copy(v === null || v === undefined ? '' : String(v));
    } else if (sel.rows.length === 1 && sel.columns.length === 1) {
      const v = sel.rows[0][0];
      void this.cmds.copy(v === null ? '' : String(v));
    } else {
      void this.cmds.copy(formatRows('tsv', sel.columns, sel.rows, true));
    }
  }

  private menuColumn() {
    const m = this.cellMenu();
    return m && m.colIndex >= 0 ? this.page()?.columns[m.colIndex] : undefined;
  }

  /** Whether the cell under the menu can be edited right now. */
  private cellEditable() {
    const m = this.cellMenu();
    const c = this.menuColumn();
    return !!m && !!c && !!this.page()?.editable && c.editable && !this.deleted.has(m.row.id);
  }

  public canNullCell() {
    const m = this.cellMenu();
    return !!m && this.cellEditable() && m.value !== null;
  }

  public cellChanged() {
    const m = this.cellMenu();
    return !!m && m.colIndex >= 0 && !m.row.isNew && isChanged(m.row, m.colIndex);
  }

  public cellRowDeleted() {
    const m = this.cellMenu();
    return !!m && this.deleted.has(m.row.id);
  }

  public copyCellValue() {
    const m = this.cellMenu();
    if (!m || m.colIndex < 0) return;
    this.cellMenu.set(null);
    void this.cmds.copy(m.value === null || m.value === undefined ? '' : String(m.value));
  }

  public copyCellColumn() {
    const c = this.menuColumn();
    this.cellMenu.set(null);
    if (c) void this.cmds.copy(c.name);
  }

  public copyCellRow() {
    const m = this.cellMenu();
    const p = this.page();
    if (!m || !p) return;
    this.cellMenu.set(null);
    void this.cmds.copy(formatRows('tsv', p.columns, [m.row.cells.map((v) => v ?? null) as Cell[]], true));
  }

  public copyCellSelection() {
    this.cellMenu.set(null);
    this.copySelected('tsv');
  }

  /** Starts a WHERE condition on the clicked column with the clicked value. */
  public filterByCell() {
    const m = this.cellMenu();
    const c = this.menuColumn();
    if (!m || !c || m.value === undefined) return;
    const id = quoteIdentifier(this.kind(), c.name);
    let cond: string;
    if (m.value === null) cond = `${id} IS NULL`;
    else if (typeof m.value === 'number') cond = `${id} = ${m.value}`;
    else if (typeof m.value === 'boolean') cond = `${id} = ${m.value ? 'TRUE' : 'FALSE'}`;
    else cond = `${id} = '${String(m.value).replace(/'/g, "''")}'`;
    this.where = cond;
    this.cellMenu.set(null);
    void this.reload(0);
  }

  public setCellNull() {
    const m = this.cellMenu();
    if (!m || !this.cellEditable()) return;
    this.cellMenu.set(null);
    this.grid?.getRowNode(m.row.id)?.setDataValue(`c${m.colIndex}`, null);
  }

  public revertCell() {
    const m = this.cellMenu();
    if (!m || !this.cellChanged()) return;
    this.cellMenu.set(null);
    this.setCell(m.row, m.colIndex, m.row.orig[m.colIndex]);
    const node = this.grid?.getRowNode(m.row.id);
    if (node) this.grid?.refreshCells({ rowNodes: [node] });
  }

  public deleteCellRow() {
    const m = this.cellMenu();
    this.cellMenu.set(null);
    if (!m) return;
    const node = this.grid?.getRowNode(m.row.id);
    if (!node) return;
    this.grid?.deselectAll();
    this.range?.clear(); // the menu acts on its own row, not on the dragged block
    node.setSelected(true);
    this.deleteRows();
  }

  public ddl() {
    const t = this.tab();
    if (t.table) void this.cmds.showDDL(t.connId, { schema: t.table.schema, name: t.table.name, type: t.table.type as 'table' | 'view' }, t.database);
  }

  public async apply() {
    const p = this.page();
    const t = this.tab();
    if (!p?.editable || !t.table || this.applying()) return;
    this.grid?.stopEditing();
    const changes = buildChanges(p.columns, this.rows, this.deleted);
    if (!changes.length) return;
    this.applying.set(true);
    this.error.set('');
    try {
      const manual = t.txMode === 'manual';
      const { result: r, tx } = await this.api.applyTableChanges(t.id, t.connId, t.database, manual, { schema: t.table.schema, table: t.table.name, changes });
      this.tx.set(t.id, tx);
      const parts = [r.inserted && `${r.inserted} inserted`, r.updated && `${r.updated} updated`, r.deleted && `${r.deleted} deleted`].filter(Boolean);
      this.toasts.success(`${t.name}: ${parts.join(' · ')}${manual ? ' (in the open transaction, not committed yet)' : ''}`);
      this.previewOpen.set(false);
      this.deleted = new Set();
      this.rows = [];
      this.version.update((x) => x + 1);
      await this.reload(this.offset());
    } catch (e) {
      // Nothing was written (single transaction); keep the edits so they can be fixed.
      this.error.set(errorText(e));
    } finally {
      this.applying.set(false);
    }
  }
}
