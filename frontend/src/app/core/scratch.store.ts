import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { Api, errorText } from './api';
import { EditorBridge } from './editor-bridge';
import { TabStore } from './tab.store';
import { TxStore } from './tx.store';
import { Toasts } from './toast';
import { Confirm } from '../shared/confirm';
import type { ScratchInfo } from './models';

/**
 * Scratch files: SQL files linked to a connection (and database), kept
 * independently of tabs. Open tabs are the live copy; the list merges them in
 * so names and links update immediately.
 */
@Injectable({ providedIn: 'root' })
export class ScratchStore {
  private api = inject(Api);
  private tabStore = inject(TabStore);
  private editorBridge = inject(EditorBridge);
  private toastService = inject(Toasts);
  private transactionStore = inject(TxStore);
  private confirmDialog = inject(Confirm);

  private persisted = signal<ScratchInfo[]>([]);
  private timer?: ReturnType<typeof setTimeout>;
  /** Guards against a stale list response overwriting a newer one. */
  private refreshId = 0;

  /** Every scratch, most recently edited first, with open tabs' live names and links. */
  public readonly list = computed<ScratchInfo[]>(() => {
    const open = new Map(
      this.tabStore
        .tabs()
        .filter((tab) => tab.kind === 'sql')
        .map((tab) => [tab.id, tab]),
    );
    const seen = new Set<string>();
    const entries = this.persisted().map((scratch) => {
      seen.add(scratch.id);
      const tab = open.get(scratch.id);
      return tab
        ? {
            ...scratch,
            name: tab.name,
            connId: tab.connId,
            database: tab.database,
            locked: tab.locked,
          }
        : scratch;
    });
    for (const tab of open.values()) {
      if (!seen.has(tab.id) && tab.content.trim()) {
        entries.unshift({
          id: tab.id,
          name: tab.name,
          connId: tab.connId,
          database: tab.database,
          locked: tab.locked,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          size: tab.content.length,
        });
      }
    }
    return entries;
  });

  public readonly openIds = computed(() => new Set(this.tabStore.tabs().map((tab) => tab.id)));

  public constructor() {
    this.tabStore.takenNames = () => this.persisted().map((scratch) => scratch.name);
    // Refresh after tab changes have been written (layout and content saves are debounced).
    effect(() => {
      this.tabStore.tabs();
      untracked(() => this.refreshSoon());
    });
  }

