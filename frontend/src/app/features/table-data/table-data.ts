import { Component, ElementRef, OnDestroy, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AgGridAngular } from 'ag-grid-angular';
import type { CellClassParams, ColDef, GridApi, GridReadyEvent, ValueSetterParams } from 'ag-grid-community';
import { Api, errorText } from '../../core/api';
import { Commands } from '../../core/commands';
import { ConnectionStore } from '../../core/connection.store';
import { TabStore, type EditorTab } from '../../core/tab.store';
import { TableBridge, type TableHandle } from '../../core/table-bridge';
import { Toasts } from '../../core/toast';
import { TxStore } from '../../core/tx.store';
import { MOD } from '../../core/ui';
import { ident, qualified } from '../../core/sql';
import type { Cell, DbKind, TablePage } from '../../core/models';
import { Icon } from '../../shared/icon';
import { ClickOutside, clampMenu } from '../../shared/click-outside';
import { display, gridTheme } from '../results/result-grid';
import { COPY_FORMATS, formatRows, type CopyFormat } from '../results/copy';
import { buildChanges, isChanged, normalizeEdit, previewSQL, rowChanged, type GridRow } from './changes';
import { ColumnHeader, type ColumnHeaderParams } from './column-header';

const PAGE_SIZES = [100, 500, 1000];

