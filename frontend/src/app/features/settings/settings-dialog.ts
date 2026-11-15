import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DialogRef } from '@angular/cdk/dialog';
import { Api, errorText } from '../../core/api';
import { ConnectionStore } from '../../core/connection.store';
import { ScratchStore } from '../../core/scratch.store';
import { SyncStore } from '../../core/sync.store';
import { TabStore } from '../../core/tab.store';
import { Toasts } from '../../core/toast';
import { Ui, type Theme } from '../../core/ui';
import type { SyncConfig } from '../../core/models';

/** Application settings. Appearance applies as soon as it is picked. */
@Component({
  selector: 'dm-settings-dialog',
  imports: [FormsModule],
  templateUrl: './settings-dialog.html',
  styleUrl: './settings-dialog.scss',
})
export class SettingsDialog {
  readonly ref = inject(DialogRef);
  readonly ui = inject(Ui);
  private api = inject(Api);
  private conns = inject(ConnectionStore);
  private scratches = inject(ScratchStore);
  private tabs = inject(TabStore);
  private syncStore = inject(SyncStore);
  private toasts = inject(Toasts);

  readonly themes: { value: Theme; label: string; hint: string }[] = [
    { value: 'system', label: 'System', hint: 'Follow the OS' },
    { value: 'light', label: 'Light', hint: 'Stone and white' },
    { value: 'dark', label: 'Dark', hint: 'Low light' },
  ];

  readonly form: SyncConfig = { enabled: false, remote: '', branch: 'main', encrypted: false };
  readonly status = this.syncStore.status;
  readonly password = signal('');
  readonly busy = signal<'save' | 'sync' | null>(null);

  constructor() {
    void this.load();
  }

  async load() {
    await this.syncStore.refresh();
    const s = this.syncStore.status();
    if (!s) return;
    Object.assign(this.form, { enabled: s.enabled, remote: s.remote, branch: s.branch, encrypted: s.encrypted });
  }

  async save(): Promise<boolean> {
    this.busy.set('save');
    try {
      const c = await this.api.saveSyncConfig({ ...this.form });
      Object.assign(this.form, c);
      await this.syncStore.refresh();
      this.toasts.success('Sync settings saved');
      return true;
    } catch (e) {
      this.toasts.error(errorText(e));
      return false;
    } finally {
      this.busy.set(null);
    }
  }

  async sync() {
    if (this.form.encrypted && !this.password().trim()) {
      this.toasts.error('Enter the master password to sync.');
      return;
    }
    if (!(await this.save())) return;
    this.busy.set('sync');
    try {
      // Write pending edits first: the backend merges what is on disk.
      await this.tabs.flush();
      const r = await this.api.syncNow(this.password());
      await this.conns.refresh();
      await this.scratches.reloadOpen();
      await this.syncStore.refresh();
      this.toasts.success(`Synced ${r.connections} connection${r.connections === 1 ? '' : 's'} and ${r.scratches} scratch file${r.scratches === 1 ? '' : 's'}`);
    } catch (e) {
      this.toasts.error(errorText(e));
      await this.syncStore.refresh();
    } finally {
      this.busy.set(null);
    }
  }

  when(ms: number): string {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 45) return 'just now';
    if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return new Date(ms).toLocaleDateString();
  }
}
