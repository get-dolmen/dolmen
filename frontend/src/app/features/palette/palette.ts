import { Component, ElementRef, afterNextRender, computed, inject, signal, viewChild } from '@angular/core';
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
  alt?: () => void;
}

const GROUP_ORDER: PaletteItem['group'][] = ['Tabs', 'Scratches', 'Tables', 'Connections', 'Commands'];
const MAX_RESULTS = 60;

/** Ranks items by fuzzy score; with an empty query, keeps the given order. */
export function rankItems(query: string, items: PaletteItem[], limit = MAX_RESULTS): PaletteItem[] {
  const q = query.trim();
  if (!q) return items.slice(0, limit);
  return fuzzysort.go(q, items, { keys: ['label', 'detail'], limit, threshold: 0.2 }).map((r) => r.obj);
}

@Component({
  selector: 'dm-palette',
  templateUrl: './palette.html',
  styleUrl: './palette.scss',
})
export class Palette {
  private ui = inject(Ui);
  private tabs = inject(TabStore);
  private conns = inject(ConnectionStore);
  private schema = inject(SchemaStore);
  private cmds = inject(Commands);
  private tx = inject(TxStore);
  private scratches = inject(ScratchStore);
  private input = viewChild.required<ElementRef<HTMLInputElement>>('input');
  private list = viewChild.required<ElementRef<HTMLElement>>('list');
  public readonly mod = MOD;

  public readonly query = signal(this.ui.paletteQuery());
  public readonly index = signal(0);
  public readonly loadingTables = computed(() => [...this.schema.loading()].some((k) => k.includes('|tables|')));

  public constructor() {
    afterNextRender(() => this.input().nativeElement.focus());
    // Each connection's own database, plus any other database already browsed in the explorer.
    const connected = new Set(this.conns.connected().map((c) => c.id));
    const scopes = new Set([...connected, ...Object.keys(this.schema.schemasByScope()).filter((s) => connected.has(parseConnectionScope(s).connId))]);
    for (const s of scopes) void this.schema.loadAllTables(s);
  }

  private items = computed<PaletteItem[]>(() => {
    const items: PaletteItem[] = [];
    const active = this.tabs.active();
    for (const t of this.tabs.tabs()) {
      const conn = this.conns.get(t.connId);
      items.push({
        id: `tab:${t.id}`, group: 'Tabs', label: t.name, detail: conn?.name, color: conn?.color,
        hint: t.id === active?.id ? 'current' : undefined,
        run: () => this.tabs.activate(t.id),
      });
    }
    // Scratch files that are not open in a tab.
    const openIds = new Set(this.tabs.tabs().map((t) => t.id));
    for (const s of this.scratches.list()) {
      if (openIds.has(s.id)) continue;
      const conn = this.conns.get(s.connId);
      items.push({
        id: `scr:${s.id}`, group: 'Scratches', label: s.name, color: conn?.color,
        detail: [conn?.name, s.database].filter(Boolean).join(' / ') || 'no connection',
        run: () => void this.scratches.open(s.id),
      });
    }
    // Tables of every loaded scope: each connection and, for Postgres, each browsed database.
    for (const [scope, cs] of Object.entries(this.schema.schemasByScope())) {
      const { connId, database } = parseConnectionScope(scope);
      const c = this.conns.get(connId);
      if (!c?.connected) continue;
      const where = database ? `${c.name} · ${database}` : c.name;
      for (const [schema, tables] of Object.entries(cs.tables)) {
        for (const t of tables) {
          items.push({
            id: `tbl:${scope}:${schema}:${t.name}`, group: 'Tables', label: t.name,
            detail: `${where} · ${schema}${t.type === 'view' ? ' · view' : ''}`, color: c.color,
            run: () => this.openTable(connId, database, t),
            alt: () => this.cmds.insertName(connId, schema, t.name, database),
          });
        }
      }
    }
    for (const c of this.conns.connections()) {
      const isActive = active?.connId === c.id;
      items.push({
        id: `conn:${c.id}`, group: 'Connections', label: c.name, color: c.color,
        detail: isActive ? 'used by this tab' : c.connected ? 'connected · use in this tab' : 'connect and use in this tab',
        hint: c.readOnly ? 'read-only' : undefined,
        run: async () => {
          if (active && active.connId !== c.id && !(await this.tx.confirmLeave(active.id))) return;
          if (active) this.tabs.setConnection(active.id, c.id);
          void this.conns.ensureConnected(c.id);
        },
      });
    }
    for (const cmd of this.cmds.list()) {
      items.push({ id: `cmd:${cmd.id}`, group: 'Commands', label: cmd.label, hint: cmd.hint, run: cmd.run });
    }
    return items;
  });

  public readonly results = computed(() => {
    const raw = this.query();
    if (raw.startsWith('>')) return rankItems(raw.slice(1), this.items().filter((i) => i.group === 'Commands'));
    const ranked = rankItems(raw, this.items());
    if (!raw.trim()) {
      // Without a query: tabs, connections and commands only (tables would flood the list).
      return ranked.filter((i) => i.group !== 'Tables');
    }
    // Group results while keeping score order inside each group.
    return [...ranked].sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));
  });

  public setQuery(q: string) {
    this.query.set(q);
    this.index.set(0);
  }

  private openTable(connId: string, database: string, t: DbTable) {
    this.ui.sidebarOpen.set(true);
    this.ui.reveal.set({ connId, database, schema: t.schema, table: t.name });
    this.cmds.openTableData(connId, database, t);
  }

  public choose(it: PaletteItem, alt: boolean) {
    this.close();
    (alt && it.alt ? it.alt : it.run)();
  }

  public close() { this.ui.paletteOpen.set(false); }

  public onKey(e: KeyboardEvent) {
    const n = this.results().length;
    switch (e.key) {
      case 'ArrowDown': this.index.set(n ? (this.index() + 1) % n : 0); break;
      case 'ArrowUp': this.index.set(n ? (this.index() - 1 + n) % n : 0); break;
      case 'Enter': {
        const it = this.results()[this.index()];
        if (it) this.choose(it, e.altKey);
        break;
      }
      case 'Escape': this.close(); break;
      default: return;
    }
    e.preventDefault();
    e.stopPropagation();
    queueMicrotask(() => this.list().nativeElement.querySelector(`#pi-${this.index()}`)?.scrollIntoView({ block: 'nearest' }));
  }
}
