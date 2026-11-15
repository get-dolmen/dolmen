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
  public readonly toastService = inject(Toasts);
  public readonly commandService = inject(Commands);
  public readonly syncStore = inject(SyncStore);
  private tabStore = inject(TabStore);
  private connectionStore = inject(ConnectionStore);
  private schemaStore = inject(SchemaStore);
  private runStore = inject(RunStore);
  private transactionStore = inject(TxStore);
  public readonly modifierKey = MOD;
  private api = inject(Api);

  public readonly info = signal<{ version: string; repo: string; commit: string } | null>(null);
  public readonly updateOpen = signal(false);
  public readonly update = signal<UpdateView>({ state: 'checking' });
  public readonly versionLabel = computed(() => {
    const version = this.info()?.version ?? '';
    if (!version || version === 'dev') return 'dev build';
    return version.startsWith('v') ? version : `v${version}`;
  });
  public readonly progressLabel = computed(() => {
    const progress = this.update().progress;
    return progress === undefined ? '' : ` ${progress}%`;
  });
  public readonly sizeLabel = computed(() => {
    const size = this.update().size ?? 0;
    return size > 0 ? ` (${(size / (1 << 20)).toFixed(0)} MB)` : '';
  });

  private stopProgress?: () => void;

  public toggleUpdate() {
    if (this.busy()) return;
    this.updateOpen.update((open) => !open);
    if (this.updateOpen()) void this.check();
  }

  public closeUpdate() {
    if (!this.busy()) this.updateOpen.set(false);
  }

  /** True while an update is being downloaded or installed. */
  private busy() {
    const state = this.update().state;
    return state === 'downloading' || state === 'installing';
  }

  /** Asks GitHub for the latest release; runs only when the user opens the popover. */
  public async check() {
    this.update.set({ state: 'checking' });
    try {
      const release = await this.api.checkForUpdate();
      this.update.set(release.newer
        ? {
          state: 'newer', latest: release.latest, url: release.url, notes: release.notes,
          canInstall: !!release.asset, size: release.asset?.size,
        }
        : { state: 'latest' });
    } catch (error) {
      this.update.set({ state: 'error', error: errorText(error) });
    }
  }

  /** Downloads the release, installs it over the running copy and restarts. */
  public async install() {
    const update = this.update();
    if (!update.latest || !update.canInstall) return;
    this.update.set({ state: 'downloading', latest: update.latest, canInstall: true });
    try {
      const installed = await this.api.installUpdate(update.latest);
      this.update.set({
        state: 'installed',
        latest: installed.version,
        message: installed.message
          ? `Dolmen ${installed.version}: ${installed.message}.`
          : `Dolmen ${installed.version} is installed. Restarting…`,
      });
      // Write any pending scratch edits before the app goes away.
      await this.tabStore.flush().catch(() => {});
      // The backend restarts Dolmen (or quits so the installer can finish).
      await this.api.restartApp();
    } catch (error) {
      this.update.set({ state: 'error', error: errorText(error) });
    }
  }

  public openRelease() {
    const url = this.update().url;
    if (url) this.api.openReleasePage(url).catch((error) => this.toastService.error(errorText(error)));
  }

  public ngOnDestroy() {
    this.stopProgress?.();
  }

  public readonly connection = computed(() => this.connectionStore.get(this.tabStore.active()?.connId));
  public readonly kindLabel = computed(() => {
    const connection = this.connection();
    return connection ? KIND_LABELS[connection.kind] : '';
  });
  public readonly database = computed(() => this.tabStore.active()?.database ?? '');
  public readonly schemaName = computed(() => {
    const connection = this.connection();
    if (!connection) return '';
    return this.schemaStore.get(this.schemaStore.scopeFor(connection.id, this.database()))?.defaultSchema ?? '';
  });

  public readonly transaction = computed(() => this.transactionStore.get(this.tabStore.activeId()));
  public readonly manualTransaction = computed(() => this.tabStore.active()?.txMode === 'manual');

  private currentTime = signal(Date.now());
  public constructor() {
    this.api.version()
      .then((version) => this.info.set(version))
      .catch(() => this.info.set({ version: 'dev', repo: '', commit: '' }));
    this.stopProgress = EventsOn('update:progress', (progressEvent: { phase: string; received: number; total: number }) => {
      const update = this.update();
      if (update.state !== 'downloading' && update.state !== 'installing') return;
      if (progressEvent.phase === 'download') {
        const percent = progressEvent.total > 0
          ? Math.min(100, Math.floor((progressEvent.received / progressEvent.total) * 100))
          : undefined;
        this.update.set({ ...update, progress: percent });
      } else {
        this.update.set({ ...update, state: 'installing', progress: undefined });
      }
    });
    void this.syncStore.refresh();
    setInterval(() => {
      if (this.runStore.get(this.tabStore.activeId()).running || this.transaction().open) this.currentTime.set(Date.now());
    }, 250);
  }

  public readonly transactionAge = computed(() => {
    const seconds = Math.max(0, Math.round((this.currentTime() - this.transaction().startedAt) / 1000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  });

  public readonly runStatusText = computed(() => {
    const run = this.runStore.runs()[this.tabStore.activeId()];
    if (!run) return '';
    if (run.running) return `Running… ${((this.currentTime() - run.startedAt) / 1000).toFixed(1)} s`;
    if (run.finishedMs === undefined) return '';
    const result = run.results[run.activeResult];
    const rows = result ? ` · ${result.rows.length.toLocaleString()}${result.hasMore ? '+' : ''} rows` : '';
    return `Done in ${run.finishedMs.toLocaleString()} ms${rows}`;
  });
}
