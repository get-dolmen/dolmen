import type { CellClassParams, Column, GridApi } from 'ag-grid-community';

interface Corner { row: number; col: string }

const EDGE = 24;       // px from the grid body edge where dragging starts to scroll
const SCROLL_MS = 40;  // auto-scroll step while the pointer stays past the edge
const NAV_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Tab']);

/**
 * Class rules for a column definition, usable before the grid (and so the
 * selection) exists: they read the selection through `get`. Only the
 * row-number cells are marked; the block itself is drawn as one overlay.
 */
export function rangeClassRules<T>(get: () => CellRangeSelection<T> | undefined): Record<string, (p: CellClassParams<T>) => boolean> {
  return { 'rg-row': (p) => get()?.marksRow(p) ?? false };
}

/**
 * Spreadsheet-style rectangular cell selection for AG Grid Community, whose
 * built-in cell selection is an Enterprise feature.
 *
 * Drag across cells to select a block, Shift+click or Shift+arrows to extend
 * it, drag over the row-number column to take whole rows, ⌘A / Ctrl+A for
 * everything. Arrow keys move a one-cell selection with the grid's focus.
 *
 * The block is one rectangle inside the grid's scrolling content, so it
 * scrolls natively and has no seams between rows. Mouse handling uses DOM
 * events: the grid's cellMouseDown / cellMouseOver arrive asynchronously,
 * after later input.
 */
export class CellRangeSelection<T> {
  private anchor?: Corner;
  private focus?: Corner;
  private dragging = false;
  private wholeRows = false;
  private pointer = { x: 0, y: 0 };
  private scrollTimer?: ReturnType<typeof setInterval>;
  private readonly box = document.createElement('div');
  private readonly cleanup: (() => void)[] = [];

  constructor(
    private api: GridApi<T>,
    private host: HTMLElement,
    /** Column id of the row-number column: dragging over it selects whole rows. */
    private rowNumberCol: string,
  ) {
    this.box.className = 'rg-box';
    this.box.hidden = true;

    const listen = <K extends keyof HTMLElementEventMap>(el: HTMLElement | Document, type: K, fn: (e: HTMLElementEventMap[K]) => void, capture = false) => {
      el.addEventListener(type, fn as EventListener, capture);
      this.cleanup.push(() => el.removeEventListener(type, fn as EventListener, capture));
    };
    listen(host, 'mousedown', (e) => this.onDown(e));
    listen(host, 'mouseover', (e) => this.onOver(e));
    listen(host, 'keydown', (e) => this.onKey(e), true);
    listen(document, 'mouseup', () => this.endDrag());
    listen(document, 'mousemove', (e) => { this.pointer = { x: e.clientX, y: e.clientY }; });

    // Row indexes change meaning when the rows are re-sorted, filtered or replaced.
    const reset = () => this.clear();
    const place = () => this.place();
    const events = { sortChanged: reset, filterChanged: reset, rowDataUpdated: reset, columnResized: place, columnMoved: place, displayedColumnsChanged: place, bodyScroll: place } as const;
    for (const [type, fn] of Object.entries(events)) api.addEventListener(type as 'sortChanged', fn);
    this.cleanup.push(() => {
      if (api.isDestroyed()) return;
      for (const [type, fn] of Object.entries(events)) api.removeEventListener(type as 'sortChanged', fn);
    });
  }

  get active(): boolean { return !!this.anchor && !!this.focus; }

  /** First and last displayed row index of the selection ([-1, -1] when empty). */
  rows(): [number, number] {
    if (!this.anchor || !this.focus) return [-1, -1];
    return [Math.min(this.anchor.row, this.focus.row), Math.max(this.anchor.row, this.focus.row)];
  }

  /** Selected data columns, in display order. */
  columns(): Column[] {
    if (!this.anchor || !this.focus) return [];
    const cols = this.dataColumns();
    const a = cols.findIndex((c) => c.getColId() === this.anchor!.col);
    const b = cols.findIndex((c) => c.getColId() === this.focus!.col);
    if (a < 0 || b < 0) return [];
    return cols.slice(Math.min(a, b), Math.max(a, b) + 1);
  }

  /** True when the selection is a single cell. */
  isSingleCell(): boolean {
    const [from, to] = this.rows();
    return this.active && from === to && this.columns().length === 1;
  }

  /** Whether a cell is in the selection. */
  contains(rowIndex: number | null, colId: string): boolean {
    const [from, to] = this.rows();
    return rowIndex !== null && rowIndex >= from && rowIndex <= to && this.columns().some((c) => c.getColId() === colId);
  }

