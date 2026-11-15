import type { CellClassParams, Column, GridApi } from 'ag-grid-community';

interface CellPosition { row: number; columnId: string }

const AUTO_SCROLL_EDGE = 24;       // px from the grid body edge where dragging starts to scroll
const AUTO_SCROLL_INTERVAL_MS = 40;  // auto-scroll step while the pointer stays past the edge
const NAVIGATION_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Tab']);

/**
 * Class rules for a column definition, usable before the grid (and so the
 * selection) exists: they read the selection through `get`. Only the
 * row-number cells are marked; the block itself is drawn as one overlay.
 */
export function rangeClassRules<T>(
  selection: () => CellRangeSelection<T> | undefined,
): Record<string, (params: CellClassParams<T>) => boolean> {
  return { 'rg-row': (params) => selection()?.marksRow(params) ?? false };
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
  private anchor?: CellPosition;
  private focus?: CellPosition;
  private isDragging = false;
  private wholeRows = false;
  private pointerPosition = { x: 0, y: 0 };
  private autoScrollTimer?: ReturnType<typeof setInterval>;
  private readonly selectionBox = document.createElement('div');
  private readonly cleanupCallbacks: (() => void)[] = [];

  public constructor(
    private gridApi: GridApi<T>,
    private hostElement: HTMLElement,
    /** Column id of the row-number column: dragging over it selects whole rows. */
    private rowNumberColumnId: string,
  ) {
    this.selectionBox.className = 'rg-box';
    this.selectionBox.hidden = true;

    const listen = <K extends keyof HTMLElementEventMap>(
      element: HTMLElement | Document,
      type: K,
      listener: (event: HTMLElementEventMap[K]) => void,
      capture = false,
    ) => {
      element.addEventListener(type, listener as EventListener, capture);
      this.cleanupCallbacks.push(() => element.removeEventListener(type, listener as EventListener, capture));
    };
    listen(hostElement, 'mousedown', (event) => this.onMouseDown(event));
    listen(hostElement, 'mouseover', (event) => this.onMouseOver(event));
    listen(hostElement, 'keydown', (event) => this.onKeyDown(event), true);
    listen(document, 'mouseup', () => this.endDrag());
    listen(document, 'mousemove', (event) => {
      this.pointerPosition = { x: event.clientX, y: event.clientY };
    });

    // Row indexes change meaning when the rows are re-sorted, filtered or replaced.
    const resetSelection = () => this.clear();
    const placeBox = () => this.placeSelectionBox();
    const gridEvents = {
      sortChanged: resetSelection,
      filterChanged: resetSelection,
      rowDataUpdated: resetSelection,
      columnResized: placeBox,
      columnMoved: placeBox,
      displayedColumnsChanged: placeBox,
      bodyScroll: placeBox,
    } as const;
    for (const [type, listener] of Object.entries(gridEvents)) gridApi.addEventListener(type as 'sortChanged', listener);
    this.cleanupCallbacks.push(() => {
      if (gridApi.isDestroyed()) return;
      for (const [type, listener] of Object.entries(gridEvents)) gridApi.removeEventListener(type as 'sortChanged', listener);
    });
  }

  public get active(): boolean { return !!this.anchor && !!this.focus; }

  /** First and last displayed row index of the selection ([-1, -1] when empty). */
  public rows(): [number, number] {
    if (!this.anchor || !this.focus) return [-1, -1];
    return [Math.min(this.anchor.row, this.focus.row), Math.max(this.anchor.row, this.focus.row)];
  }

  /** Selected data columns, in display order. */
  public columns(): Column[] {
    if (!this.anchor || !this.focus) return [];
    const columns = this.dataColumns();
    const anchorIndex = columns.findIndex((column) => column.getColId() === this.anchor!.columnId);
    const focusIndex = columns.findIndex((column) => column.getColId() === this.focus!.columnId);
    if (anchorIndex < 0 || focusIndex < 0) return [];
    return columns.slice(Math.min(anchorIndex, focusIndex), Math.max(anchorIndex, focusIndex) + 1);
  }

  /** True when the selection is a single cell. */
  public isSingleCell(): boolean {
    const [firstRow, lastRow] = this.rows();
    return this.active && firstRow === lastRow && this.columns().length === 1;
  }

  /** Whether a cell is in the selection. */
  public contains(rowIndex: number | null, columnId: string): boolean {
    const [firstRow, lastRow] = this.rows();
    return rowIndex !== null && rowIndex >= firstRow && rowIndex <= lastRow
      && this.columns().some((column) => column.getColId() === columnId);
  }

  /** Row-number cells of the selected rows are highlighted. */
  public marksRow(params: CellClassParams<T>): boolean {
    const [firstRow, lastRow] = this.rows();
    const rowIndex = params.node.rowIndex;
    return params.column.getColId() === this.rowNumberColumnId
      && rowIndex !== null && rowIndex >= firstRow && rowIndex <= lastRow;
  }

  public clear() {
    if (!this.active) return;
    this.anchor = this.focus = undefined;
    this.repaintSelection();
  }

  /** Selects every displayed cell. */
  public selectAll() {
    const columns = this.dataColumns();
    const lastRow = this.gridApi.getDisplayedRowCount() - 1;
    if (!columns.length || lastRow < 0) return;
    this.anchor = { row: 0, columnId: columns[0].getColId() };
    this.focus = { row: lastRow, columnId: columns.at(-1)!.getColId() };
    this.repaintSelection();
  }

  public destroy() {
    this.stopAutoScroll();
    this.selectionBox.remove();
    for (const cleanup of this.cleanupCallbacks) cleanup();
  }

  private dataColumns(): Column[] {
    return this.gridApi.getAllDisplayedColumns().filter((column) => column.getColId() !== this.rowNumberColumnId);
  }

  /** The cell under a DOM event: its displayed row index and column id. */
  private cellPositionAt(target: EventTarget | null): CellPosition | null {
    const cell = (target as HTMLElement | null)?.closest?.('.ag-cell');
    const row = cell?.closest('.ag-row');
    if (!cell || !row || !this.hostElement.contains(cell)) return null;
    // Clicks inside an open editor are the editor's.
    if (cell.classList.contains('ag-cell-inline-editing')) return null;
    const rowIndex = Number(row.getAttribute('row-index'));
    const columnId = cell.getAttribute('col-id');
    return Number.isInteger(rowIndex) && rowIndex >= 0 && columnId ? { row: rowIndex, columnId } : null;
  }

  private onMouseDown(event: MouseEvent) {
    const cellPosition = this.cellPositionAt(event.target);
    if (!cellPosition) return;
    const columns = this.dataColumns();
    if (!columns.length) return;
    if (event.button === 2) {
      // Right-click keeps the block it lands in, else selects the cell under it.
      const onRowNumber = cellPosition.columnId === this.rowNumberColumnId;
      if (!this.contains(cellPosition.row, cellPosition.columnId) && !(onRowNumber && this.isRowSelected(cellPosition.row))) {
        this.selectCells(cellPosition, columns);
      }
      return;
    }
    if (event.button !== 0) return;
    if (event.shiftKey && this.anchor) {
      this.focus = cellPosition.columnId === this.rowNumberColumnId
        ? { row: cellPosition.row, columnId: this.focus!.columnId }
        : cellPosition;
    } else {
      this.selectCells(cellPosition, columns);
    }
    this.wholeRows = cellPosition.columnId === this.rowNumberColumnId;
    this.isDragging = true;
    this.pointerPosition = { x: event.clientX, y: event.clientY };
    this.stopAutoScroll();
    this.autoScrollTimer = setInterval(() => this.autoScroll(), AUTO_SCROLL_INTERVAL_MS);
    this.repaintSelection();
  }

  /** A cell, or the whole row when it is a row number. */
  private selectCells(cellPosition: CellPosition, columns: Column[]) {
    if (cellPosition.columnId === this.rowNumberColumnId) {
      this.anchor = { row: cellPosition.row, columnId: columns[0].getColId() };
      this.focus = { row: cellPosition.row, columnId: columns.at(-1)!.getColId() };
    } else {
      this.anchor = this.focus = cellPosition;
    }
    this.repaintSelection();
  }

  private isRowSelected(rowIndex: number): boolean {
    const [firstRow, lastRow] = this.rows();
    return rowIndex >= firstRow && rowIndex <= lastRow && this.columns().length === this.dataColumns().length;
  }

  private onMouseOver(event: MouseEvent) {
    if (!this.isDragging || !this.anchor) return;
    const cellPosition = this.cellPositionAt(event.target);
    if (!cellPosition) return;
    const columnId = this.wholeRows ? this.focus!.columnId : cellPosition.columnId;
    if (columnId === this.rowNumberColumnId) return;
    if (this.focus?.row === cellPosition.row && this.focus.columnId === columnId) return;
    this.focus = { row: cellPosition.row, columnId };
    this.repaintSelection();
  }

  private endDrag() {
    if (!this.isDragging) return;
    this.isDragging = false;
    this.stopAutoScroll();
  }

  private stopAutoScroll() {
    if (this.autoScrollTimer) clearInterval(this.autoScrollTimer);
    this.autoScrollTimer = undefined;
  }

  /** While dragging past an edge of the grid body, scroll and grow the selection. */
  private autoScroll() {
    if (!this.isDragging || !this.focus) return;
    const viewport = this.viewportElement() ?? this.hostElement;
    const viewportBounds = viewport.getBoundingClientRect();
    const header = this.hostElement.querySelector<HTMLElement>('.ag-header');
    const contentTop = Math.max(
      viewportBounds.top,
      header?.getBoundingClientRect().bottom ?? viewportBounds.top,
    );
    const { x: pointerX, y: pointerY } = this.pointerPosition;
    let rowIndex = this.focus.row;
    let columnId = this.focus.columnId;
    const lastRow = this.gridApi.getDisplayedRowCount() - 1;
    if (pointerY > viewportBounds.bottom - AUTO_SCROLL_EDGE) rowIndex = Math.min(lastRow, rowIndex + 1);
    else if (pointerY < contentTop + AUTO_SCROLL_EDGE) rowIndex = Math.max(0, rowIndex - 1);
    if (!this.wholeRows) {
      const columns = this.dataColumns();
      const columnIndex = columns.findIndex((column) => column.getColId() === columnId);
      if (pointerX > viewportBounds.right - AUTO_SCROLL_EDGE && columnIndex < columns.length - 1) {
        columnId = columns[columnIndex + 1].getColId();
      } else if (pointerX < viewportBounds.left + this.pinnedColumnsWidth() + AUTO_SCROLL_EDGE && columnIndex > 0) {
        columnId = columns[columnIndex - 1].getColId();
      }
    }
    if (rowIndex === this.focus.row && columnId === this.focus.columnId) return;
    this.focus = { row: rowIndex, columnId };
    this.gridApi.ensureIndexVisible(rowIndex);
    this.gridApi.ensureColumnVisible(columnId);
    this.repaintSelection();
  }

  private onKeyDown(event: KeyboardEvent) {
    if (this.gridApi.getEditingCells().length) return;
    const modifierPressed = /Mac|iPhone|iPad/.test(navigator.platform) ? event.metaKey : event.ctrlKey;
    if (modifierPressed && !event.shiftKey && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      event.stopPropagation();
      this.selectAll();
    } else if (NAVIGATION_KEYS.has(event.key) && !modifierPressed && !event.altKey) {
      // Follow the grid's focus once it has moved: Shift extends the block.
      const extending = event.shiftKey && event.key !== 'Tab' && this.anchor;
      if (extending) event.preventDefault(); // the grid would select rows instead
      const startPosition = this.focus;
      setTimeout(() => {
        const focusedCell = this.gridApi.getFocusedCell();
        if (!focusedCell || focusedCell.rowIndex === null) return;
        let cellPosition: CellPosition = { row: focusedCell.rowIndex, columnId: focusedCell.column.getColId() };
        if (extending && startPosition) {
          cellPosition = this.nextCellPosition(startPosition, event.key) ?? startPosition;
          this.gridApi.ensureIndexVisible(cellPosition.row);
          this.gridApi.ensureColumnVisible(cellPosition.columnId);
          this.focus = cellPosition;
        } else if (cellPosition.columnId !== this.rowNumberColumnId) {
          this.anchor = this.focus = cellPosition;
        }
        this.repaintSelection();
      });
    }
  }

  /** The cell next to `startPosition` in the direction of an arrow key. */
  private nextCellPosition(startPosition: CellPosition, key: string): CellPosition | null {
    const columns = this.dataColumns();
    const columnIndex = columns.findIndex((column) => column.getColId() === startPosition.columnId);
    const lastRow = this.gridApi.getDisplayedRowCount() - 1;
    switch (key) {
      case 'ArrowUp': return { row: Math.max(0, startPosition.row - 1), columnId: startPosition.columnId };
      case 'ArrowDown': return { row: Math.min(lastRow, startPosition.row + 1), columnId: startPosition.columnId };
      case 'ArrowLeft': return columnIndex > 0
        ? { row: startPosition.row, columnId: columns[columnIndex - 1].getColId() }
        : startPosition;
      case 'ArrowRight': return columnIndex < columns.length - 1
        ? { row: startPosition.row, columnId: columns[columnIndex + 1].getColId() }
        : startPosition;
      default: return null;
    }
  }

  private viewportElement(): HTMLElement | null {
    return this.hostElement.querySelector<HTMLElement>('.ag-body-viewport, .ag-grid-viewport');
  }

  /** Width of the left-pinned columns (the row numbers). */
  private pinnedColumnsWidth(): number {
    return this.gridApi.getAllDisplayedColumns()
      .filter((column) => column.getPinned() === 'left')
      .reduce((width, column) => width + column.getActualWidth(), 0);
  }

  private repaintSelection() {
    this.placeSelectionBox();
    this.hostElement.classList.toggle('rg-active', this.active);
    // Only the row-number marks need the grid (a few dozen rendered cells).
    this.gridApi.refreshCells({ columns: [this.rowNumberColumnId] });
  }

  /**
   * Positions the block over its cells. It lives in the container that holds
   * the rows, so it scrolls with them; it is clipped where it would pass
   * under the pinned row numbers.
   */
  private placeSelectionBox() {
    const columns = this.columns();
    const [firstRowIndex, lastRowIndex] = this.rows();
    const firstRow = firstRowIndex >= 0 ? this.gridApi.getDisplayedRowAtIndex(firstRowIndex) : undefined;
    const lastRow = lastRowIndex >= 0 ? this.gridApi.getDisplayedRowAtIndex(lastRowIndex) : undefined;
    const container = this.hostElement.querySelector<HTMLElement>(
      '.ag-grid-scrolling-container, .ag-center-cols-container',
    );
    if (!columns.length || !firstRow || !lastRow || !container) {
      this.selectionBox.hidden = true;
      return;
    }
    if (firstRow.rowTop === null || lastRow.rowTop === null) {
      this.selectionBox.hidden = true;
      return;
    }
    if (this.selectionBox.parentElement !== container) container.appendChild(this.selectionBox);
    const pinnedWidth = this.pinnedColumnsWidth();
    // Rows that hold pinned and scrolling cells together place the scrolling
    // ones after the pinned width; older layouts have a separate container.
    const offset = container.classList.contains('ag-grid-scrolling-container') ? pinnedWidth : 0;
    const firstColumn = columns[0];
    const lastColumn = columns.at(-1)!;
    const left = offset + firstColumn.getLeft()!;
    const right = offset + lastColumn.getLeft()! + lastColumn.getActualWidth();
    const top = firstRow.rowTop;
    const bottom = lastRow.rowTop + (lastRow.rowHeight ?? 0);
    const scrollLeft = offset ? this.viewportElement()?.scrollLeft ?? 0 : 0;
    const hiddenWidth = Math.max(0, scrollLeft + pinnedWidth - left); // part under the pinned columns
    Object.assign(this.selectionBox.style, {
      left: `${left}px`, top: `${top}px`, width: `${right - left}px`, height: `${bottom - top}px`,
      clipPath: hiddenWidth ? `inset(-2px -2px -2px ${hiddenWidth}px)` : '',
    });
    this.selectionBox.hidden = false;
  }
}
