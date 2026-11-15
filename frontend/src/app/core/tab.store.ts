import { Injectable, computed, inject, signal } from '@angular/core';
import { Api, errorText } from './api';
import { Toasts } from './toast';
import type { TabState, TxMode } from './models';

export interface EditorTab {
  id: string;
  name: string;
  connId: string;
  /** another database of the connection's server (Postgres); '' = the connection's own */
  database: string;
  /** 'sql' = scratch file; 'table' = data editor for `table` */
  kind: 'sql' | 'table';
  /** 'manual' keeps a transaction open across runs until Commit / Rollback */
  txMode: TxMode;
  /** SQL tabs: pins the connection and database so they cannot be switched by accident. */
  locked: boolean;
  table?: { schema: string; name: string; type: string };
  content: string;
  /** content changed and not yet written to disk */
  dirty: boolean;
}

const CONTENT_SAVE_MS = 600;
const LAYOUT_SAVE_MS = 300;

/** Scratch tabs: each is a .sql file persisted by the backend. */
@Injectable({ providedIn: 'root' })
export class TabStore {
  private api = inject(Api);
  private toasts = inject(Toasts);

  public readonly tabs = signal<EditorTab[]>([]);
  public readonly activeId = signal<string>('');
  public readonly active = computed(() => this.tabs().find((t) => t.id === this.activeId()));
  public readonly loaded = signal(false);

  private contentTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Content writes in flight, so a close or delete can wait for them. */
  private contentSaves = new Map<string, Set<Promise<void>>>();
  private layoutTimer?: ReturnType<typeof setTimeout>;

  public async load() {
    try {
      const ws = await this.api.loadWorkspace();
      this.tabs.set(ws.tabs.map((t) => ({
        id: t.id, name: t.name, connId: t.connId, database: t.database ?? '', content: t.content ?? '', dirty: false,
        kind: t.kind === 'table' ? 'table' : 'sql', txMode: t.txMode === 'manual' ? 'manual' : 'auto',
        locked: !!t.locked,
        table: t.kind === 'table' ? { schema: t.schema ?? '', name: t.table ?? '', type: t.tableType ?? 'table' } : undefined,
      })));
      this.activeId.set(ws.tabs.some((t) => t.id === ws.activeId) ? ws.activeId : ws.tabs[0]?.id ?? '');
    } catch (e) {
      this.toasts.error(errorText(e));
    }
    this.loaded.set(true);
  }

  public get(id: string) { return this.tabs().find((t) => t.id === id); }

  public create(connId = '', content = '', name?: string, database = ''): EditorTab {
    return this.insert({ id: crypto.randomUUID(), name: name ?? this.nextName(), connId, database, kind: 'sql', txMode: 'auto', locked: false, content, dirty: !!content });
  }

  /** Opens an existing scratch file in a new tab. */
  public openScratch(t: TabState): EditorTab {
    return this.insert({
      id: t.id, name: t.name, connId: t.connId, database: t.database ?? '', kind: 'sql', txMode: 'auto', locked: !!t.locked,
      content: t.content ?? '', dirty: false,
    }, false);
  }

  /** Extra names to avoid when naming new scratches (set by the scratch store). */
  public takenNames: () => string[] = () => [];

  /** Updates a tab's name without touching the scratch index (already renamed). */
  public setName(id: string, name: string) {
    this.patch(id, { name });
    this.saveLayoutSoon();
  }

  /** Opens a data-editor tab for a table. */
  public createTable(connId: string, database: string, table: { schema: string; name: string; type: string }): EditorTab {
    return this.insert({ id: crypto.randomUUID(), name: table.name, connId, database, kind: 'table', txMode: 'auto', locked: false, table, content: '', dirty: false });
  }

  private insert(tab: EditorTab, save = true): EditorTab {
    const content = save ? tab.content : '';
    const idx = this.tabs().findIndex((t) => t.id === this.activeId());
    const list = [...this.tabs()];
    list.splice(idx + 1, 0, tab);
    this.tabs.set(list);
    this.activeId.set(tab.id);
    if (content) this.scheduleContentSave(tab.id);
    this.saveLayoutSoon();
    return tab;
  }

  public activate(id: string) {
    if (this.get(id)) {
      this.activeId.set(id);
      this.saveLayoutSoon();
    }
  }

  public activateRelative(delta: number) {
    const list = this.tabs();
    const i = list.findIndex((t) => t.id === this.activeId());
    if (i < 0 || list.length < 2) return;
    this.activate(list[(i + delta + list.length) % list.length].id);
  }

  public async close(id: string) {
    const list = this.tabs();
    const i = list.findIndex((t) => t.id === id);
    if (i < 0) return;
    // Wait for a pending write: deleting the scratch right after must not race
    // with it, or the write would recreate the file.
    await this.flush(id);
    if (!this.get(id)) return;
    const rest = this.tabs().filter((t) => t.id !== id);
    if (this.activeId() === id) this.activeId.set(rest[Math.min(i, rest.length - 1)]?.id ?? '');
    this.tabs.set(rest);
    this.saveLayoutSoon();
    try {
      await this.api.closeTab(id);
    } catch (e) {
      this.toasts.error(errorText(e));
    }
  }