  /** Row-number cells of the selected rows are highlighted. */
  marksRow(p: CellClassParams<T>): boolean {
    const [from, to] = this.rows();
    const i = p.node.rowIndex;
    return p.column.getColId() === this.rowNumberCol && i !== null && i >= from && i <= to;
  }

  clear() {
    if (!this.active) return;
    this.anchor = this.focus = undefined;
    this.repaint();
  }

  /** Selects every displayed cell. */
  selectAll() {
    const cols = this.dataColumns();
    const last = this.api.getDisplayedRowCount() - 1;
    if (!cols.length || last < 0) return;
    this.anchor = { row: 0, col: cols[0].getColId() };
    this.focus = { row: last, col: cols.at(-1)!.getColId() };
    this.repaint();
  }

  destroy() {
    this.stopScroll();
    this.box.remove();
    for (const c of this.cleanup) c();
  }

  private dataColumns(): Column[] {
    return this.api.getAllDisplayedColumns().filter((c) => c.getColId() !== this.rowNumberCol);
  }

  /** The cell under a DOM event: its displayed row index and column id. */
  private cellAt(target: EventTarget | null): Corner | null {
    const cell = (target as HTMLElement | null)?.closest?.('.ag-cell');
    const row = cell?.closest('.ag-row');
    if (!cell || !row || !this.host.contains(cell)) return null;
    // Clicks inside an open editor are the editor's.
    if (cell.classList.contains('ag-cell-inline-editing')) return null;
    const index = Number(row.getAttribute('row-index'));
    const col = cell.getAttribute('col-id');
    return Number.isInteger(index) && index >= 0 && col ? { row: index, col } : null;
  }

  private onDown(ev: MouseEvent) {
    const at = this.cellAt(ev.target);
    if (!at) return;
    const cols = this.dataColumns();
    if (!cols.length) return;
    if (ev.button === 2) {
      // Right-click keeps the block it lands in, else selects the cell under it.
      if (!this.contains(at.row, at.col) && !(at.col === this.rowNumberCol && this.rowSelected(at.row))) {
        this.select(at, cols);
      }
      return;
    }
    if (ev.button !== 0) return;
    if (ev.shiftKey && this.anchor) {
      this.focus = at.col === this.rowNumberCol ? { row: at.row, col: this.focus!.col } : at;
    } else {
      this.select(at, cols);
    }
    this.wholeRows = at.col === this.rowNumberCol;
    this.dragging = true;
    this.pointer = { x: ev.clientX, y: ev.clientY };
    this.stopScroll();
    this.scrollTimer = setInterval(() => this.autoScroll(), SCROLL_MS);
    this.repaint();
  }

  /** A cell, or the whole row when it is a row number. */
  private select(at: Corner, cols: Column[]) {
    if (at.col === this.rowNumberCol) {
      this.anchor = { row: at.row, col: cols[0].getColId() };
      this.focus = { row: at.row, col: cols.at(-1)!.getColId() };
    } else {
      this.anchor = this.focus = at;
    }
    this.repaint();
  }

  private rowSelected(row: number): boolean {
    const [from, to] = this.rows();
    return row >= from && row <= to && this.columns().length === this.dataColumns().length;
  }

  private onOver(ev: MouseEvent) {
    if (!this.dragging || !this.anchor) return;
    const at = this.cellAt(ev.target);
    if (!at) return;
    const col = this.wholeRows ? this.focus!.col : at.col;
    if (col === this.rowNumberCol) return;
    if (this.focus?.row === at.row && this.focus.col === col) return;
    this.focus = { row: at.row, col };
    this.repaint();
  }

  private endDrag() {
    if (!this.dragging) return;
    this.dragging = false;
    this.stopScroll();
  }

  private stopScroll() {
    if (this.scrollTimer) clearInterval(this.scrollTimer);
    this.scrollTimer = undefined;
  }

  /** While dragging past an edge of the grid body, scroll and grow the selection. */
  private autoScroll() {
    if (!this.dragging || !this.focus) return;
    const viewport = this.viewport() ?? this.host;
    const box = viewport.getBoundingClientRect();
    const header = this.host.querySelector<HTMLElement>('.ag-header');
    const top = Math.max(box.top, header?.getBoundingClientRect().bottom ?? box.top);
    const { x, y } = this.pointer;
    let row = this.focus.row;
    let col = this.focus.col;
    const lastRow = this.api.getDisplayedRowCount() - 1;
    if (y > box.bottom - EDGE) row = Math.min(lastRow, row + 1);
    else if (y < top + EDGE) row = Math.max(0, row - 1);
    if (!this.wholeRows) {
      const cols = this.dataColumns();
      const i = cols.findIndex((c) => c.getColId() === col);
      if (x > box.right - EDGE && i < cols.length - 1) col = cols[i + 1].getColId();
      else if (x < box.left + this.pinnedWidth() + EDGE && i > 0) col = cols[i - 1].getColId();
    }
    if (row === this.focus.row && col === this.focus.col) return;
    this.focus = { row, col };
    this.api.ensureIndexVisible(row);
    this.api.ensureColumnVisible(col);
    this.repaint();
  }

