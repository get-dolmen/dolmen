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
import { ident, qualified } from '../../core/sql';
import type { Cell, DbKind, TablePage } from '../../core/models';
import { Confirm } from '../../shared/confirm';
import { Icon } from '../../shared/icon';
import { ClickOutside, clampMenu } from '../../shared/click-outside';
import { display, gridTheme } from '../results/result-grid';
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
  styles: `
    :host { display: flex; flex-direction: column; min-height: 0; background: var(--bg-panel); }
    .toolbar { display: flex; align-items: center; gap: 2px; height: 38px; padding: 0 8px; border-bottom: 1px solid var(--border); background: var(--bg); flex: none; }
    .ib { position: relative; display: inline-grid; place-items: center; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 6px;
          background: none; color: var(--text-muted); cursor: pointer; flex: none; }
    .ib:hover:not(:disabled) { background: var(--bg-hover); color: var(--text); }
    .ib:disabled { opacity: 0.35; cursor: default; }
    .ib.on { background: var(--accent-soft); color: var(--accent); }
    .ib.submit.ready { color: var(--accent); }
    .count { position: absolute; top: 1px; right: 0; min-width: 14px; height: 14px; padding: 0 3px; border-radius: 7px; background: var(--accent); color: var(--accent-text);
             font: 700 9.5px/14px var(--font-ui); text-align: center; }
    .tb { height: 28px; padding: 0 8px; border: 0; border-radius: 6px; background: none; color: var(--text-muted); font: 600 12px var(--font-ui); cursor: pointer; }
    .tb:hover { background: var(--bg-hover); color: var(--text); }
    .sep { width: 1px; height: 18px; margin: 0 6px; background: var(--border-strong); flex: none; }
    .search { width: 200px; height: 26px; margin: 0 2px; padding: 0 8px; border: 1px solid var(--accent); border-radius: 6px; background: var(--bg-panel); outline: none; font-size: 12px; }
    .ro { font-size: var(--fs-xs); color: var(--text-muted); margin-right: 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 260px; }
    .range-wrap { display: inline-flex; flex: none; }
    .range { display: inline-flex; align-items: center; height: 26px; padding: 0 6px; border: 0; border-radius: 6px; background: none; cursor: pointer;
             font-size: var(--fs-xs); color: var(--text-muted); font-variant-numeric: tabular-nums; margin-right: 2px; white-space: nowrap; }
    .range:hover:not(:disabled) { background: var(--bg-hover); color: var(--text); }
    .range:disabled { cursor: default; }
    .sizes { display: inline-flex; flex: none; }
    .size { display: inline-flex; align-items: center; gap: 4px; height: 26px; margin-left: 4px; padding: 0 6px; border: 1px solid var(--border); border-radius: 6px;
            background: var(--bg-panel); font-size: var(--fs-xs); color: var(--text-muted); cursor: pointer; white-space: nowrap; }
    .size:hover { border-color: var(--border-strong); color: var(--text); }
    .clauses { display: flex; height: 34px; border-bottom: 1px solid var(--border); flex: none; }
    .clause { flex: 1; display: flex; align-items: center; gap: 8px; min-width: 0; padding: 0 10px; color: var(--text-faint); cursor: text; }
    .clause + .clause { border-left: 1px solid var(--border); }
    .clause:focus-within { color: var(--accent); background: var(--bg-hover); }
    .clause input { flex: 1; min-width: 0; height: 100%; border: 0; background: none; outline: none; box-shadow: none; color: var(--text); font-size: 12.5px; }
    .clause input::placeholder { color: var(--text-faint); letter-spacing: 0.04em; }
    .error { display: flex; align-items: center; gap: 8px; padding: 4px 6px 4px 12px; background: var(--danger-soft); color: var(--danger); font-size: var(--fs-sm); user-select: text; flex: none; }
    .error span { flex: 1; }
    .error .ib { color: var(--danger); }
    .grid-wrap { position: relative; flex: 1; min-height: 0; }
    .grid { height: 100%; width: 100%; }
    .loading { position: absolute; inset: 0; display: grid; place-items: center; background: color-mix(in srgb, var(--bg-panel) 50%, transparent); }
    .spinner { width: 18px; height: 18px; border: 2px solid var(--accent-soft); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; }
    .spinner.sm { width: 11px; height: 11px; border-width: 1.5px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .preview { position: absolute; top: 8px; left: 50%; transform: translateX(-50%); width: min(720px, calc(100% - 32px)); max-height: 70%; display: flex; flex-direction: column;
               background: var(--bg-raised); border: 1px solid var(--border); border-radius: 10px; box-shadow: var(--shadow); z-index: 10; overflow: hidden; }
    .preview-head { display: flex; align-items: center; gap: 6px; padding: 8px 10px 8px 14px; border-bottom: 1px solid var(--border); font-size: var(--fs-sm); }
    .preview pre { margin: 0; padding: 12px 14px; overflow: auto; font-size: 12px; line-height: 1.55; user-select: text; white-space: pre-wrap; }
    .foot { padding: 3px 12px; border-top: 1px solid var(--border); font-size: 11px; color: var(--text-faint); background: var(--bg); flex: none; }
    :host ::ng-deep .null { color: var(--null); font-style: italic; }
    :host ::ng-deep .default { color: var(--text-faint); font-style: italic; }
    :host ::ng-deep .num { text-align: right; font-variant-numeric: tabular-nums; }
    :host ::ng-deep .changed { background: var(--accent-soft) !important; box-shadow: inset 2px 0 0 var(--accent); }
    :host ::ng-deep .row-new { background: color-mix(in srgb, var(--accent) 8%, transparent); }
    :host ::ng-deep .row-deleted .ag-cell { text-decoration: line-through; color: var(--danger); opacity: 0.75; }
    :host ::ng-deep .rownum { color: var(--text-faint); text-align: right; background: var(--bg); }
  `,
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

  readonly tab = input.required<EditorTab>();
  readonly theme = gridTheme;
  readonly mod = MOD;
  readonly sizes = PAGE_SIZES;
  readonly refreshChoices = REFRESH_SECONDS;
  /** Click-and-drag selects a block of cells, like a spreadsheet. */

  where = '';
  orderBy = '';
  readonly page = signal<TablePage | null>(null);
  readonly offset = signal(0);
  readonly limit = signal(100);
  readonly loading = signal(false);
  readonly applying = signal(false);
  readonly error = signal('');
  readonly previewOpen = signal(false);
  readonly searchOpen = signal(false);
  readonly quick = signal('');
  readonly copyMenu = signal<{ x: number; y: number } | null>(null);
  readonly cellMenu = signal<{ x: number; y: number; row: GridRow; colIndex: number; value: Cell | undefined } | null>(null);
  readonly sizeMenu = signal<{ x: number; y: number } | null>(null);
  readonly formats = COPY_FORMATS;
  readonly totalCount = signal<number | null>(null);
  readonly counting = signal(false);
  readonly autoMenu = signal<{ x: number; y: number } | null>(null);
  readonly autoRefresh = signal(false);
  readonly refreshSeconds = signal(REFRESH_SECONDS[0]);
  private refreshTimer?: ReturnType<typeof setInterval>;
  /** Sort chosen from a column header; typing an ORDER BY replaces it. */
  private sortState = signal<{ col: string; dir: 'asc' | 'desc' } | null>(null);

  private rows: GridRow[] = [];
  private deleted = new Set<string>();
  private version = signal(0); // bumped on every edit so computed values refresh
  private grid?: GridApi<GridRow>;
  private seq = 0;

  private kind = computed<DbKind>(() => this.conns.get(this.tab().connId)?.kind ?? 'postgres');

  readonly pending = computed(() => {
    this.version();
    return this.rows.filter((r) => r.isNew || this.deleted.has(r.id) || rowChanged(r)).length;
  });

  readonly preview = computed(() => {
    this.version();
    const p = this.page();
    const t = this.tab().table;
    if (!p || !t) return [];
    const k = this.kind();
    return previewSQL(buildChanges(p.columns, this.rows, this.deleted), qualified(k, t.schema, t.name), (n) => ident(k, n));
  });

  readonly rangeText = computed(() => {
    const p = this.page();
    if (!p) return '';
    if (!p.rows.length) return 'No rows';
    const from = (this.offset() + 1).toLocaleString();
    const to = (this.offset() + p.rows.length).toLocaleString();
    const total = this.totalCount();
    if (total !== null) return `${from}–${to} of ${total.toLocaleString()}`;
    return `${from}–${to}${p.hasMore ? '+' : ''}`;
  });

  readonly defaultColDef: ColDef<GridRow> = {
    sortable: false, // sorting happens in SQL so it covers every page
    resizable: true,
    minWidth: 80,
    suppressHeaderMenuButton: true,
    cellClassRules: rangeClassRules(() => this.range),
  };
  /** Drag selection of a block of cells (AG Grid's own is Enterprise only). */
  private range?: CellRangeSelection<GridRow>;
  private host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly rowId = (p: { data: GridRow }) => p.data.id;
  readonly rowClassRules = {
    'row-new': (p: { data?: GridRow }) => !!p.data?.isNew,
    'row-deleted': (p: { data?: GridRow }) => !!p.data && this.deleted.has(p.data.id),
  };

  constructor() {
    effect(() => {
      const n = this.pending();
      untracked(() => {
        this.tabs.setDirty(this.tab().id, n > 0);
        if (!n) this.previewOpen.set(false);
      });
    });
  }

  onReady(e: GridReadyEvent<GridRow>) {
    this.grid = e.api;
    this.range = new CellRangeSelection(e.api, this.host.nativeElement, '__row');
    this.bridge.attach(this.tab().id, this);
    void this.reload(0);
  }

  ngOnDestroy() {
    this.range?.destroy();
    this.stopAutoRefresh();
    this.bridge.detach(this.tab().id);
  }

  openAutoMenu(e: MouseEvent) {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    this.autoMenu.set(clampMenu(rect.left, rect.bottom + 4, 170, 40 + (REFRESH_SECONDS.length + 1) * 26));
  }

  setAutoRefresh(seconds: number) {
    this.autoMenu.set(null);
    if (seconds > 0) this.refreshSeconds.set(seconds);
    this.autoRefresh.set(seconds > 0);
    this.startAutoRefresh();
  }

  label(seconds: number) { return seconds === 60 ? 'minute' : `${seconds} s`; }
  autoLabel() { return this.label(this.refreshSeconds()); }

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

  setLimit(n: number) {
    this.sizeMenu.set(null);
    this.limit.set(n);
    void this.reload(0);
  }

  openSizeMenu(e: MouseEvent) {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    this.sizeMenu.set(clampMenu(rect.right - 140, rect.bottom + 4, 140, 40 + PAGE_SIZES.length * 26));
  }

  refresh() { void this.reload(this.offset()); }

  onOrderByEnter() {
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

  async reload(offset: number, silent = false) {
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
  async countRows() {
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
      valueFormatter: (v) => (v.value === undefined ? 'DEFAULT' : display(v.value as Cell)),
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
    this.orderBy = next ? `${ident(this.kind(), col)} ${next.toUpperCase()}` : '';
    void this.reload(0);
  }

  /** Header filter icon: starts a condition on that column in the WHERE box. */
  private filterOn(col: string) {
    const cond = `${ident(this.kind(), col)} = `;
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

  addRow() {
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
  deleteRows() {
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

  setNull() {
    const api = this.grid;
    const f = api?.getFocusedCell();
    if (!api || !f || f.column.getColId() === '__row') return;
    const node = api.getDisplayedRowAtIndex(f.rowIndex);
    const def = f.column.getColDef();
    if (!node?.data || !(typeof def.editable === 'function' ? def.editable({ data: node.data } as any) : def.editable)) return;
    node.setDataValue(f.column, null);
  }

  revert() {
    const p = this.page();
    if (p) this.setPage(p);
  }

  togglePreview() {
    this.grid?.stopEditing();
    this.previewOpen.update((v) => !v);
  }

  copyPreview() { void this.cmds.copy(this.preview().join('\n\n')); }

  toggleSearch() {
    const open = !this.searchOpen();
    this.searchOpen.set(open);
    if (open) setTimeout(() => this.searchInput()?.nativeElement.focus());
    else this.setQuick('');
  }

  setQuick(q: string) {
    this.quick.set(q);
    this.grid?.setGridOption('quickFilterText', q);
  }

  copyPage(format: CopyFormat = 'tsv') {
    const p = this.page();
    if (!p) return;
    this.copyMenu.set(null);
    void this.cmds.copy(formatRows(format, p.columns, this.rows.filter((r) => !r.isNew).map((r) => r.cells as Cell[]), true));
  }

  copySelected(format: CopyFormat) {
    const p = this.page();
    if (!p) return;
    this.copyMenu.set(null);
    const sel = this.selectionData();
    const rows = sel ? sel.rows : this.selectionRows().map((r) => r.cells.map((v) => v ?? null) as Cell[]);
    if (!rows.length) return;
    void this.cmds.copy(formatRows(format, sel ? sel.columns : p.columns, rows, true));
  }

  openCopyMenu(e: MouseEvent) {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    this.copyMenu.set(clampMenu(rect.right - 210, rect.bottom + 4, 210, 360));
  }

  // ---------- cell context menu ----------

  onCellMenu(e: CellContextMenuEvent<GridRow>) {
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

  selectedCount(): number { return this.selectionRows().length; }

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

  onCellKey(e: CellKeyDownEvent<GridRow> | FullWidthCellKeyDownEvent<GridRow>) {
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

  canNullCell() {
    const m = this.cellMenu();
    return !!m && this.cellEditable() && m.value !== null;
  }

  cellChanged() {
    const m = this.cellMenu();
    return !!m && m.colIndex >= 0 && !m.row.isNew && isChanged(m.row, m.colIndex);
  }

  cellRowDeleted() {
    const m = this.cellMenu();
    return !!m && this.deleted.has(m.row.id);
  }

  copyCellValue() {
    const m = this.cellMenu();
    if (!m || m.colIndex < 0) return;
    this.cellMenu.set(null);
    void this.cmds.copy(m.value === null || m.value === undefined ? '' : String(m.value));
  }

  copyCellColumn() {
    const c = this.menuColumn();
    this.cellMenu.set(null);
    if (c) void this.cmds.copy(c.name);
  }

  copyCellRow() {
    const m = this.cellMenu();
    const p = this.page();
    if (!m || !p) return;
    this.cellMenu.set(null);
    void this.cmds.copy(formatRows('tsv', p.columns, [m.row.cells.map((v) => v ?? null) as Cell[]], true));
  }

  copyCellSelection() {
    this.cellMenu.set(null);
    this.copySelected('tsv');
  }

  /** Starts a WHERE condition on the clicked column with the clicked value. */
  filterByCell() {
    const m = this.cellMenu();
    const c = this.menuColumn();
    if (!m || !c || m.value === undefined) return;
    const id = ident(this.kind(), c.name);
    let cond: string;
    if (m.value === null) cond = `${id} IS NULL`;
    else if (typeof m.value === 'number') cond = `${id} = ${m.value}`;
    else if (typeof m.value === 'boolean') cond = `${id} = ${m.value ? 'TRUE' : 'FALSE'}`;
    else cond = `${id} = '${String(m.value).replace(/'/g, "''")}'`;
    this.where = cond;
    this.cellMenu.set(null);
    void this.reload(0);
  }

  setCellNull() {
    const m = this.cellMenu();
    if (!m || !this.cellEditable()) return;
    this.cellMenu.set(null);
    this.grid?.getRowNode(m.row.id)?.setDataValue(`c${m.colIndex}`, null);
  }

  revertCell() {
    const m = this.cellMenu();
    if (!m || !this.cellChanged()) return;
    this.cellMenu.set(null);
    this.setCell(m.row, m.colIndex, m.row.orig[m.colIndex]);
    const node = this.grid?.getRowNode(m.row.id);
    if (node) this.grid?.refreshCells({ rowNodes: [node] });
  }

  deleteCellRow() {
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

  ddl() {
    const t = this.tab();
    if (t.table) void this.cmds.showDDL(t.connId, { schema: t.table.schema, name: t.table.name, type: t.table.type as 'table' | 'view' }, t.database);
  }

  async apply() {
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
