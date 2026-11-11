import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { Api, errorText } from '../../core/api';
import { ConnectionStore } from '../../core/connection.store';
import {
  CONNECTION_COLORS, DEFAULT_PORTS, KIND_LABELS,
  type ConnectionConfig, type ConnectionView, type DbKind,
} from '../../core/models';

@Component({
  selector: 'dm-connection-dialog',
  imports: [FormsModule],
  template: `
    <form class="dialog" (ngSubmit)="save()" autocomplete="off">
      <header>
        <h2>{{ editing ? 'Edit connection' : 'New connection' }}</h2>
      </header>
      <div class="body">
        <div class="kinds" role="radiogroup" aria-label="Database type">
          @for (k of kinds; track k) {
            <button type="button" role="radio" class="kind" [class.on]="form.kind === k" [attr.aria-checked]="form.kind === k"
                    (click)="setKind(k)">{{ labels[k] }}</button>
          }
        </div>

        <div class="grid">
          <label class="full">Name
            <input class="input" name="name" [(ngModel)]="form.name" required [placeholder]="placeholderName()" />
          </label>

          @if (form.kind === 'sqlite') {
            <label class="full">Database file
              <span class="row">
                <input class="input mono" name="filePath" [(ngModel)]="form.filePath" placeholder="/path/to/database.db" />
                <button type="button" class="btn" (click)="pickFile()">Browse…</button>
              </span>
            </label>
          } @else {
            <label class="host">Host
              <input class="input" name="host" [(ngModel)]="form.host" placeholder="localhost" />
            </label>
            <label class="port">Port
              <input class="input" name="port" type="number" [(ngModel)]="form.port" [placeholder]="defaultPort()" />
            </label>
            <label class="full">{{ form.kind === 'oracle' ? 'Service name' : 'Database' }}
              <input class="input" name="database" [(ngModel)]="form.database"
                     [placeholder]="form.kind === 'oracle' ? 'FREEPDB1' : form.kind === 'postgres' ? 'postgres' : 'optional'" />
            </label>
            <label>User
              <input class="input" name="user" [(ngModel)]="form.user" />
            </label>
            <label>Password
              <input class="input" name="password" type="password" [(ngModel)]="form.password"
                     [placeholder]="view?.hasPassword ? '•••••• (unchanged)' : ''" />
            </label>
          }
        </div>

        <div class="opts">
          <label class="check">
            <input type="checkbox" name="readOnly" [(ngModel)]="form.readOnly" />
            <span>
              <b>Read-only</b>
              <small class="muted">Blocks writes in the database session and rejects anything but queries.</small>
            </span>
          </label>
          <div class="colors" role="radiogroup" aria-label="Colour">
            <span class="muted">Colour</span>
            @for (c of colors; track c) {
              <button type="button" class="swatch" role="radio" [style.background]="c" [class.on]="form.color === c"
                      [attr.aria-checked]="form.color === c" [attr.aria-label]="c" (click)="form.color = c"></button>
            }
          </div>
        </div>

        @if (status(); as s) {
          <p class="status" [class.err]="s.error">{{ s.text }}</p>
        }
      </div>
      <footer>
        @if (editing) {
          <button type="button" class="btn danger" (click)="remove()">Delete</button>
        }
        <span class="spacer"></span>
        <button type="button" class="btn" (click)="test()" [disabled]="busy()">{{ busy() === 'test' ? 'Testing…' : 'Test' }}</button>
        <button type="button" class="btn" (click)="ref.close()">Cancel</button>
        <button type="submit" class="btn primary" [disabled]="busy()">Save &amp; connect</button>
      </footer>
    </form>
  `,
  styles: `
    .kinds { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin-bottom: 14px; }
    .kind { height: 34px; border: 1px solid var(--border-strong); border-radius: var(--radius); background: var(--bg-panel); cursor: pointer; font-weight: 500; }
    .kind:hover { background: var(--bg-hover); }
    .kind.on { border-color: var(--accent); background: var(--accent-soft); color: var(--text); box-shadow: inset 0 0 0 1px var(--accent); }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 12px; }
    .grid .host { grid-column: 1; } .grid .port { grid-column: 2; }
    .full { grid-column: 1 / -1; }
    label { display: flex; flex-direction: column; gap: 4px; font-size: var(--fs-sm); color: var(--text-muted); }
    .row { display: flex; gap: 6px; }
    .opts { display: flex; flex-direction: column; gap: 12px; margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--border); }
    .check { flex-direction: row; align-items: flex-start; gap: 8px; color: var(--text); cursor: pointer; }
    .check input { margin-top: 3px; accent-color: var(--accent); }
    .check span { display: flex; flex-direction: column; gap: 1px; }
    .colors { display: flex; align-items: center; gap: 6px; font-size: var(--fs-sm); }
    .colors .muted { margin-right: 4px; }
    .swatch { width: 18px; height: 18px; border-radius: 50%; border: 2px solid transparent; cursor: pointer; padding: 0; }
    .swatch.on { box-shadow: 0 0 0 2px var(--bg-raised), 0 0 0 4px var(--text-muted); }
    .status { margin: 14px 0 2px; padding: 8px 10px; border-radius: var(--radius); background: var(--accent-soft); font-size: var(--fs-sm); user-select: text; word-break: break-word; }
    .status.err { background: var(--danger-soft); color: var(--danger); }
  `,
})
export class ConnectionDialog {
  readonly ref = inject<DialogRef<ConnectionView | undefined>>(DialogRef);
  readonly view = inject<ConnectionView | undefined>(DIALOG_DATA);
  private api = inject(Api);
  private store = inject(ConnectionStore);

  readonly kinds: DbKind[] = ['postgres', 'mysql', 'oracle', 'sqlite'];
  readonly labels = KIND_LABELS;
  readonly colors = CONNECTION_COLORS;
  readonly editing = !!this.view;

  form: ConnectionConfig = this.view
    ? { ...this.view, password: '' }
    : { id: '', name: '', kind: 'postgres', host: 'localhost', readOnly: false, color: CONNECTION_COLORS[0] };

  readonly busy = signal<'' | 'test' | 'save'>('');
  readonly status = signal<{ text: string; error: boolean } | null>(null);
  private kind = signal(this.form.kind);
  readonly defaultPort = computed(() => String(DEFAULT_PORTS[this.kind()] ?? ''));

  placeholderName() {
    if (this.form.kind === 'sqlite') return this.form.filePath?.split(/[\\/]/).pop() || 'local.db';
    return [this.form.host || 'localhost', this.form.database].filter(Boolean).join(' / ');
  }

  setKind(k: DbKind) {
    this.form.kind = k;
    this.kind.set(k);
    this.form.port = undefined;
    this.status.set(null);
  }

  async pickFile() {
    const path = await this.api.pickSQLiteFile();
    if (path) this.form.filePath = path;
  }

  private config(): ConnectionConfig {
    const f = { ...this.form };
    if (!f.name?.trim()) f.name = this.placeholderName();
    f.port = f.port ? Number(f.port) : undefined;
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
    if (!this.view || !confirm(`Delete the connection “${this.view.name}”?`)) return;
    await this.store.remove(this.view.id);
    this.ref.close(undefined);
  }
}