  public refreshSoon(delayMilliseconds = 900) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.refresh(), delayMilliseconds);
  }

  public async refresh() {
    const generation = ++this.refreshId;
    try {
      const scratches = await this.api.listScratches();
      if (generation === this.refreshId) this.persisted.set(scratches);
    } catch (error) {
      this.toastService.error(errorText(error));
    }
  }

  /**
   * Brings open tabs in line with the files a sync just wrote: adopts remote
   * edits, and closes tabs whose scratch was deleted elsewhere (unless the
   * tab has unsaved changes, which would otherwise be lost).
   */
  public async reloadOpen() {
    for (const tab of this.tabStore.tabs().filter((tab) => tab.kind === 'sql')) {
      try {
        const remote = await this.api.openScratch(tab.id);
        const current = this.tabStore.get(tab.id);
        if (!current || current.dirty) continue;
        const content = remote.content ?? '';
        if (content === current.content) continue;
        this.tabStore.adoptContent(tab.id, content);
        this.editorBridge.replaceContent(tab.id, content);
      } catch (error) {
        const message = errorText(error);
        const current = this.tabStore.get(tab.id);
        if (!current) continue;
        if (!/not found/i.test(message)) {
          this.toastService.error(`${current.name}: ${message}`);
          continue;
        }
        if (current.dirty) {
          this.toastService.error(
            `${current.name} was deleted by the sync but has unsaved changes.`,
          );
          continue;
        }
        await this.tabStore.close(tab.id);
        this.toastService.error(`${current.name} was deleted by the sync.`);
      }
    }
    await this.refresh();
  }

  /** Opens a scratch, or focuses its tab when already open. */
  public async open(id: string) {
    if (this.tabStore.get(id)) return this.tabStore.activate(id);
    try {
      this.tabStore.openScratch(await this.api.openScratch(id));
    } catch (error) {
      this.toastService.error(errorText(error));
    }
  }

  public async rename(id: string, name: string) {
    name = name.trim();
    if (!name) return;
    await this.tabStore.flush(id);
    try {
      const clean = await this.api.renameScratch(id, name);
      if (this.tabStore.get(id)) this.tabStore.setName(id, clean);
      await this.refresh();
    } catch (error) {
      this.toastService.error(errorText(error));
    }
  }

  public async remove(id: string): Promise<boolean> {
    const scratch = this.list().find((scratch) => scratch.id === id);
    if (
      !(await this.confirmDialog.ask(
        `Delete the scratch file “${scratch?.name ?? id}”? This cannot be undone.`,
        { title: 'Delete scratch file', confirmLabel: 'Delete', danger: true },
      ))
    )
      return false;
    try {
      // Closing waits for the tab's last write; deleting only afterwards keeps
      // an in-flight save from recreating the file.
      if (this.tabStore.get(id)) await this.tabStore.close(id);
      await this.api.deleteScratch(id);
      this.persisted.update((scratches) => scratches.filter((scratch) => scratch.id !== id));
      await this.refresh();
      return true;
    } catch (error) {
      this.toastService.error(errorText(error));
      return false;
    }
  }

  public async duplicate(id: string) {
    await this.tabStore.flush(id);
    const source = this.list().find((scratch) => scratch.id === id);
    const baseName = (source?.name ?? 'query.sql').replace(/\.sql$/i, '');
    const takenNames = new Set(this.list().map((scratch) => scratch.name));
    let name = `${baseName} copy.sql`;
    for (let copyIndex = 2; takenNames.has(name); copyIndex++)
      name = `${baseName} copy ${copyIndex}.sql`;
    try {
      this.tabStore.openScratch(await this.api.duplicateScratch(id, crypto.randomUUID(), name));
      await this.refresh();
    } catch (error) {
      this.toastService.error(errorText(error));
    }
  }

  /** A name not used by any scratch: "users.sql", "users 2.sql", … */
  public freeName(baseName: string): string {
    baseName = baseName.replace(/\.sql$/i, '');
    const takenNames = new Set(this.list().map((scratch) => scratch.name));
    let name = `${baseName}.sql`;
    for (let copyIndex = 2; takenNames.has(name); copyIndex++)
      name = `${baseName} ${copyIndex}.sql`;
    return name;
  }

  /** Creates a scratch filed under a connection / database / table folder and opens it. */
  public async createIn(
    target: { connId: string; database: string; schema?: string; table?: string },
    content = '',
    name?: string,
  ) {
    try {
      const created = await this.api.createScratch(
        crypto.randomUUID(),
        name ?? this.freeName(target.table || 'query'),
        target.connId,
        target.database,
        target.table ? (target.schema ?? '') : '',
        target.table ?? '',
        content,
      );
      const tab = this.tabStore.openScratch(created);
      await this.refresh();
      return tab;
    } catch (error) {
      this.toastService.error(errorText(error));
      return undefined;
    }
  }

  /** Moves a scratch to another folder. An open tab follows the new connection / database. */
  public async moveTo(
    id: string,
    target: { connId: string; database: string; schema: string; table: string },
  ) {
    const locked =
      this.tabStore.get(id)?.locked ??
      this.persisted().find((scratch) => scratch.id === id)?.locked;
    if (locked) {
      this.toastService.error('This scratch is locked to its folder. Unlock it first.');
      return;
    }
    const tab = this.tabStore.get(id);
    if (tab && (tab.connId !== target.connId || tab.database !== target.database)) {
      if (!(await this.transactionStore.confirmLeave(id))) return;
      this.tabStore.setConnection(id, target.connId, target.database);
    }
    try {
      await this.api.linkScratch(id, target.connId, target.database, target.schema, target.table);
      await this.refresh();
    } catch (error) {
      this.toastService.error(errorText(error));
    }
  }

  /** Pins or unpins a scratch's connection, database and folder. */
  public async setLocked(id: string, locked: boolean) {
    try {
      // The backend stores the lock with the scratch: let it see the tab first.
      await this.tabStore.flush(id);
      await this.tabStore.saveLayoutNow();
      await this.api.setScratchLock(id, locked);
      this.tabStore.setLocked(id, locked);
      this.persisted.update((scratches) =>
        scratches.map((scratch) => (scratch.id === id ? { ...scratch, locked } : scratch)),
      );
    } catch (error) {
      this.toastService.error(errorText(error));
    }
  }

  /** Writes a copy to a .sql file chosen by the user. */
  public async exportFile(id: string) {
    await this.tabStore.flush(id);
    try {
      const path = await this.api.exportScratch(id);
      if (path) this.toastService.success(`Saved a copy to ${path}`);
    } catch (error) {
      this.toastService.error(errorText(error));
    }
  }

  /** Opens a .sql file from disk as a new scratch, linked to the current tab's connection. */
  public async importFile() {
    const active = this.tabStore.active();
    try {
      const tab = await this.api.importScratch(
        crypto.randomUUID(),
        active?.connId ?? '',
        active?.database ?? '',
      );
      if (!tab?.id) return;
      this.tabStore.openScratch(tab);
      await this.refresh();
    } catch (error) {
      this.toastService.error(errorText(error));
    }
  }

  /** ⌘S on a SQL tab: write now (content also autosaves). */
  public async save(id: string) {
    const tab = this.tabStore.get(id);
    if (!tab) return;
    await this.tabStore.flush(id);
    this.toastService.success(`Saved ${tab.name}`);
    this.refreshSoon(300);
  }
}
