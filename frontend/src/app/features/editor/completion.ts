// Pure helpers for schema-aware SQL completion (no Monaco imports, so they are unit-testable).

export interface TableReference {
  schema?: string;
  table: string;
  alias?: string;
}

const CLAUSE_END =
  /\b(where|group|order|having|limit|offset|fetch|union|intersect|except|window|returning|set|values|on|using|join|inner|left|right|full|cross|natural|lateral)\b|[;)]/i;
const NOT_ALIAS = new Set([
  'where',
  'group',
  'order',
  'having',
  'limit',
  'offset',
  'fetch',
  'union',
  'intersect',
  'except',
  'on',
  'using',
  'join',
  'inner',
  'left',
  'right',
  'full',
  'cross',
  'natural',
  'outer',
  'set',
  'values',
  'as',
  'window',
  'returning',
  'lateral',
]);

/** Removes surrounding identifier quotes. */
export function unquote(name: string): string {
  const match = /^(["`])(.*)\1$/.exec(name);
  return match ? match[2].split(match[1] + match[1]).join(match[1]) : name;
}

/** Splits a possibly quoted dotted name: a."b.c" -> ['a', 'b.c']. */
export function splitName(name: string): string[] {
  const parts: string[] = [];
  const namePattern = /"(?:[^"]|"")*"|`(?:[^`]|``)*`|[^.\s]+/g;
  let match: RegExpExecArray | null;
  while ((match = namePattern.exec(name))) parts.push(unquote(match[0]));
  return parts;
}

const NAME = String.raw`(?:"(?:[^"]|"")*"|\x60(?:[^\x60]|\x60\x60)*\x60|[\w$#]+)`;
const QUALIFIED_NAME = String.raw`${NAME}(?:\s*\.\s*${NAME})*`;
const REFERENCE = new RegExp(String.raw`(${QUALIFIED_NAME})(?:\s+(?:as\s+)?(${NAME}))?`, 'iy');

function parseReference(
  text: string,
  offset: number,
): { reference: TableReference; end: number } | null {
  REFERENCE.lastIndex = offset;
  const match = REFERENCE.exec(text);
  if (!match) return null;
  const parts = splitName(match[1]);
  let alias = match[2] ? unquote(match[2]) : undefined;
  let end = REFERENCE.lastIndex;
  if (alias && NOT_ALIAS.has(alias.toLowerCase())) {
    alias = undefined;
    end = offset + match[1].length;
  }
  const table = parts[parts.length - 1];
  const schema = parts.length > 1 ? parts[parts.length - 2] : undefined;
  return { reference: { schema, table, alias }, end };
}

/** Finds the tables referenced by FROM / JOIN / UPDATE / INTO clauses, with their aliases. */
export function parseTableReferences(statement: string): TableReference[] {
  const references: TableReference[] = [];
  const keywordPattern = /\b(from|join|update|into)\s+/gi;
  let match: RegExpExecArray | null;
  while ((match = keywordPattern.exec(statement))) {
    let position = keywordPattern.lastIndex;
    // FROM a x, b y: follow commas until the clause ends.
    for (;;) {
      if (statement[position] === '(') break; // subquery
      const parsed = parseReference(statement, position);
      if (!parsed) break;
      references.push(parsed.reference);
      const rest = statement.slice(parsed.end);
      const comma = /^\s*,\s*/.exec(rest);
      if (
        match[1].toLowerCase() !== 'from' ||
        !comma ||
        CLAUSE_END.test(rest.slice(0, comma[0].length))
      )
        break;
      position = parsed.end + comma[0].length;
    }
  }
  return references;
}

export interface CompletionContext {
  /** Identifier chain before the word being typed: `s.t.` -> ['s', 't']; empty when unqualified. */
  qualifier: string[];
  /** Partial word being typed. */
  word: string;
  /** Last keyword before the cursor (lower-case), used to rank tables vs columns. */
  keyword: string;
}

export function completionContext(textBeforeCursor: string): CompletionContext {
  const match = /((?:(?:"(?:[^"]|"")*"|`(?:[^`]|``)*`|[\w$#]+)\s*\.\s*)*)("?[\w$#]*)$/.exec(
    textBeforeCursor,
  );
  const chain = match?.[1] ?? '';
  const word = (match?.[2] ?? '').replace(/^"/, '');
  const qualifier = chain ? splitName(chain.trim().replace(/\.$/, '')) : [];
  const head = textBeforeCursor.slice(0, textBeforeCursor.length - (match?.[0].length ?? 0));
  const keywords = head.match(
    /\b(select|from|join|where|and|or|on|by|having|update|into|set|table|values|returning|as)\b/gi,
  );
  return {
    qualifier,
    word,
    keyword: (keywords?.[keywords.length - 1] ?? '').toLowerCase(),
  };
}

/** True when the cursor follows a keyword that expects a table name. */
export function expectsTable(keyword: string): boolean {
  return ['from', 'join', 'update', 'into', 'table'].includes(keyword);
}

/** Returns the statement around `offset`, splitting naively on semicolons outside quotes. */
export function statementAround(text: string, offset: number): { text: string; start: number } {
  let start = 0;
  let quoteCharacter = '';
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quoteCharacter) {
      if (character === quoteCharacter) quoteCharacter = '';
      continue;
    }
    if (character === "'" || character === '"' || character === '`') quoteCharacter = character;
    else if (character === ';') {
      if (index >= offset) return { text: text.slice(start, index), start };
      start = index + 1;
    }
  }
  return { text: text.slice(start), start };
}
