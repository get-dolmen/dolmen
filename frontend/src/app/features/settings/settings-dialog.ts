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
  public readonly dialogRef = inject(DialogRef);
  public readonly uiState = inject(Ui);
  private api = inject(Api);
  private connectionStore = inject(ConnectionStore);
  private scratchStore = inject(ScratchStore);
  private tabStore = inject(TabStore);
  private syncStore = inject(SyncStore);
  private toastService = inject(Toasts);

  public readonly themeOptions: { value: Theme; label: string; hint: string }[] = [
    { value: 'system', label: 'System', hint: 'Follow the OS' },
    { value: 'light', label: 'Light', hint: 'Stone and white' },
    { value: 'dark', label: 'Dark', hint: 'Low light' },
  ];

  public readonly form: SyncConfig = { enabled: false, remote: '', branch: 'main', encrypted: false };
  public readonly status = this.syncStore.status;
  public readonly password = signal('');
  public readonly busy = signal<'save' | 'sync' | null>(null);

  public constructor() {
    void this.loadForm();
  }

  public async loadForm() {
    await this.syncStore.refresh();
    const status = this.syncStore.status();
    if (!status) return;
    Object.assign(this.form, {
      enabled: status.enabled,
      remote: status.remote,
      branch: status.branch,
      encrypted: status.encrypted,
    });
  }

  public async save(): Promise<boolean> {
    this.busy.set('save');
    try {
      const savedConfig = await this.api.saveSyncConfig({ ...this.form });
      Object.assign(this.form, savedConfig);
      await this.syncStore.refresh();
      this.toastService.success('Sync settings saved');
      return true;
    } catch (error) {
      this.toastService.error(errorText(error));
      return false;
    } finally {
      this.busy.set(null);
    }
  }

  public async sync() {
    if (this.form.encrypted && !this.password().trim()) {
      this.toastService.error('Enter the master password to sync.');
      return;
    }
    if (!(await this.save())) return;
    this.busy.set('sync');
    try {
      // Write pending edits first: the backend merges what is on disk.
      await this.tabStore.flush();
      const result = await this.api.syncNow(this.password());
      await this.connectionStore.refresh();
      await this.scratchStore.reloadOpen();
      await this.syncStore.refresh();
      const connections = `${result.connections} connection${result.connections === 1 ? '' : 's'}`;
      const scratches = `${result.scratches} scratch file${result.scratches === 1 ? '' : 's'}`;
      this.toastService.success(`Synced ${connections} and ${scratches}`);
    } catch (error) {
      this.toastService.error(errorText(error));
      await this.syncStore.refresh();
    } finally {
      this.busy.set(null);
    }
  }

  public relativeTime(timestamp: number): string {
    const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
    if (seconds < 45) return 'just now';
    if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min ago`;
    if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
    return new Date(timestamp).toLocaleDateString();
  }
}
