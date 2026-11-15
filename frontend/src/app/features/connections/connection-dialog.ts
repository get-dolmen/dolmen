import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { Api, errorText } from '../../core/api';
import { ConnectionStore } from '../../core/connection.store';
import { Confirm } from '../../shared/confirm';
import { Select } from '../../shared/select';
import {
  CONNECTION_COLORS, DEFAULT_PORTS, KIND_LABELS,
  type ConnectionConfig, type ConnectionView, type DbKind, type SSHConfig,
} from '../../core/models';

@Component({
  selector: 'dm-connection-dialog',
  imports: [FormsModule, Select],
  templateUrl: './connection-dialog.html',
  styleUrl: './connection-dialog.scss',
})
export class ConnectionDialog {
  public readonly dialogRef = inject<DialogRef<ConnectionView | undefined>>(DialogRef);
  public readonly connection = inject<ConnectionView | undefined>(DIALOG_DATA);
  private api = inject(Api);
  private connectionStore = inject(ConnectionStore);
  private confirmDialog = inject(Confirm);

  public readonly kinds: DbKind[] = ['postgres', 'mysql', 'oracle', 'sqlite'];
  public readonly kindLabels = KIND_LABELS;
  public readonly colors = CONNECTION_COLORS;
  public readonly isEditing = !!this.connection;
  public readonly oracleModes = [
    { value: 'service', label: 'Service name' },
    { value: 'sid', label: 'SID' },
  ];
  public readonly oracleRoles = [
    { value: '', label: 'Normal' },
    { value: 'SYSDBA', label: 'SYSDBA' },
    { value: 'SYSOPER', label: 'SYSOPER' },
  ];
  public readonly sshMethods = [
    { value: 'password', label: 'Password' },
    { value: 'key', label: 'Private key' },
    { value: 'agent', label: 'SSH agent' },
  ];

  public form: ConnectionConfig = this.connection
    ? { ...this.connection, password: '' }
    : { id: '', name: '', kind: 'postgres', host: 'localhost', readOnly: false, color: CONNECTION_COLORS[0] };

  /** Oracle service names live in `database`; the mode only changes the options. */
  public oracleMode: 'service' | 'sid' = this.form.options?.['SID'] ? 'sid' : 'service';
  public oracleRole = this.form.options?.['DBA PRIVILEGE'] ?? '';

  /** Working copy of the tunnel settings, kept even when the tunnel is off. */
  public ssh: SSHConfig = this.connection?.ssh
    ? { ...this.connection.ssh }
    : { enabled: false, port: 22, method: 'password' };

  public readonly busy = signal<'' | 'test' | 'save'>('');
  public readonly status = signal<{ text: string; error: boolean } | null>(null);
  private selectedKind = signal(this.form.kind);
  public readonly defaultPort = computed(() => String(DEFAULT_PORTS[this.selectedKind()] ?? ''));

  public placeholderName() {
    if (this.form.kind === 'sqlite') return this.form.filePath?.split(/[\\/]/).pop() || 'local.db';
    return [this.form.host || 'localhost', this.form.database].filter(Boolean).join(' / ');
  }

  public databaseLabel() {
    if (this.form.kind !== 'oracle') return 'Database';
    return this.oracleMode === 'sid' ? 'SID' : 'Service name';
  }

  public databasePlaceholder() {
    if (this.form.kind === 'oracle') return this.oracleMode === 'sid' ? 'ORCL' : 'FREEPDB1';
    return this.form.kind === 'postgres' ? 'postgres' : 'optional';
  }

  public setKind(kind: DbKind) {
    this.form.kind = kind;
    this.selectedKind.set(kind);
    this.form.port = undefined;
    if (kind === 'sqlite') this.ssh.enabled = false;
    this.status.set(null);
  }

  public setOracleMode(mode: string) {
    this.oracleMode = mode === 'sid' ? 'sid' : 'service';
  }

  public setSSHMethod(method: string) {
    if (method === 'password' || method === 'key' || method === 'agent') this.ssh.method = method;
  }

  public async pickFile() {
    const path = await this.api.pickSQLiteFile();
    if (path) this.form.filePath = path;
  }

  public async pickKey() {
    const path = await this.api.pickSSHKey();
    if (path) this.ssh.keyPath = path;
  }

  private buildConfig(): ConnectionConfig {
    const config = { ...this.form };
    if (!config.name?.trim()) config.name = this.placeholderName();
    config.port = config.port ? Number(config.port) : undefined;

    const options = { ...(config.options ?? {}) };
    if (config.kind === 'oracle') {
      if (this.oracleMode === 'sid' && config.database) options['SID'] = config.database;
      else delete options['SID'];
      if (this.oracleRole) options['DBA PRIVILEGE'] = this.oracleRole;
      else delete options['DBA PRIVILEGE'];
    } else {
      delete options['SID'];
      delete options['DBA PRIVILEGE'];
    }
    config.options = Object.keys(options).length ? options : undefined;

    config.ssh = this.ssh.enabled
      ? { ...this.ssh, port: this.ssh.port ? Number(this.ssh.port) : 22, method: this.ssh.method || 'password' }
      : undefined;
    return config;
  }

  public async test() {
    this.busy.set('test');
    this.status.set(null);
    try {
      const version = await this.api.testConnection(this.buildConfig());
      this.status.set({ text: `Connection OK: ${version}`, error: false });
    } catch (error) {
      this.status.set({ text: errorText(error), error: true });
    } finally {
      this.busy.set('');
    }
  }

  public async save() {
    this.busy.set('save');
    try {
      const saved = await this.connectionStore.save(this.buildConfig());
      this.dialogRef.close(saved);
    } catch (error) {
      this.status.set({ text: errorText(error), error: true });
    } finally {
      this.busy.set('');
    }
  }

  public async remove() {
    const connection = this.connection;
    if (!connection) return;
    if (!(await this.confirmDialog.ask(`Delete the connection “${connection.name}”?`,
      { title: 'Delete connection', confirmLabel: 'Delete', danger: true }))) return;
    await this.connectionStore.remove(connection.id);
    this.dialogRef.close(undefined);
  }
}
