import { Injectable } from '@angular/core';

export interface RunTarget {
  sql: string;
  /** UTF-16 offset of the caret; -1 runs every statement of `sql`. */
  cursor: number;
}

/** What the SQL editor component exposes to the rest of the app. */
export interface EditorHandle {
  runTarget(mode: 'cursor' | 'all'): RunTarget | null;
  insert(text: string): void;
  focus(): void;
  flashError(): void;
}

/** Lets stores and commands talk to the single Monaco instance without importing it. */
@Injectable({ providedIn: 'root' })
export class EditorBridge {
  private handle?: EditorHandle;

  attach(h: EditorHandle) { this.handle = h; }
  detach(h: EditorHandle) { if (this.handle === h) this.handle = undefined; }

  runTarget(mode: 'cursor' | 'all') { return this.handle?.runTarget(mode) ?? null; }
  insert(text: string) { this.handle?.insert(text); }
  focus() { this.handle?.focus(); }
  flashError() { this.handle?.flashError(); }
}
