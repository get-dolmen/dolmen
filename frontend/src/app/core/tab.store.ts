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
  /** 'sql' = scratch file; 'table' = data editor for `table`; 'diagram' = the schema's tables and foreign keys */
  kind: 'sql' | 'table' | 'diagram';
  /** 'manual' keeps a transaction open across runs until Commit / Rollback */
  txMode: TxMode;
  /** SQL tabs: pins the connection and database so they cannot be switched by accident. */
  locked: boolean;
  /** Keeps the tab at the front of the tab bar. */
  pinned: boolean;
  /** SQL tabs: the schema unqualified names resolve to; '' = the connection's default. */
  schema: string;
  table?: { schema: string; name: string; type: string };
  /** diagram tabs: the schema whose tables and foreign keys are shown */
  diagram?: { schema: string };
  content: string;
  /** content changed and not yet written to disk */
  dirty: boolean;
}

const CONTENT_SAVE_DELAY_MS = 600;
const LAYOUT_SAVE_DELAY_MS = 300;

/** Scratch tabs: each is a .sql file persisted by the backend. */
@Injectable({ providedIn: 'root' })
export class TabStore {
  private api = inject(Api);
  private toastService = inject(Toasts);

  public readonly tabs = signal<EditorTab[]>([]);
  public readonly activeId = signal<string>('');
  public readonly active = computed(() => this.tabs().find((tab) => tab.id === this.activeId()));
  public readonly loaded = signal(false);

  private contentTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Content saves in flight, so a close or delete can wait for them. */
  private contentSaves = new Map<string, Set<Promise<void>>>();
  private layoutTimer?: ReturnType<typeof setTimeout>;

  public async load() {
    try {
      const workspace = await this.api.loadWorkspace();
      const tabs: EditorTab[] = workspace.tabs.map((tab) => ({
        id: tab.id,
        name: tab.name,
        connId: tab.connId,
        database: tab.database ?? '',
        content: tab.content ?? '',
        dirty: false,
        kind: tab.kind === 'table' ? 'table' : tab.kind === 'diagram' ? 'diagram' : 'sql',
        txMode: tab.txMode === 'manual' ? 'manual' : 'auto',
        locked: !!tab.locked,
        pinned: !!tab.pinned,
        schema: tab.kind === 'table' || tab.kind === 'diagram' ? '' : (tab.schema ?? ''),
        table:
          tab.kind === 'table'
            ? { schema: tab.schema ?? '', name: tab.table ?? '', type: tab.tableType ?? 'table' }
            : undefined,
        diagram: tab.kind === 'diagram' ? { schema: tab.schema ?? '' } : undefined,
      }));
      // Pinned tabs always sit first; the sort is stable, so each group keeps its order.
      this.tabs.set(tabs.sort((a, b) => Number(b.pinned) - Number(a.pinned)));
      this.activeId.set(
        workspace.tabs.some((tab) => tab.id === workspace.activeId)
          ? workspace.activeId
          : (workspace.tabs[0]?.id ?? ''),
      );
    } catch (error) {
      this.toastService.error(errorText(error));
    }
    this.loaded.set(true);
  }

  public get(id: string) {
    return this.tabs().find((tab) => tab.id === id);
  }

  public create(connId = '', content = '', name?: string, database = ''): EditorTab {
    // Like the backend, a new scratch is pinned to its connection and database.
    return this.insert({
      id: crypto.randomUUID(),
      name: name ?? this.nextName(),
      connId,
      database,
      kind: 'sql',
      txMode: 'auto',
      locked: !!connId,
      pinned: false,
      schema: '',
      content,
      dirty: !!content,
    });
  }

  /** Opens an existing scratch file in a new tab. */
  public openScratch(tab: TabState): EditorTab {
    return this.insert(
      {
        id: tab.id,
        name: tab.name,
        connId: tab.connId,
        database: tab.database ?? '',
        kind: 'sql',
        txMode: 'auto',
        locked: !!tab.locked,
        pinned: false,
        // A scratch filed under a table starts in that table's schema.
        schema: tab.table ? (tab.schema ?? '') : '',
        content: tab.content ?? '',
        dirty: false,
      },
      false,
    );
  }

  /** Extra names to avoid when naming new scratches (set by the scratch store). */
  public takenNames: () => string[] = () => [];

  /** Updates a tab's name without touching the scratch index (already renamed). */
  public setName(id: string, name: string) {
    this.patch(id, { name });
    this.saveLayoutSoon();
  }

