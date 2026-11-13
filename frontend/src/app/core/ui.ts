import { Injectable, effect, signal } from '@angular/core';

const KEY = 'dolmen.ui';

export type Theme = 'system' | 'light' | 'dark';
/** Where the scratch files live: under the explorer (bottom right) or in their own left panel. */
export type ScratchPosition = 'explorer' | 'left';

interface Persisted {
  sidebarOpen: boolean;
  sidebarWidth: number;
  editorRatio: number;
  theme: Theme;
  scratchPosition: ScratchPosition;
  scratchWidth: number;
  /** Whether the scratch panel is expanded when docked on the left. */
  scratchOpen: boolean;
}

function load(): Partial<Persisted> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}');
  } catch {
    return {};
  }
}

function validTheme(t: unknown): t is Theme {
  return t === 'system' || t === 'light' || t === 'dark';
}

function validScratchPosition(p: unknown): p is ScratchPosition {
  return p === 'explorer' || p === 'left';
}

/** Sets the colour scheme on the document; "system" leaves the OS media query in charge. */
export function applyThemeAttribute(t: Theme) {
  if (t === 'system') delete document.documentElement.dataset['theme'];
  else document.documentElement.dataset['theme'] = t;
}

/** Applies the saved theme before Angular bootstraps, so the window never flashes the wrong colours. */
export function applyStoredTheme() {
  const t = load().theme;
  applyThemeAttribute(validTheme(t) ? t : 'system');
}

/** True when the app currently renders dark colours (explicit setting or OS preference). */
export function isDarkTheme(): boolean {
  const t = document.documentElement.dataset['theme'];
  if (t === 'dark') return true;
  if (t === 'light') return false;
  return matchMedia('(prefers-color-scheme: dark)').matches;
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
  /** Light / dark appearance; "system" follows the OS. */
  readonly theme = signal<Theme>(validTheme(this.saved.theme) ? this.saved.theme : 'system');
  /** Scratches sit under the explorer by default, or in a dedicated left panel. */
  readonly scratchPosition = signal<ScratchPosition>(validScratchPosition(this.saved.scratchPosition) ? this.saved.scratchPosition : 'explorer');
  readonly scratchWidth = signal(this.saved.scratchWidth ?? 260);
  /** Collapses the dedicated scratch panel without moving it back under the explorer. */
  readonly scratchOpen = signal(this.saved.scratchOpen ?? true);
  readonly paletteOpen = signal(false);
  readonly paletteQuery = signal('');
  /** Bumped to ask the sidebar to reveal a table. */
  readonly reveal = signal<{ connId: string; database: string; schema: string; table: string } | null>(null);

  constructor() {
    // Paint the remembered theme as soon as the store exists, then on every change.
    effect(() => applyThemeAttribute(this.theme()));

    effect(() => {
      const p: Persisted = {
        sidebarOpen: this.sidebarOpen(),
        sidebarWidth: this.sidebarWidth(),
        editorRatio: this.editorRatio(),
        theme: this.theme(),
        scratchPosition: this.scratchPosition(),
        scratchWidth: this.scratchWidth(),
        scratchOpen: this.scratchOpen(),
      };
      try {
        localStorage.setItem(KEY, JSON.stringify(p));
      } catch { /* storage unavailable */ }
    });
  }

  openPalette(query = '') {
    this.paletteQuery.set(query);
    this.paletteOpen.set(true);
  }

  /** Moves the scratch files between the explorer and a dedicated left panel. */
  toggleScratchPosition() {
    this.scratchPosition.update((p) => (p === 'left' ? 'explorer' : 'left'));
    // Docking on the left always shows the panel; it can then be collapsed on its own.
    if (this.scratchPosition() === 'left') this.scratchOpen.set(true);
  }
}
