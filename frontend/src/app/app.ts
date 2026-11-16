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
  imports: [
    Topbar,
    TabBar,
    SqlEditor,
    ResultsPanelComponent,
    SchemaSidebar,
    ScratchList,
    Statusbar,
    Palette,
    TableData,
  ],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  public readonly uiState = inject(Ui);
  public readonly tabStore = inject(TabStore);
  public readonly commandService = inject(Commands);
  private connectionStore = inject(ConnectionStore);
  private workArea = viewChild.required<ElementRef<HTMLElement>>('work');

  public readonly tableTabs = computed(() =>
    this.tabStore.tabs().filter((tab) => tab.kind === 'table'),
  );
  public readonly readOnly = computed(
    () => !!this.connectionStore.get(this.tabStore.active()?.connId)?.readOnly,
  );

  public constructor() {
    inject(Hotkeys).install();
    void this.initialize();
  }

  private async initialize() {
    await this.connectionStore.refresh();
    // Nothing connects at startup: connections open on first use (explorer, switcher or run).
    // No tab is created either: the app opens empty until the user asks for one.
    await this.tabStore.load();
  }

  public dragRows(event: PointerEvent) {
    const bounds = this.workArea().nativeElement.getBoundingClientRect();
    const top = bounds.top;
    const height = bounds.bottom - top;
    this.drag(event, 'row-resize', (moveEvent) => {
      this.uiState.editorRatio.set(
        Math.min(0.85, Math.max(0.15, (moveEvent.clientY - top) / height)),
      );
    });
  }

  public dragSidebar(event: PointerEvent) {
    this.drag(event, 'col-resize', (moveEvent) => {
      const width = Math.min(
        window.innerWidth * 0.6,
        Math.max(180, window.innerWidth - moveEvent.clientX),
      );
      this.uiState.sidebarWidth.set(Math.round(width));
    });
  }

  public dragScratches(event: PointerEvent) {
    this.drag(event, 'col-resize', (moveEvent) => {
      const width = Math.min(window.innerWidth * 0.5, Math.max(180, moveEvent.clientX));
      this.uiState.scratchWidth.set(Math.round(width));
    });
  }

  private drag(event: PointerEvent, cursor: string, onMove: (moveEvent: PointerEvent) => void) {
    event.preventDefault();
    const target = event.target as HTMLElement;
    target.setPointerCapture(event.pointerId);
    document.body.style.cursor = cursor;
    const onPointerUp = () => {
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onPointerUp);
      document.body.style.cursor = '';
    };
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onPointerUp);
  }
}