  /** Opens a data-editor tab for a table. */
  public createTable(
    connId: string,
    database: string,
    table: { schema: string; name: string; type: string },
  ): EditorTab {
    return this.insert({
      id: crypto.randomUUID(),
      name: table.name,
      connId,
      database,
      kind: 'table',
      txMode: 'auto',
      locked: false,
      pinned: false,
      schema: '',
      table,
      content: '',
      dirty: false,
    });
  }

  /** Opens a diagram tab: the tables of a schema and their foreign-key links. */
  public createDiagram(connId: string, database: string, schema: string): EditorTab {
    return this.insert({
      id: crypto.randomUUID(),
      name: `${schema} diagram`,
      connId,
      database,
      kind: 'diagram',
      txMode: 'auto',
      locked: false,
      pinned: false,
      schema: '',
      diagram: { schema },
      content: '',
      dirty: false,
    });
  }

  private insert(tab: EditorTab, save = true): EditorTab {
    const content = save ? tab.content : '';
    const tabs = this.tabs();
    const activeIndex = tabs.findIndex((candidate) => candidate.id === this.activeId());
    const pinnedCount = tabs.filter((candidate) => candidate.pinned).length;
    // New tabs are never pinned: keep them after the pinned group.
    const insertionIndex = Math.max(activeIndex, pinnedCount - 1);
    const nextTabs = [...tabs];
    nextTabs.splice(insertionIndex + 1, 0, tab);
    this.tabs.set(nextTabs);
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
    const tabs = this.tabs();
    const activeIndex = tabs.findIndex((tab) => tab.id === this.activeId());
    if (activeIndex < 0 || tabs.length < 2) return;
    const nextIndex = (activeIndex + delta + tabs.length) % tabs.length;
    this.activate(tabs[nextIndex].id);
  }

  public async close(id: string) {
    const tabs = this.tabs();
    const closingIndex = tabs.findIndex((tab) => tab.id === id);
    if (closingIndex < 0) return;
    // Wait for a pending write: deleting the scratch right after must not race
    // with it, or the write would recreate the file.
    await this.flush(id);
    if (!this.get(id)) return;
    const remainingTabs = this.tabs().filter((tab) => tab.id !== id);
    if (this.activeId() === id) {
      const nextActive = remainingTabs[Math.min(closingIndex, remainingTabs.length - 1)];
      this.activeId.set(nextActive?.id ?? '');
    }
    this.tabs.set(remainingTabs);
    this.saveLayoutSoon();
    try {
      await this.api.closeTab(id);
    } catch (error) {
      this.toastService.error(errorText(error));
    }
  }

  public rename(id: string, name: string) {
    name = name.trim();
    if (!name) return;
    this.patch(id, { name });
    this.saveLayoutSoon();
  }

  public move(fromIndex: number, toIndex: number) {
    const nextTabs = [...this.tabs()];
    const [movedTab] = nextTabs.splice(fromIndex, 1);
    if (!movedTab) return;
    // Pinned tabs stay in front: clamp drops that would cross the group.
    const pinnedCount = nextTabs.filter((tab) => tab.pinned).length;
    const target = movedTab.pinned
      ? Math.min(toIndex, pinnedCount)
      : Math.max(pinnedCount, Math.min(toIndex, nextTabs.length));
    nextTabs.splice(target, 0, movedTab);
    this.tabs.set(nextTabs);
    this.saveLayoutSoon();
  }

  public setConnection(id: string, connectionId: string, database = '') {
    const tab = this.get(id);
    if (!tab) return;
    if (tab.locked) {
      this.toastService.error(`${tab.name} is locked to its folder. Unlock it first.`);
      return;
    }
    if (tab.connId === connectionId && tab.database === database) return;
    // A schema belongs to its connection and database: start from the default again.
    this.patch(id, { connId: connectionId, database, schema: '' });
    void this.api.releaseTabSession(id);
    this.saveLayoutSoon();
  }

  /** Keeps a tab at the front of the tab bar, or releases it to the other tabs. */
  public setPinned(id: string, pinned: boolean) {
    const tabs = this.tabs();
    const tab = tabs.find((candidate) => candidate.id === id);
    if (!tab || tab.pinned === pinned) return;
    const nextTabs = tabs.filter((candidate) => candidate.id !== id);
    const pinnedCount = nextTabs.filter((candidate) => candidate.pinned).length;
    nextTabs.splice(pinnedCount, 0, { ...tab, pinned });
    this.tabs.set(nextTabs);
    this.saveLayoutSoon();
  }

