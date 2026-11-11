import { Injectable } from '@angular/core';

export interface TableHandle {
  refresh(): void;
  apply(): void;
}

/** Routes Run (⌘↵) and Save (⌘S) to the data editor of the active table tab. */
@Injectable({ providedIn: 'root' })
export class TableBridge {
  private handles = new Map<string, TableHandle>();

  attach(tabId: string, h: TableHandle) { this.handles.set(tabId, h); }
  detach(tabId: string) { this.handles.delete(tabId); }
  get(tabId: string) { return this.handles.get(tabId); }
}
