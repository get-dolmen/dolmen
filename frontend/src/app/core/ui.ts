import { Injectable, effect, signal } from '@angular/core';

const KEY = 'dolmen.ui';

interface Persisted { sidebarOpen: boolean; sidebarWidth: number; editorRatio: number; }

function load(): Partial<Persisted> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}');
  } catch {
    return {};
  }
}

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
/** Label for the platform's primary modifier. */
export const MOD = isMac ? '⌘' : 'Ctrl+';

/** Layout state, remembered per machine. */
@Injectable({ providedIn: 'root' })
export class Ui {
  private saved = load();
  readonly sidebarOpen = signal(this.saved.sidebarOpen ?? true);
  readonly sidebarWidth = signal(this.saved.sidebarWidth ?? 280);
  /** Editor share of the vertical space, 0..1. */
  readonly editorRatio = signal(this.saved.editorRatio ?? 0.55);
  readonly paletteOpen = signal(false);
  readonly paletteQuery = signal('');
  /** Bumped to ask the sidebar to reveal a table. */
  readonly reveal = signal<{ connId: string; database: string; schema: string; table: string } | null>(null);

  constructor() {
    effect(() => {
      const p: Persisted = { sidebarOpen: this.sidebarOpen(), sidebarWidth: this.sidebarWidth(), editorRatio: this.editorRatio() };
      try {
        localStorage.setItem(KEY, JSON.stringify(p));
      } catch { /* storage unavailable */ }
    });
  }

  openPalette(query = '') {
    this.paletteQuery.set(query);
    this.paletteOpen.set(true);
  }
}
