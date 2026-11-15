import { Component, ElementRef, computed, inject, viewChild } from '@angular/core';
import { Commands } from './core/commands';
import { ConnectionStore } from './core/connection.store';
import { Hotkeys } from './core/hotkeys';
import { TabStore } from './core/tab.store';
import { Ui } from './core/ui';
import { SqlEditor } from './features/editor/sql-editor';
import { Palette } from './features/palette/palette';
import { ResultsPanelComponent } from './features/results/results-panel';
import { ScratchList } from './features/scratches/scratch-list';
import { SchemaSidebar } from './features/schema/schema-sidebar';
import { Statusbar } from './features/statusbar';
import { TabBar } from './features/tabs/tab-bar';
import { TableData } from './features/table-data/table-data';
import { Topbar } from './features/topbar/topbar';

@Component({
  selector: 'app-root',
  imports: [Topbar, TabBar, SqlEditor, ResultsPanelComponent, SchemaSidebar, ScratchList, Statusbar, Palette, TableData],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  public readonly ui = inject(Ui);
  public readonly tabs = inject(TabStore);
  public readonly cmds = inject(Commands);
  private conns = inject(ConnectionStore);
  private work = viewChild.required<ElementRef<HTMLElement>>('work');

  public readonly tableTabs = computed(() => this.tabs.tabs().filter((t) => t.kind === 'table'));
  public readonly readOnly = computed(() => !!this.conns.get(this.tabs.active()?.connId)?.readOnly);

  public constructor() {
    inject(Hotkeys).install();
    void this.init();
  }

  private async init() {
    await this.conns.refresh();
    // Nothing connects at startup: connections open on first use (explorer, switcher or run).
    // No tab is created either: the app opens empty until the user asks for one.
    await this.tabs.load();
  }

  public dragRows(e: PointerEvent) {
    const box = this.work().nativeElement.getBoundingClientRect();
    const top = box.top;
    const height = box.bottom - top;
    this.drag(e, 'row-resize', (ev) => {
      this.ui.editorRatio.set(Math.min(0.85, Math.max(0.15, (ev.clientY - top) / height)));
    });
  }

  public dragSidebar(e: PointerEvent) {
    this.drag(e, 'col-resize', (ev) => {
      this.ui.sidebarWidth.set(Math.round(Math.min(window.innerWidth * 0.6, Math.max(180, window.innerWidth - ev.clientX))));
    });
  }

  public dragScratches(e: PointerEvent) {
    this.drag(e, 'col-resize', (ev) => {
      this.ui.scratchWidth.set(Math.round(Math.min(window.innerWidth * 0.5, Math.max(180, ev.clientX))));
    });
  }

  private drag(e: PointerEvent, cursor: string, move: (ev: PointerEvent) => void) {
    e.preventDefault();
    const target = e.target as HTMLElement;
    target.setPointerCapture(e.pointerId);
    document.body.style.cursor = cursor;
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      document.body.style.cursor = '';
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  }
}
