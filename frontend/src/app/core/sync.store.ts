import { Injectable, computed, inject, signal } from '@angular/core';
import { Api } from './api';
import type { SyncStatus } from './models';

/** Shared git sync state, so the settings dialog and the status bar agree. */
@Injectable({ providedIn: 'root' })
export class SyncStore {
  private api = inject(Api);

  public readonly status = signal<SyncStatus | null>(null);
  public readonly configured = computed(() => !!this.status()?.enabled);

  public async refresh() {
    try {
      this.status.set(await this.api.syncStatus());
    } catch {
      // Keep the previous status; the settings dialog surfaces errors.
    }
  }

  /** "just now", "5 min ago", or the date; "" when never synced. */
  public lastSyncText(now = Date.now()): string {
    const lastSyncAt = this.status()?.lastSyncAt;
    if (!lastSyncAt) return '';
    const seconds = Math.max(0, Math.round((now - lastSyncAt) / 1000));
    if (seconds < 45) return 'just now';
    if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min ago`;
    if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
    return new Date(lastSyncAt).toLocaleDateString();
  }
}
