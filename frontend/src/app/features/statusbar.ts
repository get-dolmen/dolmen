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
  styleUrl: './statusbar.scss',
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
