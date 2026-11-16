import {
  Component,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import fuzzysort from 'fuzzysort';
import { Commands } from '../../core/commands';
import { ConnectionStore } from '../../core/connection.store';
import { SchemaStore, parseConnectionScope } from '../../core/schema.store';
import { TabStore } from '../../core/tab.store';
import { Ui, MOD } from '../../core/ui';
import { TxStore } from '../../core/tx.store';
import { ScratchStore } from '../../core/scratch.store';
import type { DbTable } from '../../core/models';

export interface PaletteItem {
  id: string;
  group: 'Tabs' | 'Scratches' | 'Tables' | 'Connections' | 'Commands';
  label: string;
  detail?: string;
  hint?: string;
  color?: string;
  run: () => void;
  /** Alt+Enter action (tables: insert the name). */
  alternateRun?: () => void;
}

const GROUP_ORDER: PaletteItem['group'][] = [
  'Tabs',
  'Scratches',
  'Tables',
  'Connections',
  'Commands',
];
const MAX_RESULTS = 60;

/** Ranks items by fuzzy score; with an empty query, keeps the given order. */
export function rankItems(query: string, items: PaletteItem[], limit = MAX_RESULTS): PaletteItem[] {
  const searchText = query.trim();
  if (!searchText) return items.slice(0, limit);
  return fuzzysort
    .go(searchText, items, { keys: ['label', 'detail'], limit, threshold: 0.2 })
    .map((result) => result.obj);
}

@Component({
  selector: 'dm-palette',
  templateUrl: './palette.html',
  styleUrl: './palette.scss',
})
export class Palette {
  private uiState = inject(Ui);
  private tabStore = inject(TabStore);
  private connectionStore = inject(ConnectionStore);
  private schemaStore = inject(SchemaStore);
  private commandService = inject(Commands);
  private transactionStore = inject(TxStore);
  private scratchStore = inject(ScratchStore);
  private searchInput = viewChild.required<ElementRef<HTMLInputElement>>('input');
  private resultList = viewChild.required<ElementRef<HTMLElement>>('list');
  public readonly modifierKey = MOD;

  public readonly query = signal(this.uiState.paletteQuery());
  public readonly selectedIndex = signal(0);
  public readonly loadingTables = computed(() =>
    [...this.schemaStore.loading()].some((scope) => scope.includes('|tables|')),
  );

  public constructor() {
    afterNextRender(() => this.searchInput().nativeElement.focus());
    // Each connection's own database, plus any other database already browsed in the explorer.
    const connectedIds = new Set(
      this.connectionStore.connected().map((connection) => connection.id),
    );
    const browsedScopes = Object.keys(this.schemaStore.schemasByScope()).filter((scope) =>
      connectedIds.has(parseConnectionScope(scope).connId),
    );
    for (const scope of new Set([...connectedIds, ...browsedScopes]))
      void this.schemaStore.loadAllTables(scope);
  }

  private items = computed<PaletteItem[]>(() => {
    const items: PaletteItem[] = [];
    const activeTab = this.tabStore.active();
    for (const tab of this.tabStore.tabs()) {
      const connection = this.connectionStore.get(tab.connId);
      items.push({
        id: `tab:${tab.id}`,
        group: 'Tabs',
        label: tab.name,
        detail: connection?.name,
        color: connection?.color,
        hint: tab.id === activeTab?.id ? 'current' : undefined,
        run: () => this.tabStore.activate(tab.id),
      });
    }
    // Scratch files that are not open in a tab.
    const openTabIds = new Set(this.tabStore.tabs().map((tab) => tab.id));
    for (const scratch of this.scratchStore.list()) {
      if (openTabIds.has(scratch.id)) continue;
      const connection = this.connectionStore.get(scratch.connId);
      items.push({
        id: `scr:${scratch.id}`,
        group: 'Scratches',
        label: scratch.name,
        color: connection?.color,
        detail: [connection?.name, scratch.database].filter(Boolean).join(' / ') || 'no connection',
        run: () => void this.scratchStore.open(scratch.id),
      });
    }
    // Tables of every loaded scope: each connection and, for Postgres, each browsed database.
    for (const [scope, cachedSchema] of Object.entries(this.schemaStore.schemasByScope())) {
      const { connId, database } = parseConnectionScope(scope);
      const connection = this.connectionStore.get(connId);
      if (!connection?.connected) continue;
      const location = database ? `${connection.name} · ${database}` : connection.name;
      for (const [schema, tables] of Object.entries(cachedSchema.tables)) {
        for (const table of tables) {
          items.push({
            id: `tbl:${scope}:${schema}:${table.name}`,
            group: 'Tables',
            label: table.name,
            detail: `${location} · ${schema}${table.type === 'view' ? ' · view' : ''}`,
            color: connection.color,
            run: () => this.openTableData(connId, database, table),
            alternateRun: () =>
              this.commandService.insertName(connId, schema, table.name, database),
          });
        }
      }
    }
    for (const connection of this.connectionStore.connections()) {
      const isActive = activeTab?.connId === connection.id;
      const detail = isActive
        ? 'used by this tab'
        : connection.connected
          ? 'connected · use in this tab'
          : 'connect and use in this tab';
      items.push({
        id: `conn:${connection.id}`,
        group: 'Connections',
        label: connection.name,
        color: connection.color,
        detail,
        hint: connection.readOnly ? 'read-only' : undefined,
        run: async () => {
          if (
            activeTab &&
            activeTab.connId !== connection.id &&
            !(await this.transactionStore.confirmLeave(activeTab.id))
          )
            return;
          if (activeTab) this.tabStore.setConnection(activeTab.id, connection.id);
          void this.connectionStore.ensureConnected(connection.id);
        },
      });
    }
    for (const command of this.commandService.list()) {
      items.push({
        id: `cmd:${command.id}`,
        group: 'Commands',
        label: command.label,
        hint: command.hint,
        run: command.run,
      });
    }
    return items;
  });

  public readonly results = computed(() => {
    const rawQuery = this.query();
    if (rawQuery.startsWith('>')) {
      const commandItems = this.items().filter((item) => item.group === 'Commands');
      return rankItems(rawQuery.slice(1), commandItems);
    }
    const ranked = rankItems(rawQuery, this.items());
    if (!rawQuery.trim()) {
      // Without a query: tabs, connections and commands only (tables would flood the list).
      return ranked.filter((item) => item.group !== 'Tables');
    }
    // Group results while keeping score order inside each group.
    return [...ranked].sort(
      (first, second) => GROUP_ORDER.indexOf(first.group) - GROUP_ORDER.indexOf(second.group),
    );
  });

  public setQuery(query: string) {
    this.query.set(query);
    this.selectedIndex.set(0);
  }

  private openTableData(connectionId: string, database: string, table: DbTable) {
    this.uiState.sidebarOpen.set(true);
    this.uiState.reveal.set({
      connId: connectionId,
      database,
      schema: table.schema,
      table: table.name,
    });
    this.commandService.openTableData(connectionId, database, table);
  }

  public choose(item: PaletteItem, alternate: boolean) {
    this.close();
    if (alternate && item.alternateRun) item.alternateRun();
    else item.run();
  }

  public close() {
    this.uiState.paletteOpen.set(false);
  }

  public onKey(event: KeyboardEvent) {
    const count = this.results().length;
    switch (event.key) {
      case 'ArrowDown':
        this.selectedIndex.set(count ? (this.selectedIndex() + 1) % count : 0);
        break;
      case 'ArrowUp':
        this.selectedIndex.set(count ? (this.selectedIndex() - 1 + count) % count : 0);
        break;
      case 'Enter': {
        const item = this.results()[this.selectedIndex()];
        if (item) this.choose(item, event.altKey);
        break;
      }
      case 'Escape':
        this.close();
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    queueMicrotask(() => {
      this.resultList()
        .nativeElement.querySelector(`#pi-${this.selectedIndex()}`)
        ?.scrollIntoView({ block: 'nearest' });
    });
  }
}
