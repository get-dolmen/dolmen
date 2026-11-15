import { Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { Commands } from '../core/commands';
import { ConnectionStore } from '../core/connection.store';
import { RunStore } from '../core/run.store';
import { TxStore } from '../core/tx.store';
import { SchemaStore } from '../core/schema.store';
import { SyncStore } from '../core/sync.store';
import { TabStore } from '../core/tab.store';
import { Toasts } from '../core/toast';
import { KIND_LABELS } from '../core/models';
import { MOD } from '../core/ui';
import { Api, errorText } from '../core/api';
import { ClickOutside } from '../shared/click-outside';
import { EventsOn } from '../../../wailsjs/runtime';

export type UpdateState = 'checking' | 'latest' | 'newer' | 'downloading' | 'installing' | 'installed' | 'error';

export interface UpdateView {
  state: UpdateState;
  latest?: string;
  url?: string;
  notes?: string;
  error?: string;
  canInstall?: boolean;
  size?: number;
  /** Download percentage, undefined while the size is unknown. */
  progress?: number;
  /** Message shown once the update is installed. */
  message?: string;
}

@Component({
  selector: 'dm-statusbar',
  imports: [ClickOutside],
  templateUrl: './statusbar.html',
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
    .sync { height: 18px; padding: 0 7px; border: 1px solid var(--border); border-radius: 9px; background: none; color: var(--text-muted);
            font: 600 var(--fs-xs) var(--font-ui); cursor: pointer; white-space: nowrap; }
    .sync:hover { background: var(--bg-hover); color: var(--text); }
    .sync.err { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 40%, transparent); }
    .update { position: fixed; right: 10px; bottom: 30px; width: 300px; padding: 12px 14px; background: var(--bg-raised); border: 1px solid var(--border);
              border-radius: 10px; box-shadow: var(--shadow); color: var(--text); font-size: var(--fs-sm); z-index: 960; user-select: text; }
    .update p { margin: 8px 0; }
    .uhead { display: flex; align-items: center; gap: 7px; }
    .uhead svg { color: var(--accent); }
    .update .err { color: var(--danger); }
    .update .warn { color: var(--warn); font-size: var(--fs-xs); }
    .notes { max-height: 140px; overflow: auto; margin: 0 0 10px; padding: 8px; border-radius: var(--radius-sm); background: var(--bg-sunken);
             font: 11.5px/1.45 var(--font-mono); white-space: pre-wrap; }
    .again { margin-left: 6px; }
    p + .again { margin-left: -8px; }
    .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 10px; }
    .bar { height: 4px; margin: 2px 0 8px; border-radius: 2px; background: var(--bg-sunken); overflow: hidden; }
    .bar span { display: block; height: 100%; background: var(--accent); transition: width 0.15s linear; }
    .bar.unknown span { animation: pulse 1.1s ease-in-out infinite; opacity: 0.55; }
    @keyframes pulse { 50% { opacity: 0.2; } }
    .tx { color: var(--warn); font-weight: 600; }
    .toasts { position: fixed; right: 14px; bottom: 34px; display: flex; flex-direction: column; gap: 8px; z-index: 950; max-width: min(460px, calc(100vw - 28px)); }
    .toast { padding: 9px 12px; border-radius: var(--radius); background: var(--bg-raised); border: 1px solid var(--border); border-left: 3px solid var(--accent);
             box-shadow: var(--shadow); color: var(--text); font-size: var(--fs-sm); cursor: pointer; user-select: text; word-break: break-word; animation: in 0.15s ease-out; }
    .toast[data-kind='error'] { border-left-color: var(--danger); }
    @keyframes in { from { transform: translateY(6px); opacity: 0; } }
  `,
})
export class Statusbar implements OnDestroy {
  readonly toasts = inject(Toasts);
  readonly cmds = inject(Commands);
  readonly sync = inject(SyncStore);
  private tabs = inject(TabStore);
  private conns = inject(ConnectionStore);
  private schema = inject(SchemaStore);
  private runs = inject(RunStore);
  private txs = inject(TxStore);
  readonly mod = MOD;
  private api = inject(Api);

  readonly info = signal<{ version: string; repo: string; commit: string } | null>(null);
  readonly updateOpen = signal(false);
  readonly update = signal<UpdateView>({ state: 'checking' });
  readonly versionLabel = computed(() => {
    const v = this.info()?.version ?? '';
    return !v || v === 'dev' ? 'dev build' : v.startsWith('v') ? v : `v${v}`;
  });
  readonly progressLabel = computed(() => {
    const p = this.update().progress;
    return p === undefined ? '' : ` ${p}%`;
  });
  readonly sizeLabel = computed(() => {
    const size = this.update().size ?? 0;
    return size > 0 ? ` (${(size / (1 << 20)).toFixed(0)} MB)` : '';
  });

  private stopProgress?: () => void;

  toggleUpdate() {
    if (this.busy()) return;
    this.updateOpen.update((o) => !o);
    if (this.updateOpen()) void this.check();
  }

  closeUpdate() {
    if (!this.busy()) this.updateOpen.set(false);
  }

  /** True while an update is being downloaded or installed. */
  private busy() {
    const state = this.update().state;
    return state === 'downloading' || state === 'installing';
  }

  /** Asks GitHub for the latest release; runs only when the user opens the popover. */
  async check() {
    this.update.set({ state: 'checking' });
    try {
      const u = await this.api.checkForUpdate();
      this.update.set(u.newer
        ? { state: 'newer', latest: u.latest, url: u.url, notes: u.notes, canInstall: !!u.asset, size: u.asset?.size }
        : { state: 'latest' });
    } catch (e) {
      this.update.set({ state: 'error', error: errorText(e) });
    }
  }

  /** Downloads the release, installs it over the running copy and restarts. */
  async install() {
    const u = this.update();
    if (!u.latest || !u.canInstall) return;
    this.update.set({ state: 'downloading', latest: u.latest, canInstall: true });
    try {
      const done = await this.api.installUpdate(u.latest);
      this.update.set({
        state: 'installed',
        latest: done.version,
        message: done.message
          ? `Dolmen ${done.version}: ${done.message}.`
          : `Dolmen ${done.version} is installed. Restarting…`,
      });
      // Write any pending scratch edits before the app goes away.
      await this.tabs.flush().catch(() => {});
      // The backend restarts Dolmen (or quits so the installer can finish).
      await this.api.restartApp();
    } catch (e) {
      this.update.set({ state: 'error', error: errorText(e) });
    }
  }

  openRelease() {
    const url = this.update().url;
    if (url) this.api.openReleasePage(url).catch((e) => this.toasts.error(errorText(e)));
  }

  ngOnDestroy() {
    this.stopProgress?.();
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
    this.stopProgress = EventsOn('update:progress', (p: { phase: string; received: number; total: number }) => {
      const u = this.update();
      if (u.state !== 'downloading' && u.state !== 'installing') return;
      if (p.phase === 'download') {
        const progress = p.total > 0 ? Math.min(100, Math.floor((p.received / p.total) * 100)) : undefined;
        this.update.set({ ...u, progress });
      } else {
        this.update.set({ ...u, state: 'installing', progress: undefined });
      }
    });
    void this.sync.refresh();
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
