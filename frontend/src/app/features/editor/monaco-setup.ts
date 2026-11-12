import * as monaco from 'monaco-editor/editor/editor.api';
import 'monaco-editor/features/register.all';
import 'monaco-editor/languages/definitions/sql/register';
import 'monaco-editor/languages/definitions/pgsql/register';
import 'monaco-editor/languages/definitions/mysql/register';
import { KEYWORDS, ident } from '../../core/sql';
import { isDarkTheme } from '../../core/ui';
import type { DbColumn, DbKind, DbTable } from '../../core/models';
import { completionContext, expectsTable, parseTableRefs, statementAround } from './completion';

export { monaco };

/** What the completion provider needs to know about the model being edited. */
export interface CompletionSource {
  kind: DbKind;
  defaultSchema: string;
  schemas: string[];
  tables(schema: string): Promise<DbTable[]>;
  columns(schema: string, table: string): Promise<DbColumn[]>;
}

let initialized = false;
let sourceFor: (model: monaco.editor.ITextModel) => Promise<CompletionSource | undefined> = async () => undefined;

export function setCompletionSource(fn: typeof sourceFor) { sourceFor = fn; }

function css(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** (Re)defines the editor themes from the CSS tokens so Monaco matches the app. */
export function applyTheme() {
  const dark = isDarkTheme();
  const colors = {
    'editor.background': css('--bg-panel'),
    'editor.foreground': css('--text'),
    'editorLineNumber.foreground': css('--text-faint'),
    'editorLineNumber.activeForeground': css('--text-muted'),
    'editor.lineHighlightBackground': dark ? '#ffffff08' : '#00000006',
    'editor.selectionBackground': dark ? '#8fb88640' : '#4f7a4a30',
    'editorCursor.foreground': css('--accent'),
    'editorWidget.background': css('--bg-raised'),
    'editorWidget.border': css('--border'),
    'editorSuggestWidget.background': css('--bg-raised'),
    'editorSuggestWidget.border': css('--border'),
    'editorSuggestWidget.selectedBackground': dark ? '#8fb88630' : '#4f7a4a22',
    'editorGutter.background': css('--bg-panel'),
  };
  monaco.editor.defineTheme('dolmen', {
    base: dark ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [
      { token: 'keyword', foreground: dark ? 'c9a2e0' : '7b3fa0', fontStyle: 'bold' },
      { token: 'string', foreground: dark ? 'a7c98f' : '3f7a2e' },
      { token: 'number', foreground: dark ? 'e0b36d' : 'a0621a' },
      { token: 'comment', foreground: dark ? '75706a' : '9b968a', fontStyle: 'italic' },
      { token: 'operator', foreground: dark ? 'a29d91' : '6d695f' },
      { token: 'predefined', foreground: dark ? '7fb4d8' : '2f6d9c' },
    ],
    colors,
  });
  monaco.editor.setTheme('dolmen');
}

export function initMonaco() {
  if (initialized) return;
  initialized = true;

  (self as any).MonacoEnvironment = {
    getWorker: () => new Worker(new URL('./monaco.worker', import.meta.url), { type: 'module' }),
  };

  applyTheme();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

  for (const lang of ['sql', 'pgsql', 'mysql']) {
    monaco.languages.registerCompletionItemProvider(lang, {
      triggerCharacters: ['.', ' '],
      provideCompletionItems: (model, position, ctx) => provide(model, position, ctx),
    });
  }
}

const Kind = monaco.languages.CompletionItemKind;

async function provide(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
  trigger: monaco.languages.CompletionContext,
): Promise<monaco.languages.CompletionList> {
  const src = await sourceFor(model);
  const word = model.getWordUntilPosition(position);
  const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
  const offset = model.getOffsetAt(position);
  const stmt = statementAround(model.getValue(), offset);
  const before = stmt.text.slice(0, offset - stmt.start);
  const ctx = completionContext(before);

  // A space only triggers suggestions right after FROM/JOIN-like keywords.
  if (trigger.triggerCharacter === ' ' && !(ctx.word === '' && expectsTable(ctx.keyword))) {
    return { suggestions: [] };
  }

  const out: monaco.languages.CompletionItem[] = [];
  const quote = (n: string) => (src ? ident(src.kind, n) : n);
  const add = (label: string, kind: monaco.languages.CompletionItemKind, sort: string, detail?: string, insert?: string) =>
    out.push({ label, kind, detail, range, insertText: insert ?? label, sortText: sort + label.toLowerCase() });

  if (!src) {
    if (!ctx.qualifier.length) for (const k of KEYWORDS) add(k, Kind.Keyword, '3');
    return { suggestions: out };
  }

  const refs = parseTableRefs(stmt.text);
  const eq = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

  if (ctx.qualifier.length) {
    const q = ctx.qualifier[ctx.qualifier.length - 1];
    // alias. or table. -> columns
    const ref = refs.find((r) => eq(r.alias, q)) ?? refs.find((r) => eq(r.table, q) && !r.alias);
    if (ref) {
      for (const c of await src.columns(ref.schema ?? src.defaultSchema, ref.table)) {
        add(c.name, Kind.Field, '0', c.type + (c.pk ? ' · PK' : ''), quote(c.name));
      }
      return { suggestions: out };
    }
    // schema. -> tables
    const schema = src.schemas.find((s) => eq(s, q));
    if (schema) {
      for (const t of await src.tables(schema)) add(t.name, t.type === 'view' ? Kind.Interface : Kind.Struct, '0', t.type, quote(t.name));
      return { suggestions: out };
    }
    // table. (not referenced yet) -> columns
    const tables = await src.tables(src.defaultSchema);
    const t = tables.find((x) => eq(x.name, q));
    if (t) for (const c of await src.columns(t.schema, t.name)) add(c.name, Kind.Field, '0', c.type, quote(c.name));
    return { suggestions: out };
  }

  const tableFirst = expectsTable(ctx.keyword);
  const tables = await src.tables(src.defaultSchema);
  for (const t of tables) add(t.name, t.type === 'view' ? Kind.Interface : Kind.Struct, tableFirst ? '0' : '2', t.type, quote(t.name));
  for (const s of src.schemas) if (s !== src.defaultSchema) add(s, Kind.Module, tableFirst ? '1' : '4', 'schema', quote(s));

  if (!tableFirst) {
    const seen = new Set<string>();
    for (const r of refs) {
      for (const c of await src.columns(r.schema ?? src.defaultSchema, r.table)) {
        const key = c.name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        add(c.name, Kind.Field, '0', `${r.alias ?? r.table} · ${c.type}`, quote(c.name));
      }
    }
  }
  for (const k of KEYWORDS) add(k, Kind.Keyword, '3');
  return { suggestions: out };
}
