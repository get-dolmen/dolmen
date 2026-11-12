import { Injectable, computed, inject, signal } from '@angular/core';
import { Api } from './api';
import type { SyncStatus } from './models';

/** Shared git sync state, so the settings dialog and the status bar agree. */
@Injectable({ providedIn: 'root' })
export class SyncStore {
  private api = inject(Api);

  readonly status = signal<SyncStatus | null>(null);
  readonly configured = computed(() => !!this.status()?.enabled);

  async refresh() {
    try {
      this.status.set(await this.api.syncStatus());
    } catch {
      // Keep the previous status; the settings dialog surfaces errors.
    }
  }

  /** "just now", "5 min ago", or the date; "" when never synced. */
  lastSyncText(now = Date.now()): string {
    const ms = this.status()?.lastSyncAt;
    if (!ms) return '';
    const s = Math.max(0, Math.round((now - ms) / 1000));
    if (s < 45) return 'just now';
    if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return new Date(ms).toLocaleDateString();
  }
}
