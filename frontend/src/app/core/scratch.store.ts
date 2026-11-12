import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { Api, errorText } from './api';
import { EditorBridge } from './editor-bridge';
import { TabStore } from './tab.store';
import { TxStore } from './tx.store';
import { Toasts } from './toast';
import type { ScratchInfo } from './models';

/**
 * Scratch files: SQL files linked to a connection (and database), kept
 * independently of tabs. Open tabs are the live copy; the list merges them in
 * so names and links update immediately.
 */
@Injectable({ providedIn: 'root' })
export class ScratchStore {
  private api = inject(Api);
  private tabs = inject(TabStore);
  private editor = inject(EditorBridge);
  private toasts = inject(Toasts);
  private tx = inject(TxStore);

  private saved = signal<ScratchInfo[]>([]);
  private timer?: ReturnType<typeof setTimeout>;
  /** Guards against a stale list response overwriting a newer one. */
  private refreshId = 0;

  /** Every scratch, most recently edited first, with open tabs' live names and links. */
  readonly list = computed<ScratchInfo[]>(() => {
    const open = new Map(this.tabs.tabs().filter((t) => t.kind === 'sql').map((t) => [t.id, t]));
    const seen = new Set<string>();
    const out = this.saved().map((s) => {
      seen.add(s.id);
      const t = open.get(s.id);
      return t ? { ...s, name: t.name, connId: t.connId, database: t.database } : s;
    });
    for (const t of open.values()) {
      if (!seen.has(t.id) && t.content.trim()) {
        out.unshift({ id: t.id, name: t.name, connId: t.connId, database: t.database, createdAt: Date.now(), updatedAt: Date.now(), size: t.content.length });
      }
    }
    return out;
  });

  readonly openIds = computed(() => new Set(this.tabs.tabs().map((t) => t.id)));

  constructor() {
    this.tabs.takenNames = () => this.saved().map((s) => s.name);
    // Refresh after tab changes have been written (layout and content saves are debounced).
    effect(() => {
      this.tabs.tabs();
      untracked(() => this.refreshSoon());
    });
  }

