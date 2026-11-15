import { Component, signal } from '@angular/core';
import type { IHeaderAngularComp } from 'ag-grid-angular';
import type { IHeaderParams } from 'ag-grid-community';
import { Icon } from '../../shared/icon';
import type { TableColumn } from '../../core/models';

export interface ColumnHeaderParams {
  column: TableColumn;
  /** Current server-side sort of this column. */
  sort: () => 'asc' | 'desc' | null;
  onSort: () => void;
  onFilter: () => void;
}

/** Header: key/column icon, name, filter shortcut, and server-side sort toggle. */
@Component({
  selector: 'dm-column-header',
  imports: [Icon],
  templateUrl: './column-header.html',
  styleUrl: './column-header.scss',
})
export class ColumnHeader implements IHeaderAngularComp {
  readonly col = signal<TableColumn | null>(null);
  readonly sort = signal<'asc' | 'desc' | null>(null);
  private params?: IHeaderParams & ColumnHeaderParams;

  agInit(p: IHeaderParams & ColumnHeaderParams) { this.set(p); }
  refresh(p: IHeaderParams & ColumnHeaderParams) { this.set(p); return true; }

  private set(p: IHeaderParams & ColumnHeaderParams) {
    this.params = p;
    this.col.set(p.column);
    this.sort.set(p.sort());
  }

  sortTitle() {
    const s = this.sort();
    return s === 'asc' ? 'Sorted ascending: click for descending' : s === 'desc' ? 'Sorted descending: click to clear' : 'Sort ascending';
  }

  toggleSort(e: Event) {
    e.stopPropagation();
    this.params?.onSort();
  }

  filter(e: Event) {
    e.stopPropagation();
    this.params?.onFilter();
  }
}
