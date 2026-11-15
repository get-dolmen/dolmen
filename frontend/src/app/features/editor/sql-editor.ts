import { ApplicationRef, Component, ElementRef, EnvironmentInjector, OnDestroy, afterNextRender, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { ConnectionStore } from '../../core/connection.store';
import { EditorBridge, type EditorHandle, type RunTarget } from '../../core/editor-bridge';
import { RunStore } from '../../core/run.store';
import { SchemaStore } from '../../core/schema.store';
import { TabStore } from '../../core/tab.store';
import { Ui, applyThemeAttribute } from '../../core/ui';
import { monacoLanguage } from '../../core/sql';
import { InlineZones } from './inline-zones';
import { applyTheme, initMonaco, monaco, setCompletionSource } from './monaco-setup';

/** One Monaco instance; each tab owns a model so undo history and view state survive tab switches. */
@Component({
  selector: 'dm-sql-editor',
  template: `<div class="host" #host [class.flash]="flash()"></div>`,
  styles: `
    :host { display: block; position: relative; min-height: 0; background: var(--bg-panel); }
    .host { position: absolute; inset: 0; transition: box-shadow 0.2s; }
    .host.flash { box-shadow: inset 0 0 0 2px var(--danger); }
  `,
})
export class SqlEditor implements EditorHandle, OnDestroy {
  private tabStore = inject(TabStore);
  private connectionStore = inject(ConnectionStore);
  private schemaStore = inject(SchemaStore);
  private editorBridge = inject(EditorBridge);
  private uiState = inject(Ui);
  private runStore = inject(RunStore);
  private applicationRef = inject(ApplicationRef);
  private environmentInjector = inject(EnvironmentInjector);
  private hostElement = viewChild.required<ElementRef<HTMLDivElement>>('host');

  public readonly flash = signal(false);
  private editor?: monaco.editor.IStandaloneCodeEditor;
  private models = new Map<string, monaco.editor.ITextModel>();
  private viewStates = new Map<string, monaco.editor.ICodeEditorViewState | null>();
  private currentTabId = '';
  private resizeObserver?: ResizeObserver;
  private inlineZones?: InlineZones;

  public constructor() {
    afterNextRender(() => this.create());

    // Repaint Monaco from the CSS tokens when the light/dark setting changes.
    effect(() => {
      const theme = this.uiState.theme();
      untracked(() => {
        applyThemeAttribute(theme);
        applyTheme();
      });
    });

    // Swap models when the active tab changes; drop models of closed tabs.
    effect(() => {
      const sqlTabs = this.tabStore.tabs().filter((tab) => tab.kind === 'sql');
      const activeTab = this.tabStore.active();
      untracked(() => this.syncModels(sqlTabs.map((tab) => tab.id), activeTab?.kind === 'sql' ? activeTab.id : undefined));
    });

    // Inline results: follow runs, the setting and the shown tab.
    effect(() => {
      const runs = this.runStore.runs();
      const inlineResultsEnabled = this.uiState.inlineResults();
      const activeTabId = this.tabStore.activeId();
      untracked(() => this.inlineZones?.update(runs, inlineResultsEnabled, activeTabId));
    });

    // Keep each model's language in line with its tab's connection.
    effect(() => {
      const connectionsById = this.connectionStore.byId();
      for (const tab of this.tabStore.tabs()) {
        const model = this.models.get(tab.id);
        const language = monacoLanguage(connectionsById.get(tab.connId)?.kind);
        if (model && model.getLanguageId() !== language) monaco.editor.setModelLanguage(model, language);
      }
    });
  }

  private create() {
    initMonaco();
    this.editor = monaco.editor.create(this.hostElement().nativeElement, {
      model: null,
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono'),
      fontSize: 13,
      lineHeight: 20,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderLineHighlight: 'line',
      padding: { top: 8 },
      tabSize: 2,
      fixedOverflowWidgets: true,
      automaticLayout: false,
      suggest: { showWords: false },
      quickSuggestions: { other: true, comments: false, strings: false },
      wordBasedSuggestions: 'off',
      contextmenu: true,
      smoothScrolling: true,
      'semanticHighlighting.enabled': false,
    });
    applyTheme();
    this.resizeObserver = new ResizeObserver(() => this.editor?.layout());
    this.resizeObserver.observe(this.hostElement().nativeElement);
    this.inlineZones = new InlineZones(this.editor, this.runStore, this.applicationRef, this.environmentInjector, this.models);

    setCompletionSource(async (model) => {
      const tabId = [...this.models].find(([, candidate]) => candidate === model)?.[0];
      const tab = this.tabStore.get(tabId ?? '');
      const connection = this.connectionStore.get(tab?.connId);
      if (!tab || !connection?.connected) return undefined;
      await this.schemaStore.loadDatabases(connection.id);
      const scope = this.schemaStore.scopeFor(connection.id, tab.database);
      await this.schemaStore.loadSchemas(scope);
      const schemaCache = this.schemaStore.get(scope);
      if (!schemaCache) return undefined;
      return {
        kind: connection.kind,
        defaultSchema: schemaCache.defaultSchema,
        schemas: schemaCache.schemas,
        tables: async (schema) => {
          await this.schemaStore.loadTables(scope, schema);
          return this.schemaStore.get(scope)?.tables[schema] ?? [];
        },
        columns: async (schema, table) => {
          await this.schemaStore.loadAllColumns(scope, schema);
          let columns = this.schemaStore.get(scope)?.columns[`${schema}.${table}`];
          if (!columns) {
            // Unquoted names may differ in case from the catalogue (e.g. Oracle upper-case).
            const tables = this.schemaStore.get(scope)?.tables[schema] ?? [];
            const actualTable = tables.find((candidate) => candidate.name.toLowerCase() === table.toLowerCase());
            if (actualTable) columns = this.schemaStore.get(scope)?.columns[`${schema}.${actualTable.name}`];
          }
          return columns ?? [];
        },
      };
    });

    this.editorBridge.attach(this);
    const activeTab = this.tabStore.active();
    this.syncModels(
      this.tabStore.tabs().filter((tab) => tab.kind === 'sql').map((tab) => tab.id),
      activeTab?.kind === 'sql' ? activeTab.id : undefined,
    );
  }

  private syncModels(tabIds: string[], activeTabId?: string) {
    if (!this.editor) return;
    const liveIds = new Set(tabIds);
    for (const [tabId, model] of this.models) {
      if (!liveIds.has(tabId)) {
        model.dispose();
        this.models.delete(tabId);
        this.viewStates.delete(tabId);
      }
    }
    if (!activeTabId) {
      this.inlineZones?.clear();
      if (this.currentTabId) {
        if (this.models.has(this.currentTabId)) this.viewStates.set(this.currentTabId, this.editor.saveViewState());
        this.currentTabId = '';
      }
      if (this.editor.getModel()) this.editor.setModel(null);
      return;
    }
    if (activeTabId === this.currentTabId && this.editor.getModel()) return;
    if (this.currentTabId && this.models.has(this.currentTabId)) {
      this.viewStates.set(this.currentTabId, this.editor.saveViewState());
    }
    this.currentTabId = activeTabId;
    this.inlineZones?.clear(); // zones belong to the editor, not to the model
    this.editor.setModel(this.modelFor(activeTabId));
    this.inlineZones?.update(this.runStore.runs(), this.uiState.inlineResults(), activeTabId);
    const viewState = this.viewStates.get(activeTabId);
    if (viewState) this.editor.restoreViewState(viewState);
    this.editor.focus();
  }

  private modelFor(tabId: string): monaco.editor.ITextModel {
    const existing = this.models.get(tabId);
    if (existing) return existing;
    const tab = this.tabStore.get(tabId)!;
    const model = monaco.editor.createModel(tab.content, monacoLanguage(this.connectionStore.get(tab.connId)?.kind));
    model.onDidChangeContent(() => this.tabStore.setContent(tabId, model.getValue()));
    this.models.set(tabId, model);
    return model;
  }

  // ---- EditorHandle ----

  public runTarget(mode: 'cursor' | 'all'): RunTarget | null {
    const editor = this.editor;
    const model = editor?.getModel();
    if (!editor || !model) return null;
    const selection = editor.getSelection();
    if (selection && !selection.isEmpty()) {
      return {
        sql: model.getValueInRange(selection), cursor: -1,
        startOffset: model.getOffsetAt(selection.getStartPosition()),
      };
    }
    if (mode === 'all') return { sql: model.getValue(), cursor: -1, startOffset: 0 };
    const position = editor.getPosition();
    return { sql: model.getValue(), cursor: position ? model.getOffsetAt(position) : 0, startOffset: 0 };
  }

  public insert(text: string) {
    const editor = this.editor;
    const selection = editor?.getSelection();
    if (!editor || !selection) return;
    editor.executeEdits('dolmen', [{ range: selection, text, forceMoveMarkers: true }]);
  }

  public replaceContent(tabId: string, content: string) {
    const model = this.models.get(tabId);
    if (model && model.getValue() !== content) model.setValue(content);
  }

  public focus() { this.editor?.focus(); }

  public flashError() {
    this.flash.set(true);
    setTimeout(() => this.flash.set(false), 600);
  }

  public ngOnDestroy() {
    this.editorBridge.detach(this);
    this.resizeObserver?.disconnect();
    this.inlineZones?.dispose();
    for (const model of this.models.values()) model.dispose();
    this.editor?.dispose();
  }
}