  /** Pins or unpins a SQL tab's connection and database. */
  public setLocked(id: string, locked: boolean) {
    if (this.get(id)?.locked === locked) return;
    this.patch(id, { locked });
    this.saveLayoutSoon();
  }

  /** Sets the schema a SQL tab runs in; '' returns to the connection's default. */
  public setSchema(id: string, schema: string) {
    if (this.get(id)?.schema === schema) return;
    this.patch(id, { schema });
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
    const tab = this.get(id);
    if (!tab || tab.content === content) return;
    this.patch(id, { content, dirty: true });
    this.scheduleContentSave(id);
  }

  /** Takes a version that is already on disk (pulled by git sync) without marking it dirty. */
  public adoptContent(id: string, content: string) {
    const tab = this.get(id);
    if (!tab || tab.content === content) return;
    this.patch(id, { content, dirty: false });
  }

  /** Writes pending content immediately and waits for pendingWrites already in flight. */
  public flush(id?: string): Promise<unknown> {
    const tabIds = id
      ? [id]
      : [...new Set([...this.contentTimers.keys(), ...this.contentSaves.keys()])];
    const pendingWrites: Promise<unknown>[] = [];
    for (const tabId of tabIds) {
      const inFlightSaves = [...(this.contentSaves.get(tabId) ?? [])];
      const timer = this.contentTimers.get(tabId);
      if (timer) {
        clearTimeout(timer);
        this.contentTimers.delete(tabId);
        pendingWrites.push(this.startContentSave(tabId));
      }
      pendingWrites.push(...inFlightSaves);
    }
    return Promise.all(pendingWrites);
  }

  private scheduleContentSave(id: string) {
    clearTimeout(this.contentTimers.get(id));
    this.contentTimers.set(
      id,
      setTimeout(() => {
        this.contentTimers.delete(id);
        void this.startContentSave(id);
      }, CONTENT_SAVE_DELAY_MS),
    );
  }

  private startContentSave(id: string): Promise<void> {
    const pendingSave = this.saveContent(id).finally(() => {
      const saves = this.contentSaves.get(id);
      if (!saves) return;
      saves.delete(pendingSave);
      if (!saves.size) this.contentSaves.delete(id);
    });
    const saves = this.contentSaves.get(id) ?? new Set<Promise<void>>();
    saves.add(pendingSave);
    this.contentSaves.set(id, saves);
    return pendingSave;
  }

  private async saveContent(id: string) {
    const tab = this.get(id);
    if (!tab) return;
    const content = tab.content;
    try {
      await this.api.saveTabContent(id, content);
      if (this.get(id)?.content === content) this.patch(id, { dirty: false });
    } catch (error) {
      this.toastService.error(`Could not save ${tab.name}: ${errorText(error)}`);
    }
  }

  private saveLayoutSoon() {
    clearTimeout(this.layoutTimer);
    this.layoutTimer = setTimeout(() => void this.saveLayout(), LAYOUT_SAVE_DELAY_MS);
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
    const workspace = {
      activeId: this.activeId(),
      tabs: this.tabs().map((tab) => ({
        id: tab.id,
        name: tab.name,
        connId: tab.connId,
        database: tab.database || undefined,
        kind: tab.kind === 'sql' ? undefined : tab.kind,
        schema: tab.table?.schema ?? tab.diagram?.schema ?? (tab.schema || undefined),
        table: tab.table?.name,
        tableType: tab.table?.type,
        txMode: tab.txMode === 'manual' ? ('manual' as const) : undefined,
        locked: tab.locked || undefined,
        pinned: tab.pinned || undefined,
      })),
    };
    try {
      await this.api.saveWorkspaceLayout(workspace);
    } catch (error) {
      this.toastService.error(errorText(error));
    }
  }

  private patch(id: string, changes: Partial<EditorTab>) {
    this.tabs.update((tabs) => tabs.map((tab) => (tab.id === id ? { ...tab, ...changes } : tab)));
  }

  private nextName(): string {
    const usedNames = new Set([...this.tabs().map((tab) => tab.name), ...this.takenNames()]);
    for (let index = 1; ; index++) {
      const name = `query${index}.sql`;
      if (!usedNames.has(name)) return name;
    }
  }
}