  private onKey(e: KeyboardEvent) {
    if (this.api.getEditingCells().length) return;
    const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? e.metaKey : e.ctrlKey;
    if (mod && !e.shiftKey && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      e.stopPropagation();
      this.selectAll();
    } else if (NAV_KEYS.has(e.key) && !mod && !e.altKey) {
      // Follow the grid's focus once it has moved: Shift extends the block.
      const extend = e.shiftKey && e.key !== 'Tab' && this.anchor;
      if (extend) e.preventDefault(); // the grid would select rows instead
      const from = this.focus;
      setTimeout(() => {
        const f = this.api.getFocusedCell();
        if (!f || f.rowIndex === null) return;
        let at: Corner = { row: f.rowIndex, col: f.column.getColId() };
        if (extend && from) {
          at = this.step(from, e.key) ?? from;
          this.api.ensureIndexVisible(at.row);
          this.api.ensureColumnVisible(at.col);
          this.focus = at;
        } else if (at.col !== this.rowNumberCol) {
          this.anchor = this.focus = at;
        }
        this.repaint();
      });
    }
  }

  /** The cell next to `from` in the direction of an arrow key. */
  private step(from: Corner, key: string): Corner | null {
    const cols = this.dataColumns();
    const i = cols.findIndex((c) => c.getColId() === from.col);
    const last = this.api.getDisplayedRowCount() - 1;
    switch (key) {
      case 'ArrowUp': return { row: Math.max(0, from.row - 1), col: from.col };
      case 'ArrowDown': return { row: Math.min(last, from.row + 1), col: from.col };
      case 'ArrowLeft': return i > 0 ? { row: from.row, col: cols[i - 1].getColId() } : from;
      case 'ArrowRight': return i < cols.length - 1 ? { row: from.row, col: cols[i + 1].getColId() } : from;
      default: return null;
    }
  }

  private viewport(): HTMLElement | null {
    return this.host.querySelector<HTMLElement>('.ag-body-viewport, .ag-grid-viewport');
  }

  /** Width of the left-pinned columns (the row numbers). */
  private pinnedWidth(): number {
    return this.api.getAllDisplayedColumns().filter((c) => c.getPinned() === 'left').reduce((w, c) => w + c.getActualWidth(), 0);
  }

  private repaint() {
    this.place();
    this.host.classList.toggle('rg-active', this.active);
    // Only the row-number marks need the grid (a few dozen rendered cells).
    this.api.refreshCells({ columns: [this.rowNumberCol] });
  }

  /**
   * Positions the block over its cells. It lives in the container that holds
   * the rows, so it scrolls with them; it is clipped where it would pass
   * under the pinned row numbers.
   */
  private place() {
    const cols = this.columns();
    const [from, to] = this.rows();
    const first = from >= 0 ? this.api.getDisplayedRowAtIndex(from) : undefined;
    const last = to >= 0 ? this.api.getDisplayedRowAtIndex(to) : undefined;
    const container = this.host.querySelector<HTMLElement>('.ag-grid-scrolling-container, .ag-center-cols-container');
    if (!cols.length || !first || !last || first.rowTop === null || last.rowTop === null || !container) {
      this.box.hidden = true;
      return;
    }
    if (this.box.parentElement !== container) container.appendChild(this.box);
    const pinned = this.pinnedWidth();
    // Rows that hold pinned and scrolling cells together place the scrolling
    // ones after the pinned width; older layouts have a separate container.
    const offset = container.classList.contains('ag-grid-scrolling-container') ? pinned : 0;
    const left = offset + cols[0].getLeft()!;
    const right = offset + cols.at(-1)!.getLeft()! + cols.at(-1)!.getActualWidth();
    const top = first.rowTop;
    const bottom = last.rowTop + (last.rowHeight ?? 0);
    const scrollLeft = offset ? this.viewport()?.scrollLeft ?? 0 : 0;
    const hidden = Math.max(0, scrollLeft + pinned - left); // part under the pinned columns
    Object.assign(this.box.style, {
      left: `${left}px`, top: `${top}px`, width: `${right - left}px`, height: `${bottom - top}px`,
      clipPath: hidden ? `inset(-2px -2px -2px ${hidden}px)` : '',
    });
    this.box.hidden = false;
  }
}
