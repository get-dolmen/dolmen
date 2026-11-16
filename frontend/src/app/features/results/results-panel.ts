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
  public readonly runStore = inject(RunStore);
  private commandService = inject(Commands);
  public readonly tabId = input.required<string>();
  public readonly connId = input<string>('');
  public readonly modifierKey = MOD;

  private resultGrid = viewChild(ResultGrid);
  public readonly run = computed(
    () => this.runStore.runs()[this.tabId()] ?? this.runStore.get(this.tabId()),
  );
  public readonly current = computed(() => this.run().results[this.run().activeResult]);
  public readonly errorCount = computed(
    () => this.run().messages.filter((message) => message.kind === 'error').length,
  );
  public readonly fetching = signal(false);
  public readonly menu = signal<{ x: number; y: number; kind: 'copy' | 'export' } | null>(null);
  public readonly copyFormats = COPY_FORMATS;

  public setPanel(panel: PanelKind) {
    this.runStore.setPanel(this.tabId(), panel);
  }

  public label(result: QueryResult, index: number) {
    const match = /\bfrom\s+([\w$#."`]+)/i.exec(result.statement);
    const name = match ? match[1].replace(/["`]/g, '').split('.').pop() : '';
    return name ? `${index + 1} · ${name}` : `Result ${index + 1}`;
  }

  public async fetchMore(result: QueryResult) {
    this.fetching.set(true);
    await this.runStore.fetchMore(this.tabId(), result.id);
    this.fetching.set(false);
  }

  public openMenu(event: MouseEvent, kind: 'copy' | 'export') {
    const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
    this.menu.set({
      ...clampMenu(bounds.right - 220, bounds.bottom + 4, 220, kind === 'copy' ? 380 : 120),
      kind,
    });
  }

  public hint(format: CopyFormat): string {
    return { tsv: 'spreadsheet', csv: 'Excel', json: 'API', markdown: 'docs' }[format];
  }

  public copy(scope: 'all' | 'selected', format: CopyFormat) {
    this.menu.set(null);
    const result = this.current();
    if (!result) return;
    const rows = scope === 'all' ? result.rows : (this.resultGrid()?.selectedRows() ?? []);
    void this.commandService.copy(formatRows(format, result.columns, rows, true));
  }

  public copyColumns() {
    this.menu.set(null);
    const result = this.current();
    if (result)
      void this.commandService.copy(result.columns.map((column) => column.name).join(', '));
  }

  public export(format: 'csv' | 'json') {
    this.menu.set(null);
    const result = this.current();
    if (result) void this.runStore.export(this.tabId(), result.id, format);
  }
}
