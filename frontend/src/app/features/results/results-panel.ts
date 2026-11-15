import { Component, computed, inject, input, signal, viewChild } from '@angular/core';
import { DatePipe } from '@angular/common';
import { Commands } from '../../core/commands';
import { RunStore, type ResultsPanel as PanelKind } from '../../core/run.store';
import { ClickOutside, clampMenu } from '../../shared/click-outside';
import { HistoryPanel } from '../history/history-panel';
import { ResultGrid } from './result-grid';
import { COPY_FORMATS, formatRows, type CopyFormat } from './copy';
import { MOD } from '../../core/ui';
import type { QueryResult } from '../../core/models';

@Component({
  selector: 'dm-results-panel',
  imports: [ResultGrid, HistoryPanel, DatePipe, ClickOutside],
  templateUrl: './results-panel.html',
  styleUrl: './results-panel.scss',
})
export class ResultsPanelComponent {
  readonly runs = inject(RunStore);
  private cmds = inject(Commands);
  readonly tabId = input.required<string>();
  readonly connId = input<string>('');
  readonly mod = MOD;

  private grid = viewChild(ResultGrid);
  readonly run = computed(() => this.runs.runs()[this.tabId()] ?? this.runs.get(this.tabId()));
  readonly current = computed(() => this.run().results[this.run().activeResult]);
  readonly errorCount = computed(() => this.run().messages.filter((m) => m.kind === 'error').length);
  readonly fetching = signal(false);
  readonly menu = signal<{ x: number; y: number; kind: 'copy' | 'export' } | null>(null);
  readonly formats = COPY_FORMATS;

  setPanel(p: PanelKind) { this.runs.setPanel(this.tabId(), p); }

  label(r: QueryResult, i: number) {
    const m = /\bfrom\s+([\w$#."`]+)/i.exec(r.statement);
    const name = m ? m[1].replace(/["`]/g, '').split('.').pop() : '';
    return name ? `${i + 1} · ${name}` : `Result ${i + 1}`;
  }

  async fetchMore(r: QueryResult) {
    this.fetching.set(true);
    await this.runs.fetchMore(this.tabId(), r.id);
    this.fetching.set(false);
  }

  openMenu(e: MouseEvent, kind: 'copy' | 'export') {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    this.menu.set({ ...clampMenu(rect.right - 220, rect.bottom + 4, 220, kind === 'copy' ? 380 : 120), kind });
  }

  hint(format: CopyFormat): string {
    return { tsv: 'spreadsheet', csv: 'Excel', json: 'API', markdown: 'docs' }[format];
  }

  copy(what: 'all' | 'selected', format: CopyFormat) {
    this.menu.set(null);
    const r = this.current();
    if (!r) return;
    const rows = what === 'all' ? r.rows : this.grid()?.selectedRows() ?? [];
    void this.cmds.copy(formatRows(format, r.columns, rows, true));
  }

  copyColumns() {
    this.menu.set(null);
    const r = this.current();
    if (r) void this.cmds.copy(r.columns.map((c) => c.name).join(', '));
  }

  export(format: 'csv' | 'json') {
    this.menu.set(null);
    const r = this.current();
    if (r) void this.runs.export(this.tabId(), r.id, format);
  }
}
