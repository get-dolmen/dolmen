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
  public readonly column = signal<TableColumn | null>(null);
  public readonly sortDirection = signal<'asc' | 'desc' | null>(null);
  private headerParams?: IHeaderParams & ColumnHeaderParams;

  public agInit(params: IHeaderParams & ColumnHeaderParams) { this.applyParams(params); }
  public refresh(params: IHeaderParams & ColumnHeaderParams) { this.applyParams(params); return true; }

  private applyParams(params: IHeaderParams & ColumnHeaderParams) {
    this.headerParams = params;
    this.column.set(params.column);
    this.sortDirection.set(params.sort());
  }

  public sortTitle() {
    const direction = this.sortDirection();
    if (direction === 'asc') return 'Sorted ascending: click for descending';
    if (direction === 'desc') return 'Sorted descending: click to clear';
    return 'Sort ascending';
  }

  public toggleSort(event: Event) {
    event.stopPropagation();
    this.headerParams?.onSort();
  }

  public filter(event: Event) {
    event.stopPropagation();
    this.headerParams?.onFilter();
  }
}
