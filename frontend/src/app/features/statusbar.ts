import { Component, computed, inject, signal } from '@angular/core';
import { ConnectionStore } from '../core/connection.store';
import { RunStore } from '../core/run.store';
import { TxStore } from '../core/tx.store';
import { SchemaStore } from '../core/schema.store';
import { TabStore } from '../core/tab.store';
import { Toasts } from '../core/toast';
import { KIND_LABELS } from '../core/models';
import { MOD } from '../core/ui';
import { Api, errorText } from '../core/api';
import { ClickOutside } from '../shared/click-outside';

@Component({
  selector: 'dm-statusbar',
  imports: [ClickOutside],
  template: `
    @if (conn(); as c) {
      <span class="item"><span class="dot" [style.background]="c.color" [style.opacity]="c.connected ? 1 : 0.35"></span>{{ c.name }}</span>
      <span class="item faint">{{ kind() }}{{ database() ? ' · ' + database() : '' }}{{ schemaName() ? ' · ' + schemaName() : '' }}</span>
      @if (c.readOnly) { <span class="item ro">🔒 Read-only</span> }
      @if (!c.connected) { <span class="item faint">Disconnected</span> }
    } @else {
      <span class="item faint">No connection selected</span>
    }
    <span class="spacer"></span>
    @if (tx(); as t) {
      @if (t.open) {
        <span class="item tx">● Transaction open · {{ t.statements }} statement{{ t.statements === 1 ? '' : 's' }} · {{ txAge() }}</span>
      } @else if (manual()) {
        <span class="item faint">Tx: manual</span>
      }
    }
    <span class="item">{{ runText() }}</span>
    <span class="item faint">{{ mod }}P search · {{ mod }}↵ run</span>
    <button class="version" (mousedown)="$event.stopPropagation()" (click)="toggleUpdate()" [class.dev]="!info()?.repo" title="Version: click to check for updates">
      {{ versionLabel() }}
    </button>

    @if (updateOpen()) {
      <div class="update" role="dialog" aria-label="Updates" (dmClickOutside)="updateOpen.set(false)">
        <div class="uhead">
          <svg width="18" height="13" viewBox="0 0 22 16" aria-hidden="true"><path d="M1.6 4.6C1.4 3.6 2.2 3 3.4 2.9L18.6 1.9c1.2-.1 2 .5 1.9 1.5l-.2 1.5c-.1.8-.7 1.2-1.6 1.3L3.2 6.9c-.9 0-1.4-.4-1.5-1.2Z" fill="currentColor"/><path d="M4.2 8.1 7.6 7.9 8 15H3.8ZM14.2 7.5l3.5-.2.6 7.7H14Z" fill="currentColor" opacity=".78"/></svg>
          <b>Dolmen {{ versionLabel() }}</b>
          @if (info()?.commit) { <span class="faint mono">{{ info()!.commit.slice(0, 7) }}</span> }
        </div>
        @switch (update().state) {
          @case ('checking') { <p class="muted">Checking for updates…</p> }
          @case ('latest') { <p>✓ You are running the latest version.</p> }
          @case ('newer') {
            <p><b>{{ update().latest }}</b> is available.</p>
            @if (update().notes) { <pre class="notes">{{ update().notes }}</pre> }
            <button class="btn primary sm" (click)="openRelease()">Open the release page</button>
          }
          @case ('error') { <p class="err">{{ update().error }}</p> }
        }
        @if (update().state !== 'checking') {
          <button class="btn sm ghost again" (click)="check()">Check again</button>
        }
      </div>
    }

    <div class="toasts" aria-live="polite">
      @for (t of toasts.items(); track t.id) {
        <div class="toast" [attr.data-kind]="t.kind" (click)="toasts.dismiss(t.id)">{{ t.text }}</div>
      }
    </div>
  `,
  styles: `
    :host { display: flex; align-items: center; gap: 14px; height: 24px; padding: 0 12px; border-top: 1px solid var(--border); background: var(--bg);
            font-size: var(--fs-xs); color: var(--text-muted); flex: none; position: relative; }
    .item { display: flex; align-items: center; gap: 6px; white-space: nowrap; }
    .item .dot { width: 7px; height: 7px; }
    .ro { color: var(--warn); font-weight: 600; }
    .version { height: 18px; padding: 0 7px; border: 1px solid var(--border); border-radius: 9px; background: none; color: var(--text-muted);
               font: 600 var(--fs-xs) var(--font-ui); font-variant-numeric: tabular-nums; cursor: pointer; }
    .version:hover { background: var(--bg-hover); color: var(--text); }
    .version.dev { border-style: dashed; }
    .update { position: fixed; right: 10px; bottom: 30px; width: 300px; padding: 12px 14px; background: var(--bg-raised); border: 1px solid var(--border);
              border-radius: 10px; box-shadow: var(--shadow); color: var(--text); font-size: var(--fs-sm); z-index: 960; user-select: text; }
    .update p { margin: 8px 0; }
    .uhead { display: flex; align-items: center; gap: 7px; }
    .uhead svg { color: var(--accent); }
    .update .err { color: var(--danger); }
    .notes { max-height: 140px; overflow: auto; margin: 0 0 10px; padding: 8px; border-radius: var(--radius-sm); background: var(--bg-sunken);
             font: 11.5px/1.45 var(--font-mono); white-space: pre-wrap; }
    .again { margin-left: 6px; }
    p + .again { margin-left: -8px; }
    .tx { color: var(--warn); font-weight: 600; }
    .toasts { position: fixed; right: 14px; bottom: 34px; display: flex; flex-direction: column; gap: 8px; z-index: 950; max-width: min(460px, calc(100vw - 28px)); }
    .toast { padding: 9px 12px; border-radius: var(--radius); background: var(--bg-raised); border: 1px solid var(--border); border-left: 3px solid var(--accent);
             box-shadow: var(--shadow); color: var(--text); font-size: var(--fs-sm); cursor: pointer; user-select: text; word-break: break-word; animation: in 0.15s ease-out; }
    .toast[data-kind='error'] { border-left-color: var(--danger); }
    @keyframes in { from { transform: translateY(6px); opacity: 0; } }
  `,
})
export class Statusbar {
  readonly toasts = inject(Toasts);
  private tabs = inject(TabStore);
  private conns = inject(ConnectionStore);
  private schema = inject(SchemaStore);
  private runs = inject(RunStore);
  private txs = inject(TxStore);
  readonly mod = MOD;
  private api = inject(Api);