  public rename(id: string, name: string) {
    name = name.trim();
    if (!name) return;
    this.patch(id, { name });
    this.saveLayoutSoon();
  }

  public move(from: number, to: number) {
    const list = [...this.tabs()];
    const [t] = list.splice(from, 1);
    list.splice(to, 0, t);
    this.tabs.set(list);
    this.saveLayoutSoon();
  }

  public setConnection(id: string, connId: string, database = '') {
    const t = this.get(id);
    if (!t) return;
    if (t.locked) {
      this.toasts.error(`${t.name} is locked to its connection and database. Unlock it first.`);
      return;
    }
    if (t.connId === connId && t.database === database) return;
    this.patch(id, { connId, database });
    void this.api.releaseTabSession(id);
    this.saveLayoutSoon();
  }

  /** Pins or unpins a SQL tab's connection and database. */
  public setLocked(id: string, locked: boolean) {
    if (this.get(id)?.locked === locked) return;
    this.patch(id, { locked });
    this.saveLayoutSoon();
  }

  public setTxMode(id: string, txMode: TxMode) {
    if (this.get(id)?.txMode === txMode) return;
    this.patch(id, { txMode });
    this.saveLayoutSoon();
  }

  /** Data tabs report pending, unsaved edits through the dirty flag. */
  public setDirty(id: string, dirty: boolean) {
    if (this.get(id) && this.get(id)!.dirty !== dirty) this.patch(id, { dirty });
  }

  public setContent(id: string, content: string) {
    const t = this.get(id);
    if (!t || t.content === content) return;
    this.patch(id, { content, dirty: true });
    this.scheduleContentSave(id);
  }

  /** Takes a version that is already on disk (pulled by git sync) without marking it dirty. */
  public adoptContent(id: string, content: string) {
    const t = this.get(id);
    if (!t || t.content === content) return;
    this.patch(id, { content, dirty: false });
  }

  /** Writes pending content immediately and waits for writes already in flight. */
  public flush(id?: string): Promise<unknown> {
    const ids = id ? [id] : [...new Set([...this.contentTimers.keys(), ...this.contentSaves.keys()])];
    const writes: Promise<unknown>[] = [];
    for (const tid of ids) {
      const inFlight = [...(this.contentSaves.get(tid) ?? [])];
      const timer = this.contentTimers.get(tid);
      if (timer) {
        clearTimeout(timer);
        this.contentTimers.delete(tid);
        writes.push(this.startContentSave(tid));
      }
      writes.push(...inFlight);
    }
    return Promise.all(writes);
  }

  private scheduleContentSave(id: string) {
    clearTimeout(this.contentTimers.get(id));
    this.contentTimers.set(id, setTimeout(() => {
      this.contentTimers.delete(id);
      void this.startContentSave(id);
    }, CONTENT_SAVE_MS));
  }

  private startContentSave(id: string): Promise<void> {
    const save = this.saveContent(id).finally(() => {
      const set = this.contentSaves.get(id);
      if (!set) return;
      set.delete(save);
      if (!set.size) this.contentSaves.delete(id);
    });
    const set = this.contentSaves.get(id) ?? new Set<Promise<void>>();
    set.add(save);
    this.contentSaves.set(id, set);
    return save;
  }

  private async saveContent(id: string) {
    const t = this.get(id);
    if (!t) return;
    const content = t.content;
    try {
      await this.api.saveTabContent(id, content);
      if (this.get(id)?.content === content) this.patch(id, { dirty: false });
    } catch (e) {
      this.toasts.error(`Could not save ${t.name}: ${errorText(e)}`);
    }
  }

  private saveLayoutSoon() {
    clearTimeout(this.layoutTimer);
    this.layoutTimer = setTimeout(() => void this.saveLayout(), LAYOUT_SAVE_MS);
  }

  /**
   * Saves the layout now. Actions that address a scratch by ID (locking it, for
   * one) need the backend to know the tab before the debounce fires.
   */
  public async saveLayoutNow() {
    clearTimeout(this.layoutTimer);
    await this.saveLayout();
  }

  private async saveLayout() {
    const ws = {
      activeId: this.activeId(),
      tabs: this.tabs().map((t) => ({
        id: t.id, name: t.name, connId: t.connId, database: t.database || undefined,
        kind: t.kind === 'table' ? ('table' as const) : undefined,
        schema: t.table?.schema, table: t.table?.name, tableType: t.table?.type,
        txMode: t.txMode === 'manual' ? ('manual' as const) : undefined,
        locked: t.locked || undefined,
      })),
    };
    try {
      await this.api.saveWorkspaceLayout(ws);
    } catch (e) {
      this.toasts.error(errorText(e));
    }
  }

  private patch(id: string, p: Partial<EditorTab>) {
    this.tabs.update((ts) => ts.map((t) => (t.id === id ? { ...t, ...p } : t)));
  }

  private nextName(): string {
    const used = new Set([...this.tabs().map((t) => t.name), ...this.takenNames()]);
    for (let i = 1; ; i++) {
      const n = `query${i}.sql`;
      if (!used.has(n)) return n;
    }
  }
}
