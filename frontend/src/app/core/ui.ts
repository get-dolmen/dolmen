import { Injectable, effect, signal } from '@angular/core';

const STORAGE_KEY = 'dolmen.ui';

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
  /** Query results shown in the editor under each statement instead of the bottom panel. */
  inlineResults: boolean;
}

function loadPersisted(): Partial<Persisted> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
  } catch {
    return {};
  }
}

function isTheme(value: unknown): value is Theme {
  return value === 'system' || value === 'light' || value === 'dark';
}

function isScratchPosition(value: unknown): value is ScratchPosition {
  return value === 'explorer' || value === 'left';
}

/** Sets the colour scheme on the document; "system" leaves the OS media query in charge. */
export function applyThemeAttribute(theme: Theme) {
  if (theme === 'system') delete document.documentElement.dataset['theme'];
  else document.documentElement.dataset['theme'] = theme;
}

/** Applies the saved theme before Angular bootstraps, so the window never flashes the wrong colours. */
export function applyStoredTheme() {
  const theme = loadPersisted().theme;
  applyThemeAttribute(isTheme(theme) ? theme : 'system');
}

/** True when the app currently renders dark colours (explicit setting or OS preference). */
export function isDarkTheme(): boolean {
  const theme = document.documentElement.dataset['theme'];
  if (theme === 'dark') return true;
  if (theme === 'light') return false;
  return matchMedia('(prefers-color-scheme: dark)').matches;
}

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
/** Label for the platform's primary modifier. */
export const MOD = isMac ? '⌘' : 'Ctrl+';

/** Layout state, remembered per machine. */
@Injectable({ providedIn: 'root' })
export class Ui {
  private readonly saved = loadPersisted();
  public readonly sidebarOpen = signal(this.saved.sidebarOpen ?? true);
  public readonly sidebarWidth = signal(this.saved.sidebarWidth ?? 280);
  /** Editor share of the vertical space, 0..1. */
  public readonly editorRatio = signal(this.saved.editorRatio ?? 0.55);
  /** Light / dark appearance; "system" follows the OS. */
  public readonly theme = signal<Theme>(isTheme(this.saved.theme) ? this.saved.theme : 'system');
  /** Scratches sit under the explorer by default, or in a dedicated left panel. */
  public readonly scratchPosition = signal<ScratchPosition>(
    isScratchPosition(this.saved.scratchPosition) ? this.saved.scratchPosition : 'explorer',
  );
  public readonly scratchWidth = signal(this.saved.scratchWidth ?? 260);
  /** Collapses the dedicated scratch panel without moving it back under the explorer. */
  public readonly scratchOpen = signal(this.saved.scratchOpen ?? true);
  /** Results under each statement in the editor (DataGrip style) instead of the bottom panel. */
  public readonly inlineResults = signal(this.saved.inlineResults ?? false);
  public readonly paletteOpen = signal(false);
  public readonly paletteQuery = signal('');
  /** Bumped to ask the sidebar to reveal a table. */
  public readonly reveal = signal<{ connId: string; database: string; schema: string; table: string } | null>(null);

  constructor() {
    // Paint the remembered theme as soon as the store exists, then on every change.
    effect(() => applyThemeAttribute(this.theme()));

    effect(() => {
      const persisted: Persisted = {
        sidebarOpen: this.sidebarOpen(),
        sidebarWidth: this.sidebarWidth(),
        editorRatio: this.editorRatio(),
        theme: this.theme(),
        scratchPosition: this.scratchPosition(),
        scratchWidth: this.scratchWidth(),
        scratchOpen: this.scratchOpen(),
        inlineResults: this.inlineResults(),
      };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
      } catch { /* storage unavailable */ }
    });
  }

  public openPalette(query = '') {
    this.paletteQuery.set(query);
    this.paletteOpen.set(true);
  }

  /** Moves the scratch files between the explorer and a dedicated left panel. */
  public toggleScratchPosition() {
    this.scratchPosition.update((position) => (position === 'left' ? 'explorer' : 'left'));
    // Docking on the left always shows the panel; it can then be collapsed on its own.
    if (this.scratchPosition() === 'left') this.scratchOpen.set(true);
  }
}