/** Editable view of one table: paging, filter, sort, and pending edits applied in one transaction. */
@Component({
  selector: 'dm-table-data',
  imports: [FormsModule, AgGridAngular, Icon, ClickOutside],
  template: `
    <div class="toolbar" role="toolbar" aria-label="Table data">
      <button class="ib" (click)="refresh()" [disabled]="loading()" [title]="'Reload (' + mod + '↵)'" aria-label="Reload"><dm-icon name="refresh" /></button>
      <span class="sep"></span>

      @let p = page();
      @let can = !!p?.editable;
      <button class="ib" (click)="addRow()" [disabled]="!can" title="Add row" aria-label="Add row"><dm-icon name="plus" /></button>
      <button class="ib" (click)="deleteRows()" [disabled]="!can" title="Delete selected rows (again to restore)" aria-label="Delete rows"><dm-icon name="minus" /></button>
      <button class="ib" (click)="revert()" [disabled]="!pending()" title="Revert all pending changes" aria-label="Revert"><dm-icon name="undo" /></button>
      <button class="ib" (click)="togglePreview()" [disabled]="!pending()" [class.on]="previewOpen()" title="Preview pending changes" aria-label="Preview changes"><dm-icon name="eye" /></button>
      <button class="ib submit" (click)="apply()" [disabled]="!pending() || applying()" [class.ready]="pending()"
              [title]="'Submit changes (' + mod + 'S)'" aria-label="Submit changes">
        <dm-icon name="submit" />
        @if (pending()) { <span class="count">{{ pending() }}</span> }
      </button>
      <span class="sep"></span>

      <button class="ib" (click)="setNull()" [disabled]="!can" title="Set the focused cell to NULL" aria-label="Set NULL"><dm-icon name="null" /></button>
      <button class="tb" (click)="ddl()" title="Open the table's DDL in a new tab">DDL</button>
      <button class="ib" (click)="toggleSearch()" [class.on]="searchOpen()" title="Search in this page" aria-label="Search in page"><dm-icon name="search" /></button>
      @if (searchOpen()) {
        <input #search class="search mono" placeholder="Find in page…" [ngModel]="quick()" (ngModelChange)="setQuick($event)"
               (keydown.escape)="toggleSearch()" spellcheck="false" />
      }
      <button class="ib" (click)="openCopyMenu($event)" [disabled]="!p?.rows?.length" title="Copy rows…" aria-label="Copy rows"><dm-icon name="copy" /></button>

      <span class="spacer"></span>
      @if (p && !p.editable) { <span class="ro" [title]="p.readOnly ?? ''">🔒 {{ p.readOnly }}</span> }
      @if (p) {
        <span class="range">{{ rangeText() }}</span>
        <button class="ib" (click)="reload(offset() - limit())" [disabled]="offset() === 0 || loading()" title="Previous page" aria-label="Previous page"><dm-icon name="left" /></button>
        <button class="ib" (click)="reload(offset() + limit())" [disabled]="!p.hasMore || loading()" title="Next page" aria-label="Next page"><dm-icon name="right" /></button>
        <select class="size" [ngModel]="limit()" (ngModelChange)="setLimit($event)" aria-label="Rows per page">
          @for (n of sizes; track n) { <option [ngValue]="n">{{ n }} rows</option> }
        </select>
      }
    </div>

    <div class="clauses">
      <label class="clause">
        <dm-icon name="filter" [size]="14" />
        <input #whereInput class="mono" [(ngModel)]="where" placeholder="WHERE" (keydown.enter)="reload(0)" spellcheck="false" aria-label="WHERE clause" />
      </label>
      <label class="clause">
        <dm-icon name="sort" [size]="14" />
        <input class="mono" [(ngModel)]="orderBy" placeholder="ORDER BY" (keydown.enter)="onOrderByEnter()" spellcheck="false" aria-label="ORDER BY clause" />
      </label>
    </div>

    @if (error(); as e) {
      <div class="error" role="alert"><span>{{ e }}</span><button class="ib" (click)="error.set('')" aria-label="Dismiss"><dm-icon name="x" [size]="14" /></button></div>
    }

    <div class="grid-wrap">
      <ag-grid-angular
        class="grid"
        [theme]="theme"
        [defaultColDef]="defaultColDef"
        [rowSelection]="{ mode: 'multiRow', checkboxes: false, headerCheckbox: false, enableClickSelection: true }"
        [getRowId]="rowId"
        [rowClassRules]="rowClassRules"
        [stopEditingWhenCellsLoseFocus]="true"
        [undoRedoCellEditing]="true"
        [animateRows]="false"
        [tooltipShowDelay]="400"
        [headerHeight]="32"
        (gridReady)="onReady($event)"
      />
      @if (loading()) { <div class="loading"><span class="spinner"></span></div> }

      @if (previewOpen() && pending()) {
        <div class="preview" (dmClickOutside)="previewOpen.set(false)">
          <div class="preview-head">
            <b>{{ pending() }} pending change{{ pending() === 1 ? '' : 's' }}</b>
            <span class="muted">· {{ tab().txMode === 'manual' ? 'added to the open transaction' : 'applied and committed in one transaction' }}</span>
            <span class="spacer"></span>
            <button class="btn sm" (click)="copyPreview()">Copy SQL</button>
            <button class="btn sm primary" (click)="apply()" [disabled]="applying()">Submit</button>
          </div>
          <pre class="mono">{{ preview().join('\\n\\n') }}</pre>
        </div>
      }

      @if (copyMenu(); as m) {
        <div class="menu" [style.left.px]="m.x" [style.top.px]="m.y" (dmClickOutside)="copyMenu.set(null)">
          <div class="menu-label">Copy this page</div>
          @for (f of formats; track f.id) {
            <button class="menu-item" (click)="copyPage(f.id)">{{ f.label }}</button>
          }
          <div class="menu-sep"></div>
          <div class="menu-label">Copy selected rows</div>
          @for (f of formats; track f.id) {
            <button class="menu-item" (click)="copySelected(f.id)">{{ f.label }}</button>
          }
        </div>
      }
    </div>

    @if (p) {
      <div class="foot mono ellipsis" [title]="p.sql">{{ p.sql }} · {{ p.durationMs }} ms</div>
    }
  `,
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
    .range { font-size: var(--fs-xs); color: var(--text-muted); font-variant-numeric: tabular-nums; margin-right: 2px; white-space: nowrap; }
    .size { height: 26px; margin-left: 4px; padding: 0 4px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-panel); font-size: var(--fs-xs); color: var(--text-muted); }
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
  private whereInput = viewChild<ElementRef<HTMLInputElement>>('whereInput');
  private searchInput = viewChild<ElementRef<HTMLInputElement>>('search');

  readonly tab = input.required<EditorTab>();
  readonly theme = gridTheme;
  readonly mod = MOD;
  readonly sizes = PAGE_SIZES;

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
  readonly formats = COPY_FORMATS;
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
    return `${(this.offset() + 1).toLocaleString()}–${(this.offset() + p.rows.length).toLocaleString()}${p.hasMore ? '+' : ''}`;
  });

  readonly defaultColDef: ColDef<GridRow> = {
    sortable: false, // sorting happens in SQL so it covers every page
    resizable: true,
    minWidth: 80,
    suppressHeaderMenuButton: true,
  };

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
    this.bridge.attach(this.tab().id, this);
    void this.reload(0);
  }

  ngOnDestroy() { this.bridge.detach(this.tab().id); }

  setLimit(n: number) {
    this.limit.set(n);
    void this.reload(0);
  }

  refresh() { void this.reload(this.offset()); }

  onOrderByEnter() {
    this.sortState.set(null);
    void this.reload(0);
  }

  async reload(offset: number) {
    if (this.pending() && !confirm(`Discard ${this.pending()} pending change(s)?`)) return;
    const t = this.tab();
    if (!t.table) return;
    if (!(await this.conns.ensureConnected(t.connId))) return;
    this.loading.set(true);
    this.error.set('');
    try {
      const { page: p, tx } = await this.api.readTable(t.id, t.connId, t.database, t.txMode === 'manual', {
        schema: t.table.schema, table: t.table.name, type: t.table.type,
        where: this.where, orderBy: this.orderBy, offset: Math.max(0, offset), limit: this.limit(),
      });
      this.tx.set(t.id, tx);
      this.offset.set(p.offset);
      this.setPage(p);
    } catch (e) {
      this.error.set(errorText(e));
    } finally {
      this.loading.set(false);
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
      api.ensureIndexVisible(0, 'top');
      api.setFocusedCell(0, `c${first}`);
      api.startEditingCell({ rowIndex: 0, colKey: `c${first}` });
    }
  }

  /** Marks the selected rows (or the focused one) as deleted; a second click restores them. */
  deleteRows() {
    const api = this.grid;
    if (!api) return;
    let nodes = api.getSelectedNodes();
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
    const rows = (this.grid?.getSelectedRows() as GridRow[] | undefined) ?? [];
    void this.cmds.copy(formatRows(format, p.columns, rows.map((r) => r.cells.map((v) => v ?? null) as Cell[]), true));
  }

  openCopyMenu(e: MouseEvent) {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    this.copyMenu.set(clampMenu(rect.right - 210, rect.bottom + 4, 210, 360));
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
