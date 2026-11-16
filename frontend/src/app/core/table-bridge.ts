import { Injectable } from '@angular/core';

export interface TableHandle {
  refresh(): void;
  apply(): void;
}

/** Routes Run (⌘↵) and Save (⌘S) to the data editor of the active table tab. */
@Injectable({ providedIn: 'root' })
export class TableBridge {
  private handles = new Map<string, TableHandle>();

  public attach(tabId: string, handle: TableHandle) {
    this.handles.set(tabId, handle);
  }
  public detach(tabId: string) {
    this.handles.delete(tabId);
  }
  public get(tabId: string) {
    return this.handles.get(tabId);
  }
}
