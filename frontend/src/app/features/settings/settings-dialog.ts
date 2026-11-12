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
  template: `
    <div class="dialog settings">
      <header>
        <h2>Settings</h2>
      </header>
      <div class="body">
        <section class="group">
          <h3>Appearance</h3>
          <div class="field">
            <span class="label">Theme</span>
            <div class="choices" role="radiogroup" aria-label="Theme">
              @for (t of themes; track t.value) {
                <button type="button" class="choice" role="radio" [class.on]="ui.theme() === t.value"
                        [attr.aria-checked]="ui.theme() === t.value" (click)="ui.theme.set(t.value)">
                  <span class="preview" [attr.data-preview]="t.value" aria-hidden="true">
                    <span class="bar"></span><span class="pane"></span>
                  </span>
                  <span class="name">{{ t.label }}</span>
                  <span class="hint">{{ t.hint }}</span>
                </button>
              }
            </div>
          </div>

          <div class="field">
            <span class="label">Scratch files</span>
            <div class="choices two" role="radiogroup" aria-label="Scratch panel position">
              <button type="button" class="choice" role="radio" [class.on]="ui.scratchPosition() === 'explorer'"
                      [attr.aria-checked]="ui.scratchPosition() === 'explorer'" (click)="ui.scratchPosition.set('explorer')">
                <span class="preview dock" aria-hidden="true">
                  <span class="work"><span class="explorer"><span class="scratches"></span></span></span>
                </span>
                <span class="name">Explorer</span>
                <span class="hint">Bottom of the right sidebar</span>
              </button>
              <button type="button" class="choice" role="radio" [class.on]="ui.scratchPosition() === 'left'"
                      [attr.aria-checked]="ui.scratchPosition() === 'left'" (click)="ui.scratchPosition.set('left')">
                <span class="preview dock" aria-hidden="true">
                  <span class="work"><span class="left-dock"></span><span class="main-pane"></span><span class="explorer"></span></span>
                </span>
                <span class="name">Left panel</span>
                <span class="hint">Full-height pane, above the tab bar</span>
              </button>
            </div>
          </div>
        </section>

        <section class="group">
          <h3>Git sync</h3>
          <div class="form">
            <label class="check">
              <input type="checkbox" name="syncEnabled" [(ngModel)]="form.enabled" />
              <span>
                <b>Sync connections and scratch files through Git</b>
                <small class="muted">Dolmen keeps a small repository in <span class="mono">{{ status()?.dir || '…' }}</span> and exchanges it with this remote.</small>
              </span>
            </label>

            <label class="stack">Remote
              <input class="input mono" name="remote" [(ngModel)]="form.remote"
                     placeholder="git@github.com:you/dolmen-sync.git — or a bare local repository (file://…)" spellcheck="false" />
            </label>
            <div class="two-col">
              <label class="stack">Branch
                <input class="input mono" name="branch" [(ngModel)]="form.branch" placeholder="main" spellcheck="false" />
              </label>
              <label class="check inline">
                <input type="checkbox" name="encrypted" [(ngModel)]="form.encrypted" />
                <span>
                  <b>Encrypt with a master password</b>
                  <small class="muted">AES-256-GCM, key derived with PBKDF2</small>
                </span>
              </label>
            </div>

            @if (form.encrypted) {
              <label class="stack">Master password
                <input class="input" name="password" type="password" [ngModel]="password()" (ngModelChange)="password.set($event)"
                       placeholder="Kept in memory for this session" autocomplete="off" />
              </label>
              <p class="note">The password is never written to disk; use the same one on every machine. Encryption applies to new commits, so earlier commits of the repository may still contain plain text.</p>
            } @else {
              <p class="note warn">Without a master password, the Git repository contains connection passwords in plain text.</p>
            }

            @if (status(); as s) {
              @if (!s.gitAvailable) {
                <p class="note warn">Git is not installed or not on PATH. Install git to sync.</p>
              }
              @if (s.lastError) {
                <p class="note err mono">{{ s.lastError }}</p>
              }
              @if (s.lastSyncAt) {
                <p class="note ok">
                  Last sync {{ when(s.lastSyncAt) }}
                  @if (s.lastCommit) { · commit <span class="mono">{{ s.lastCommit }}</span> }
                </p>
              }
            }
          </div>
          <div class="actions">
            <button type="button" class="btn" (click)="save()" [disabled]="busy() !== null">Save</button>
            <button type="button" class="btn primary" (click)="sync()" [disabled]="busy() !== null || !form.enabled || status()?.gitAvailable === false">
              {{ busy() === 'sync' ? 'Syncing…' : 'Sync now' }}
            </button>
          </div>
        </section>
      </div>
      <footer>
        <span class="spacer"></span>
        <button type="button" class="btn primary" (click)="ref.close()">Done</button>
      </footer>
    </div>
  `,
  styles: `
    .settings { width: 600px; max-width: 94vw; }
    h3 { margin: 2px 0 10px; font-size: var(--fs-xs); font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-muted); }
    .group + .group { margin-top: 20px; padding-top: 18px; border-top: 1px solid var(--border); }
    .field { display: flex; flex-direction: column; gap: 6px; }
    .field + .field { margin-top: 14px; }
    .field > .label { font-size: var(--fs-sm); color: var(--text-muted); }
    .choices { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
    .choices.two { grid-template-columns: repeat(2, 1fr); }
    .choice { display: flex; flex-direction: column; align-items: stretch; gap: 5px; padding: 8px; text-align: left;
              border: 1px solid var(--border-strong); border-radius: var(--radius); background: var(--bg-panel); color: var(--text); cursor: pointer; }
    .choice:hover { background: var(--bg-hover); }
    .choice.on { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); background: var(--accent-soft); }
    .preview { display: flex; height: 44px; overflow: hidden; border: 1px solid var(--border); border-radius: var(--radius-sm); background: #f6f5f2; }
    .preview .bar { width: 28%; background: #eceae5; border-right: 1px solid #dedbd3; }
    .preview .pane { flex: 1; background: #ffffff; }
    .preview[data-preview='dark'] { background: #1b1a18; }
    .preview[data-preview='dark'] .bar { background: #171614; border-color: #34322d; }
    .preview[data-preview='dark'] .pane { background: #22211e; }
    .preview[data-preview='system'] { background: linear-gradient(105deg, #f6f5f2 50%, #1b1a18 50%); }
    .preview[data-preview='system'] .bar { background: transparent; border-right-color: transparent; background-image: linear-gradient(105deg, #eceae5 50%, #171614 50%); }
    .preview[data-preview='system'] .pane { background: linear-gradient(105deg, #ffffff 50%, #22211e 50%); }
    .preview.dock { padding: 0; background: var(--bg); }
    .preview.dock .work { display: flex; flex: 1; gap: 3px; padding: 4px; }
    .preview.dock .explorer { display: flex; flex: 0 0 34%; flex-direction: column; justify-content: flex-end; padding: 3px; background: var(--bg-panel); border: 1px solid var(--border); border-radius: 2px; }
    .preview.dock .scratches { height: 40%; background: var(--accent-soft); border: 1px solid var(--accent); border-radius: 1px; }
    .preview.dock .main-pane { flex: 1; background: var(--bg-panel); border: 1px solid var(--border); border-radius: 2px; }
    .preview.dock .left-dock { flex: 0 0 34%; background: var(--accent-soft); border: 1px solid var(--accent); border-radius: 2px; }
    .name { font-weight: 600; }
    .hint { font-size: var(--fs-xs); color: var(--text-faint); line-height: 1.25; }
    .form { display: flex; flex-direction: column; gap: 10px; }
    .stack { display: flex; flex-direction: column; gap: 4px; font-size: var(--fs-sm); color: var(--text-muted); }
    .two-col { display: grid; grid-template-columns: 180px 1fr; gap: 12px; align-items: end; }
    .check { display: flex; align-items: flex-start; gap: 8px; color: var(--text); cursor: pointer; }
    .check input { margin-top: 3px; accent-color: var(--accent); }
    .check span { display: flex; flex-direction: column; gap: 1px; }
    .check.inline { align-items: flex-start; padding-bottom: 2px; }
    .note { margin: 0; font-size: var(--fs-xs); color: var(--text-faint); line-height: 1.4; user-select: text; }
    .note.warn { color: var(--warn); }
    .note.err { color: var(--danger); white-space: pre-wrap; word-break: break-word; max-height: 90px; overflow: auto; }
    .note.ok { color: var(--accent); }
    .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
  `,
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
