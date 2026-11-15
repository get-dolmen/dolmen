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
  public readonly col = signal<TableColumn | null>(null);
  public readonly sort = signal<'asc' | 'desc' | null>(null);
  private params?: IHeaderParams & ColumnHeaderParams;

  public agInit(p: IHeaderParams & ColumnHeaderParams) { this.set(p); }
  public refresh(p: IHeaderParams & ColumnHeaderParams) { this.set(p); return true; }

  private set(p: IHeaderParams & ColumnHeaderParams) {
    this.params = p;
    this.col.set(p.column);
    this.sort.set(p.sort());
  }

  public sortTitle() {
    const s = this.sort();
    return s === 'asc' ? 'Sorted ascending: click for descending' : s === 'desc' ? 'Sorted descending: click to clear' : 'Sort ascending';
  }

  public toggleSort(e: Event) {
    e.stopPropagation();
    this.params?.onSort();
  }

  public filter(e: Event) {
    e.stopPropagation();
    this.params?.onFilter();
  }
}
