import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DialogRef } from '@angular/cdk/dialog';
import { Api, errorText } from '../../core/api';
import { ConnectionStore } from '../../core/connection.store';
import { ScratchStore } from '../../core/scratch.store';
import { SyncStore } from '../../core/sync.store';
import { TabStore } from '../../core/tab.store';
import { Toasts } from '../../core/toast';
import { FORMAT_WIDTH, clampFormatWidth } from '../../core/sql-format';
import { Ui, type Theme } from '../../core/ui';
import type { McpStatus, SyncConfig } from '../../core/models';
import { Clipboard } from '@wailsio/runtime';

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

  public readonly formatWidthBounds = FORMAT_WIDTH;

  /** Applies the typed width once the field is committed, clamped to the supported range. */
  public setFormatWidth(event: Event) {
    const input = event.target as HTMLInputElement;
    const width = clampFormatWidth(input.value);
    this.uiState.formatWidth.set(width);
    input.value = String(width);
  }

  public readonly themeOptions: { value: Theme; label: string; hint: string }[] = [
    { value: 'system', label: 'System', hint: 'Follow the OS' },
    { value: 'light', label: 'Light', hint: 'Stone and white' },
    { value: 'dark', label: 'Dark', hint: 'Low light' },
  ];

  public readonly form: SyncConfig = {
    enabled: false,
    remote: '',
    branch: 'main',
    encrypted: false,
  };
  public readonly status = this.syncStore.status;
  public readonly password = signal('');
  public readonly busy = signal<'save' | 'sync' | null>(null);

  public readonly mcpForm = {
    enabled: false,
    port: 8770,
    read: true,
    write: false,
    databases: '',
    schemas: '',
  };
  public readonly mcpStatus = signal<McpStatus | null>(null);
  public readonly mcpBusy = signal<'save' | 'token' | null>(null);

  public constructor() {
    void this.loadForm();
    void this.loadMcp();
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

  public async loadMcp() {
    try {
      this.applyMcp(await this.api.mcpStatus());
    } catch (error) {
      this.toastService.error(errorText(error));
    }
  }

  private applyMcp(status: McpStatus) {
    this.mcpStatus.set(status);
    Object.assign(this.mcpForm, {
      enabled: status.enabled,
      port: status.port,
      read: status.read,
      write: status.write,
      databases: status.databases.join(', '),
      schemas: status.schemas.join(', '),
    });
  }

  /** Write access implies read access, so ticking it ticks Read too. */
  public setMcpWrite(write: boolean) {
    this.mcpForm.write = write;
    if (write) this.mcpForm.read = true;
  }

  public async saveMcp() {
    this.mcpBusy.set('save');
    try {
      const status = await this.api.saveMcpConfig({
        enabled: this.mcpForm.enabled,
        port: Number(this.mcpForm.port),
        token: this.mcpStatus()?.token ?? '',
        read: this.mcpForm.read,
        write: this.mcpForm.write,
        databases: splitList(this.mcpForm.databases),
        schemas: splitList(this.mcpForm.schemas),
      });
      this.applyMcp(status);
      if (status.lastError) this.toastService.error(status.lastError);
      else
        this.toastService.success(
          status.running ? 'MCP server is listening' : 'MCP settings saved',
        );
    } catch (error) {
      this.toastService.error(errorText(error));
    } finally {
      this.mcpBusy.set(null);
    }
  }

  public async regenerateMcpToken() {
    this.mcpBusy.set('token');
    try {
      this.applyMcp(await this.api.regenerateMcpToken());
      this.toastService.success('New MCP access token generated');
    } catch (error) {
      this.toastService.error(errorText(error));
    } finally {
      this.mcpBusy.set(null);
    }
  }

  public async copyMcpToken() {
    const token = this.mcpStatus()?.token;
    if (token && (await this.copyText(token))) this.toastService.success('Access token copied');
  }

  public async copyMcpConfig() {
    const status = this.mcpStatus();
    if (status && (await this.copyText(this.mcpSnippet(status)))) {
      this.toastService.success('MCP client configuration copied');
    }
  }

  /** A ready-to-paste mcpServers entry for the configured endpoint. */
  public mcpSnippet(status: McpStatus): string {
    return JSON.stringify(
      {
        mcpServers: {
          dolmen: {
            type: 'http',
            url: status.url,
            headers: { Authorization: `Bearer ${status.token}` },
          },
        },
      },
      null,
      2,
    );
  }

  private async copyText(text: string): Promise<boolean> {
    try {
      await Clipboard.SetText(text);
      return true;
    } catch {
      // Fall through to the browser clipboard.
    }
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      this.toastService.error('Clipboard is not available');
      return false;
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

/** Splits a comma- or newline-separated allow-list. */
function splitList(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}
