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
  styles: `
    :host { display: flex; align-items: center; gap: 5px; width: 100%; min-width: 0; font-family: var(--font-mono); font-weight: 600; font-size: 12px; color: var(--text); }
    .kind { color: var(--text-faint); display: inline-flex; }
    .kind.pk { color: var(--warn); }
    .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
    .spacer { flex: 1; }
    .hb { display: inline-grid; place-items: center; width: 18px; height: 18px; padding: 0; border: 0; border-radius: 4px; background: none; color: var(--text-faint); cursor: pointer; flex: none; }
    .hb:hover { background: var(--bg-active); color: var(--text); }
    .hb.on { color: var(--accent); }
    .filter { opacity: 0; }
    :host:hover .filter { opacity: 1; }
    .both { font-size: 11px; line-height: 1; }
  `,
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