  refreshSoon(ms = 900) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.refresh(), ms);
  }

  async refresh() {
    const gen = ++this.refreshId;
    try {
      const list = await this.api.listScratches();
      if (gen === this.refreshId) this.saved.set(list);
    } catch (e) {
      this.toasts.error(errorText(e));
    }
  }

  /**
   * Brings open tabs in line with the files a sync just wrote: adopts remote
   * edits, and closes tabs whose scratch was deleted elsewhere (unless the
   * tab has unsaved changes, which would otherwise be lost).
   */
  async reloadOpen() {
    for (const t of this.tabs.tabs().filter((x) => x.kind === 'sql')) {
      try {
        const saved = await this.api.openScratch(t.id);
        const cur = this.tabs.get(t.id);
        if (!cur || cur.dirty) continue;
        const content = saved.content ?? '';
        if (content === cur.content) continue;
        this.tabs.adoptContent(t.id, content);
        this.editor.replaceContent(t.id, content);
      } catch (e) {
        const msg = errorText(e);
        const cur = this.tabs.get(t.id);
        if (!cur) continue;
        if (!/not found/i.test(msg)) {
          this.toasts.error(`${cur.name}: ${msg}`);
          continue;
        }
        if (cur.dirty) {
          this.toasts.error(`${cur.name} was deleted by the sync but has unsaved changes.`);
          continue;
        }
        await this.tabs.close(t.id);
        this.toasts.error(`${cur.name} was deleted by the sync.`);
      }
    }
    await this.refresh();
  }

  /** Opens a scratch, or focuses its tab when already open. */
  async open(id: string) {
    if (this.tabs.get(id)) return this.tabs.activate(id);
    try {
      this.tabs.openScratch(await this.api.openScratch(id));
    } catch (e) {
      this.toasts.error(errorText(e));
    }
  }

  async rename(id: string, name: string) {
    name = name.trim();
    if (!name) return;
    await this.tabs.flush(id);
    try {
      const clean = await this.api.renameScratch(id, name);
      if (this.tabs.get(id)) this.tabs.setName(id, clean);
      await this.refresh();
    } catch (e) {
      this.toasts.error(errorText(e));
    }
  }

  async remove(id: string): Promise<boolean> {
    const s = this.list().find((x) => x.id === id);
    if (!confirm(`Delete the scratch file “${s?.name ?? id}”? This cannot be undone.`)) return false;
    try {
      // Closing waits for the tab's last write; deleting only afterwards keeps
      // an in-flight save from recreating the file.
      if (this.tabs.get(id)) await this.tabs.close(id);
      await this.api.deleteScratch(id);
      this.saved.update((xs) => xs.filter((x) => x.id !== id));
      await this.refresh();
      return true;
    } catch (e) {
      this.toasts.error(errorText(e));
      return false;
    }
  }

  async duplicate(id: string) {
    await this.tabs.flush(id);
    const src = this.list().find((x) => x.id === id);
    const base = (src?.name ?? 'query.sql').replace(/\.sql$/i, '');
    const taken = new Set(this.list().map((x) => x.name));
    let name = `${base} copy.sql`;
    for (let i = 2; taken.has(name); i++) name = `${base} copy ${i}.sql`;
    try {
      this.tabs.openScratch(await this.api.duplicateScratch(id, crypto.randomUUID(), name));
      await this.refresh();
    } catch (e) {
      this.toasts.error(errorText(e));
    }
  }

  /** A name not used by any scratch: "users.sql", "users 2.sql", … */
  freeName(base: string): string {
    base = base.replace(/\.sql$/i, '');
    const taken = new Set(this.list().map((x) => x.name));
    let name = `${base}.sql`;
    for (let i = 2; taken.has(name); i++) name = `${base} ${i}.sql`;
    return name;
  }

  /** Creates a scratch filed under a connection / database / table folder and opens it. */
  async createIn(where: { connId: string; database: string; schema?: string; table?: string }, content = '', name?: string) {
    try {
      const t = await this.api.createScratch(crypto.randomUUID(), name ?? this.freeName(where.table || 'query'),
        where.connId, where.database, where.table ? where.schema ?? '' : '', where.table ?? '', content);
      const tab = this.tabs.openScratch(t);
      await this.refresh();
      return tab;
    } catch (e) {
      this.toasts.error(errorText(e));
      return undefined;
    }
  }

  /** Moves a scratch to another folder. An open tab follows the new connection / database. */
  async moveTo(id: string, where: { connId: string; database: string; schema: string; table: string }) {
    const tab = this.tabs.get(id);
    if (tab && (tab.connId !== where.connId || tab.database !== where.database)) {
      if (!this.tx.confirmLeave(id)) return;
      this.tabs.setConnection(id, where.connId, where.database);
    }
    try {
      await this.api.linkScratch(id, where.connId, where.database, where.schema, where.table);
      await this.refresh();
    } catch (e) {
      this.toasts.error(errorText(e));
    }
  }

  /** Writes a copy to a .sql file chosen by the user. */
  async exportFile(id: string) {
    await this.tabs.flush(id);
    try {
      const path = await this.api.exportScratch(id);
      if (path) this.toasts.success(`Saved a copy to ${path}`);
    } catch (e) {
      this.toasts.error(errorText(e));
    }
  }

  /** Opens a .sql file from disk as a new scratch, linked to the current tab's connection. */
  async importFile() {
    const active = this.tabs.active();
    try {
      const t = await this.api.importScratch(crypto.randomUUID(), active?.connId ?? '', active?.database ?? '');
      if (!t?.id) return;
      this.tabs.openScratch(t);
      await this.refresh();
    } catch (e) {
      this.toasts.error(errorText(e));
    }
  }

  /** ⌘S on a SQL tab: write now (content also autosaves). */
  async save(id: string) {
    const t = this.tabs.get(id);
    if (!t) return;
    await this.tabs.flush(id);
    this.toasts.success(`Saved ${t.name}`);
    this.refreshSoon(300);
  }
}
