import { Component, ElementRef, OnDestroy, afterNextRender, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { ConnectionStore } from '../../core/connection.store';
import { EditorBridge, type EditorHandle, type RunTarget } from '../../core/editor-bridge';
import { SchemaStore } from '../../core/schema.store';
import { TabStore } from '../../core/tab.store';
import { Ui, applyThemeAttribute } from '../../core/ui';
import { monacoLanguage } from '../../core/sql';
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
  private tabs = inject(TabStore);
  private conns = inject(ConnectionStore);
  private schema = inject(SchemaStore);
  private bridge = inject(EditorBridge);
  private ui = inject(Ui);
  private host = viewChild.required<ElementRef<HTMLDivElement>>('host');

  readonly flash = signal(false);
  private editor?: monaco.editor.IStandaloneCodeEditor;
  private models = new Map<string, monaco.editor.ITextModel>();
  private viewStates = new Map<string, monaco.editor.ICodeEditorViewState | null>();
  private currentId = '';
  private resize?: ResizeObserver;

  constructor() {
    afterNextRender(() => this.create());

    // Repaint Monaco from the CSS tokens when the light/dark setting changes.
    effect(() => {
      const theme = this.ui.theme();
      untracked(() => {
        applyThemeAttribute(theme);
        applyTheme();
      });
    });

    // Swap models when the active tab changes; drop models of closed tabs.
    effect(() => {
      const tabs = this.tabs.tabs().filter((t) => t.kind === 'sql');
      const active = this.tabs.active();
      untracked(() => this.sync(tabs.map((t) => t.id), active?.kind === 'sql' ? active.id : undefined));
    });

    // Keep each model's language in line with its tab's connection.
    effect(() => {
      const byId = this.conns.byId();
      for (const t of this.tabs.tabs()) {
        const m = this.models.get(t.id);
        const lang = monacoLanguage(byId.get(t.connId)?.kind);
        if (m && m.getLanguageId() !== lang) monaco.editor.setModelLanguage(m, lang);
      }
    });
  }

  private create() {
    initMonaco();
    this.editor = monaco.editor.create(this.host().nativeElement, {
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
    this.resize = new ResizeObserver(() => this.editor?.layout());
    this.resize.observe(this.host().nativeElement);

    setCompletionSource(async (model) => {
      const tabId = [...this.models].find(([, m]) => m === model)?.[0];
      const tab = this.tabs.get(tabId ?? '');
      const conn = this.conns.get(tab?.connId);
      if (!tab || !conn?.connected) return undefined;
      await this.schema.loadDatabases(conn.id);
      const scope = this.schema.scope(conn.id, tab.database);
      await this.schema.loadSchemas(scope);
      const s = this.schema.get(scope);
      if (!s) return undefined;
      return {
        kind: conn.kind,
        defaultSchema: s.defaultSchema,
        schemas: s.schemas,
        tables: async (schema) => {
          await this.schema.loadTables(scope, schema);
          return this.schema.get(scope)?.tables[schema] ?? [];
        },
        columns: async (schema, table) => {
          await this.schema.loadAllColumns(scope, schema);
          let cols = this.schema.get(scope)?.columns[`${schema}.${table}`];
          if (!cols) {
            // Unquoted names may differ in case from the catalogue (e.g. Oracle upper-case).
            const tables = this.schema.get(scope)?.tables[schema] ?? [];
            const real = tables.find((t) => t.name.toLowerCase() === table.toLowerCase());
            if (real) cols = this.schema.get(scope)?.columns[`${schema}.${real.name}`];
          }
          return cols ?? [];
        },
      };
    });

    this.bridge.attach(this);
    const active = this.tabs.active();
    this.sync(this.tabs.tabs().filter((t) => t.kind === 'sql').map((t) => t.id), active?.kind === 'sql' ? active.id : undefined);
  }

  private sync(ids: string[], activeId?: string) {
    if (!this.editor) return;
    const live = new Set(ids);
    for (const [id, m] of this.models) {
      if (!live.has(id)) {
        m.dispose();
        this.models.delete(id);
        this.viewStates.delete(id);
      }
    }
    if (!activeId || activeId === this.currentId && this.editor.getModel()) return;
    if (this.currentId && this.models.has(this.currentId)) {
      this.viewStates.set(this.currentId, this.editor.saveViewState());
    }
    this.currentId = activeId;
    this.editor.setModel(this.modelFor(activeId));
    const vs = this.viewStates.get(activeId);
    if (vs) this.editor.restoreViewState(vs);
    this.editor.focus();
  }

  private modelFor(id: string): monaco.editor.ITextModel {
    let m = this.models.get(id);
    if (m) return m;
    const tab = this.tabs.get(id)!;
    m = monaco.editor.createModel(tab.content, monacoLanguage(this.conns.get(tab.connId)?.kind));
    m.onDidChangeContent(() => this.tabs.setContent(id, m!.getValue()));
    this.models.set(id, m);
    return m;
  }

  // ---- EditorHandle ----

  runTarget(mode: 'cursor' | 'all'): RunTarget | null {
    const ed = this.editor;
    const model = ed?.getModel();
    if (!ed || !model) return null;
    const sel = ed.getSelection();
    if (sel && !sel.isEmpty()) return { sql: model.getValueInRange(sel), cursor: -1 };
    if (mode === 'all') return { sql: model.getValue(), cursor: -1 };
    const pos = ed.getPosition();
    return { sql: model.getValue(), cursor: pos ? model.getOffsetAt(pos) : 0 };
  }

  insert(text: string) {
    const ed = this.editor;
    const sel = ed?.getSelection();
    if (!ed || !sel) return;
    ed.executeEdits('dolmen', [{ range: sel, text, forceMoveMarkers: true }]);
  }

  replaceContent(id: string, content: string) {
    const model = this.models.get(id);
    if (model && model.getValue() !== content) model.setValue(content);
  }

  focus() { this.editor?.focus(); }

  flashError() {
    this.flash.set(true);
    setTimeout(() => this.flash.set(false), 600);
  }

  ngOnDestroy() {
    this.bridge.detach(this);
    this.resize?.disconnect();
    for (const m of this.models.values()) m.dispose();
    this.editor?.dispose();
  }
}
