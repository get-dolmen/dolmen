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
  styles: `
    :host { display: flex; flex-direction: column; height: 100vh; }
    .main { flex: 1; display: flex; min-height: 0; }
    .work { flex: 1; display: flex; flex-direction: column; min-width: 0; border-top: 2px solid transparent; }
    .work.ro { border-top-color: var(--warn); }
    .sql, .data { flex: 1; display: flex; flex-direction: column; min-height: 0; }
    .welcome { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; color: var(--text-muted); }
    .welcome p { margin: 0; }
    .editor { flex: 0 0 55%; min-height: 80px; }
    .editor.full { flex: 1 1 100%; }
    .results { flex: 1 1 0; min-height: 90px; }
    .sidebar { flex: none; min-width: 180px; max-width: 60vw; border-left: 1px solid var(--border); }
    .scratch-left { flex: none; min-width: 180px; max-width: 50vw; height: 100%; border-top: 0; border-right: 1px solid var(--border); background: var(--bg); }
    .split { flex: none; position: relative; z-index: 2; }
    .split::after { content: ''; position: absolute; }
    .split.h { height: 1px; background: var(--border); cursor: row-resize; }
    .split.h::after { left: 0; right: 0; top: -3px; bottom: -3px; }
    .split.v { width: 0; cursor: col-resize; }
    .split.v::after { top: 0; bottom: 0; left: -3px; right: -3px; }
    .split:hover { background: var(--accent); }
  `,
})
export class App {
  readonly ui = inject(Ui);
  readonly tabs = inject(TabStore);
  readonly cmds = inject(Commands);
  private conns = inject(ConnectionStore);
  private work = viewChild.required<ElementRef<HTMLElement>>('work');

  readonly tableTabs = computed(() => this.tabs.tabs().filter((t) => t.kind === 'table'));
  readonly readOnly = computed(() => !!this.conns.get(this.tabs.active()?.connId)?.readOnly);

  constructor() {
    inject(Hotkeys).install();
    void this.init();
  }

  private async init() {
    await this.conns.refresh();
    // Nothing connects at startup: connections open on first use (explorer, switcher or run).
    // No tab is created either: the app opens empty until the user asks for one.
    await this.tabs.load();
  }

  dragRows(e: PointerEvent) {
    const box = this.work().nativeElement.getBoundingClientRect();
    const top = box.top;
    const height = box.bottom - top;
    this.drag(e, 'row-resize', (ev) => {
      this.ui.editorRatio.set(Math.min(0.85, Math.max(0.15, (ev.clientY - top) / height)));
    });
  }

  dragSidebar(e: PointerEvent) {
    this.drag(e, 'col-resize', (ev) => {
      this.ui.sidebarWidth.set(Math.round(Math.min(window.innerWidth * 0.6, Math.max(180, window.innerWidth - ev.clientX))));
    });
  }

  dragScratches(e: PointerEvent) {
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
