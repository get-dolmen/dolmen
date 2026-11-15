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
  readonly ref = inject<DialogRef<ConnectionView | undefined>>(DialogRef);
  readonly view = inject<ConnectionView | undefined>(DIALOG_DATA);
  private api = inject(Api);
  private store = inject(ConnectionStore);
  private confirm = inject(Confirm);

  readonly kinds: DbKind[] = ['postgres', 'mysql', 'oracle', 'sqlite'];
  readonly labels = KIND_LABELS;
  readonly colors = CONNECTION_COLORS;
  readonly editing = !!this.view;
  readonly oracleModes = [
    { value: 'service', label: 'Service name' },
    { value: 'sid', label: 'SID' },
  ];
  readonly oracleRoles = [
    { value: '', label: 'Normal' },
    { value: 'SYSDBA', label: 'SYSDBA' },
    { value: 'SYSOPER', label: 'SYSOPER' },
  ];
  readonly sshMethods = [
    { value: 'password', label: 'Password' },
    { value: 'key', label: 'Private key' },
    { value: 'agent', label: 'SSH agent' },
  ];

  form: ConnectionConfig = this.view
    ? { ...this.view, password: '' }
    : { id: '', name: '', kind: 'postgres', host: 'localhost', readOnly: false, color: CONNECTION_COLORS[0] };

  /** Oracle service names live in `database`; the mode only changes the options. */
  oracleMode: 'service' | 'sid' = this.form.options?.['SID'] ? 'sid' : 'service';
  oracleRole = this.form.options?.['DBA PRIVILEGE'] ?? '';

  /** Working copy of the tunnel settings, kept even when the tunnel is off. */
  ssh: SSHConfig = this.view?.ssh
    ? { ...this.view.ssh }
    : { enabled: false, port: 22, method: 'password' };

  readonly busy = signal<'' | 'test' | 'save'>('');
  readonly status = signal<{ text: string; error: boolean } | null>(null);
  private kind = signal(this.form.kind);
  readonly defaultPort = computed(() => String(DEFAULT_PORTS[this.kind()] ?? ''));

  placeholderName() {
    if (this.form.kind === 'sqlite') return this.form.filePath?.split(/[\\/]/).pop() || 'local.db';
    return [this.form.host || 'localhost', this.form.database].filter(Boolean).join(' / ');
  }

  databaseLabel() {
    if (this.form.kind !== 'oracle') return 'Database';
    return this.oracleMode === 'sid' ? 'SID' : 'Service name';
  }

  databasePlaceholder() {
    if (this.form.kind === 'oracle') return this.oracleMode === 'sid' ? 'ORCL' : 'FREEPDB1';
    return this.form.kind === 'postgres' ? 'postgres' : 'optional';
  }

  setKind(k: DbKind) {
    this.form.kind = k;
    this.kind.set(k);
    this.form.port = undefined;
    if (k === 'sqlite') this.ssh.enabled = false;
    this.status.set(null);
  }

  setOracleMode(mode: string) {
    this.oracleMode = mode === 'sid' ? 'sid' : 'service';
  }

  setSSHMethod(method: string) {
    if (method === 'password' || method === 'key' || method === 'agent') this.ssh.method = method;
  }

  async pickFile() {
    const path = await this.api.pickSQLiteFile();
    if (path) this.form.filePath = path;
  }

  async pickKey() {
    const path = await this.api.pickSSHKey();
    if (path) this.ssh.keyPath = path;
  }

  private config(): ConnectionConfig {
    const f = { ...this.form };
    if (!f.name?.trim()) f.name = this.placeholderName();
    f.port = f.port ? Number(f.port) : undefined;

    const options = { ...(f.options ?? {}) };
    if (f.kind === 'oracle') {
      if (this.oracleMode === 'sid' && f.database) options['SID'] = f.database;
      else delete options['SID'];
      if (this.oracleRole) options['DBA PRIVILEGE'] = this.oracleRole;
      else delete options['DBA PRIVILEGE'];
    } else {
      delete options['SID'];
      delete options['DBA PRIVILEGE'];
    }
    f.options = Object.keys(options).length ? options : undefined;

    f.ssh = this.ssh.enabled
      ? { ...this.ssh, port: this.ssh.port ? Number(this.ssh.port) : 22, method: this.ssh.method || 'password' }
      : undefined;
    return f;
  }

  async test() {
    this.busy.set('test');
    this.status.set(null);
    try {
      const version = await this.api.testConnection(this.config());
      this.status.set({ text: `Connection OK: ${version}`, error: false });
    } catch (e) {
      this.status.set({ text: errorText(e), error: true });
    } finally {
      this.busy.set('');
    }
  }

  async save() {
    this.busy.set('save');
    try {
      const saved = await this.store.save(this.config());
      this.ref.close(saved);
    } catch (e) {
      this.status.set({ text: errorText(e), error: true });
    } finally {
      this.busy.set('');
    }
  }

  async remove() {
    if (!this.view) return;
    if (!(await this.confirm.ask(`Delete the connection “${this.view.name}”?`,
      { title: 'Delete connection', confirmLabel: 'Delete', danger: true }))) return;
    await this.store.remove(this.view.id);
    this.ref.close(undefined);
  }
}
