import { Injectable } from '@angular/core';

export interface RunTarget {
  sql: string;
  /** UTF-16 offset of the caret; -1 runs every statement of `sql`. */
  cursor: number;
  /** Model offset where `sql` starts (the selection start, else 0). */
  startOffset: number;
}

/** What the SQL editor component exposes to the rest of the app. */
export interface EditorHandle {
  runTarget(mode: 'cursor' | 'all'): RunTarget | null;
  insert(text: string): void;
  /** Replaces a tab's model after its file changed on disk (git sync). */
  replaceContent(tabId: string, content: string): void;
  focus(): void;
  flashError(): void;
}

/** Lets stores and commands talk to the single Monaco instance without importing it. */
@Injectable({ providedIn: 'root' })
export class EditorBridge {
  private editorHandle?: EditorHandle;

  public attach(editorHandle: EditorHandle) {
    this.editorHandle = editorHandle;
  }
  public detach(editorHandle: EditorHandle) {
    if (this.editorHandle === editorHandle) this.editorHandle = undefined;
  }

  public runTarget(mode: 'cursor' | 'all') {
    return this.editorHandle?.runTarget(mode) ?? null;
  }
  public insert(text: string) {
    this.editorHandle?.insert(text);
  }
  public replaceContent(tabId: string, content: string) {
    this.editorHandle?.replaceContent(tabId, content);
  }
  public focus() {
    this.editorHandle?.focus();
  }
  public flashError() {
    this.editorHandle?.flashError();
  }
}