  readonly info = signal<{ version: string; repo: string; commit: string } | null>(null);
  readonly updateOpen = signal(false);
  readonly update = signal<{ state: 'checking' | 'latest' | 'newer' | 'error'; latest?: string; url?: string; notes?: string; error?: string }>({ state: 'checking' });
  readonly versionLabel = computed(() => {
    const v = this.info()?.version ?? '';
    return !v || v === 'dev' ? 'dev build' : v.startsWith('v') ? v : `v${v}`;
  });

  toggleUpdate() {
    this.updateOpen.update((o) => !o);
    if (this.updateOpen()) void this.check();
  }

  /** Asks GitHub for the latest release; runs only when the user opens the popover. */
  async check() {
    this.update.set({ state: 'checking' });
    try {
      const u = await this.api.checkForUpdate();
      this.update.set(u.newer ? { state: 'newer', latest: u.latest, url: u.url, notes: u.notes } : { state: 'latest' });
    } catch (e) {
      this.update.set({ state: 'error', error: errorText(e) });
    }
  }

  openRelease() {
    const url = this.update().url;
    if (url) this.api.openReleasePage(url).catch((e) => this.toasts.error(errorText(e)));
  }

  readonly conn = computed(() => this.conns.get(this.tabs.active()?.connId));
  readonly kind = computed(() => (this.conn() ? KIND_LABELS[this.conn()!.kind] : ''));
  readonly database = computed(() => this.tabs.active()?.database ?? '');
  readonly schemaName = computed(() => {
    const c = this.conn();
    return c ? this.schema.get(this.schema.scope(c.id, this.database()))?.defaultSchema ?? '' : '';
  });

  readonly tx = computed(() => this.txs.get(this.tabs.activeId()));
  readonly manual = computed(() => this.tabs.active()?.txMode === 'manual');

  private now = signal(Date.now());
  constructor() {
    this.api.version().then((v) => this.info.set(v)).catch(() => this.info.set({ version: 'dev', repo: '', commit: '' }));
    setInterval(() => {
      if (this.runs.get(this.tabs.activeId()).running || this.tx().open) this.now.set(Date.now());
    }, 250);
  }

  readonly txAge = computed(() => {
    const s = Math.max(0, Math.round((this.now() - this.tx().startedAt) / 1000));
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  });

  readonly runText = computed(() => {
    const run = this.runs.runs()[this.tabs.activeId()];
    if (!run) return '';
    if (run.running) return `Running… ${((this.now() - run.startedAt) / 1000).toFixed(1)} s`;
    if (run.finishedMs === undefined) return '';
    const r = run.results[run.activeResult];
    const rows = r ? ` · ${r.rows.length.toLocaleString()}${r.hasMore ? '+' : ''} rows` : '';
    return `Done in ${run.finishedMs.toLocaleString()} ms${rows}`;
  });
}
