import * as monaco from 'monaco-editor/editor/editor.api';
import 'monaco-editor/features/register.all';
import 'monaco-editor/languages/definitions/sql/register';
import 'monaco-editor/languages/definitions/pgsql/register';
import 'monaco-editor/languages/definitions/mysql/register';
import { KEYWORDS, quoteIdentifier } from '../../core/sql';
import { isDarkTheme } from '../../core/ui';
import type { DbColumn, DbKind, DbTable } from '../../core/models';
import { completionContext, expectsTable, parseTableReferences, statementAround } from './completion';

export { monaco };

/** What the completion provider needs to know about the model being edited. */
export interface CompletionSource {
  kind: DbKind;
  defaultSchema: string;
  schemas: string[];
  tables(schema: string): Promise<DbTable[]>;
  columns(schema: string, table: string): Promise<DbColumn[]>;
}

let isInitialized = false;
type CompletionSourceLookup = (model: monaco.editor.ITextModel) => Promise<CompletionSource | undefined>;
let completionSourceLookup: CompletionSourceLookup = async () => undefined;

export function setCompletionSource(lookup: CompletionSourceLookup) { completionSourceLookup = lookup; }

function cssVariable(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** (Re)defines the editor themes from the CSS tokens so Monaco matches the app. */
export function applyTheme() {
  const isDark = isDarkTheme();
  const colors = {
    'editor.background': cssVariable('--bg-panel'),
    'editor.foreground': cssVariable('--text'),
    'editorLineNumber.foreground': cssVariable('--text-faint'),
    'editorLineNumber.activeForeground': cssVariable('--text-muted'),
    'editor.lineHighlightBackground': isDark ? '#ffffff08' : '#00000006',
    'editor.selectionBackground': isDark ? '#8fb88640' : '#4f7a4a30',
    'editorCursor.foreground': cssVariable('--accent'),
    'editorWidget.background': cssVariable('--bg-raised'),
    'editorWidget.border': cssVariable('--border'),
    'editorSuggestWidget.background': cssVariable('--bg-raised'),
    'editorSuggestWidget.border': cssVariable('--border'),
    'editorSuggestWidget.selectedBackground': isDark ? '#8fb88630' : '#4f7a4a22',
    'editorGutter.background': cssVariable('--bg-panel'),
  };
  monaco.editor.defineTheme('dolmen', {
    base: isDark ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [
      { token: 'keyword', foreground: isDark ? 'c9a2e0' : '7b3fa0', fontStyle: 'bold' },
      { token: 'string', foreground: isDark ? 'a7c98f' : '3f7a2e' },
      { token: 'number', foreground: isDark ? 'e0b36d' : 'a0621a' },
      { token: 'comment', foreground: isDark ? '75706a' : '9b968a', fontStyle: 'italic' },
      { token: 'operator', foreground: isDark ? 'a29d91' : '6d695f' },
      { token: 'predefined', foreground: isDark ? '7fb4d8' : '2f6d9c' },
    ],
    colors,
  });
  monaco.editor.setTheme('dolmen');
}

export function initMonaco() {
  if (isInitialized) return;
  isInitialized = true;

  (self as never as { MonacoEnvironment: unknown }).MonacoEnvironment = {
    getWorker: () => new Worker(new URL('./monaco.worker', import.meta.url), { type: 'module' }),
  };

  applyTheme();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

  for (const language of ['sql', 'pgsql', 'mysql']) {
    monaco.languages.registerCompletionItemProvider(language, {
      triggerCharacters: ['.', ' '],
      provideCompletionItems: (model, position, context) => provideSuggestions(model, position, context),
    });
  }
}

const CompletionKind = monaco.languages.CompletionItemKind;

async function provideSuggestions(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
  trigger: monaco.languages.CompletionContext,
): Promise<monaco.languages.CompletionList> {
  const source = await completionSourceLookup(model);
  const typedWord = model.getWordUntilPosition(position);
  const replaceRange = new monaco.Range(
    position.lineNumber, typedWord.startColumn, position.lineNumber, typedWord.endColumn,
  );
  const cursorOffset = model.getOffsetAt(position);
  const statement = statementAround(model.getValue(), cursorOffset);
  const textBeforeCursor = statement.text.slice(0, cursorOffset - statement.start);
  const context = completionContext(textBeforeCursor);

  // A space only triggers suggestions right after FROM/JOIN-like keywords.
  if (trigger.triggerCharacter === ' ' && !(context.word === '' && expectsTable(context.keyword))) {
    return { suggestions: [] };
  }

  const suggestions: monaco.languages.CompletionItem[] = [];
  const quoteName = (name: string) => (source ? quoteIdentifier(source.kind, name) : name);
  const addSuggestion = (
    label: string,
    kind: monaco.languages.CompletionItemKind,
    sortGroup: string,
    detail?: string,
    insertText?: string,
  ) => suggestions.push({
    label,
    kind,
    detail,
    range: replaceRange,
    insertText: insertText ?? label,
    sortText: sortGroup + label.toLowerCase(),
  });

  if (!source) {
    if (!context.qualifier.length) {
      for (const keyword of KEYWORDS) addSuggestion(keyword, CompletionKind.Keyword, '3');
    }
    return { suggestions };
  }

  const tableReferences = parseTableReferences(statement.text);
  const sameName = (first?: string, second?: string) =>
    !!first && !!second && first.toLowerCase() === second.toLowerCase();

  if (context.qualifier.length) {
    const qualifierName = context.qualifier[context.qualifier.length - 1];
    // alias. or table. -> columns
    const referencedTable = tableReferences.find((reference) => sameName(reference.alias, qualifierName))
      ?? tableReferences.find((reference) => sameName(reference.table, qualifierName) && !reference.alias);
    if (referencedTable) {
      const columns = await source.columns(referencedTable.schema ?? source.defaultSchema, referencedTable.table);
      for (const column of columns) {
        addSuggestion(
          column.name, CompletionKind.Field, '0',
          column.type + (column.pk ? ' · PK' : ''), quoteName(column.name),
        );
      }
      return { suggestions };
    }
    // schema. -> tables
    const schemaName = source.schemas.find((schema) => sameName(schema, qualifierName));
    if (schemaName) {
      for (const table of await source.tables(schemaName)) {
        addSuggestion(
          table.name, table.type === 'view' ? CompletionKind.Interface : CompletionKind.Struct, '0',
          table.type, quoteName(table.name),
        );
      }
      return { suggestions };
    }
    // table. (not referenced yet) -> columns
    const knownTables = await source.tables(source.defaultSchema);
    const referencedByName = knownTables.find((table) => sameName(table.name, qualifierName));
    if (referencedByName) {
      const columns = await source.columns(referencedByName.schema, referencedByName.name);
      for (const column of columns) {
        addSuggestion(column.name, CompletionKind.Field, '0', column.type, quoteName(column.name));
      }
    }
    return { suggestions };
  }

  const expectsTableName = expectsTable(context.keyword);
  for (const table of await source.tables(source.defaultSchema)) {
    addSuggestion(
      table.name,
      table.type === 'view' ? CompletionKind.Interface : CompletionKind.Struct,
      expectsTableName ? '0' : '2',
      table.type,
      quoteName(table.name),
    );
  }
  for (const schema of source.schemas) {
    if (schema !== source.defaultSchema) {
      addSuggestion(schema, CompletionKind.Module, expectsTableName ? '1' : '4', 'schema', quoteName(schema));
    }
  }

  if (!expectsTableName) {
    const seenColumnNames = new Set<string>();
    for (const reference of tableReferences) {
      const columns = await source.columns(reference.schema ?? source.defaultSchema, reference.table);
      for (const column of columns) {
        const columnKey = column.name.toLowerCase();
        if (seenColumnNames.has(columnKey)) continue;
        seenColumnNames.add(columnKey);
        addSuggestion(
          column.name, CompletionKind.Field, '0',
          `${reference.alias ?? reference.table} · ${column.type}`, quoteName(column.name),
        );
      }
    }
  }
  for (const keyword of KEYWORDS) addSuggestion(keyword, CompletionKind.Keyword, '3');
  return { suggestions };
}
