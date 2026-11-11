// Pure helpers for schema-aware SQL completion (no Monaco imports, so they are unit-testable).

export interface TableRef {
  schema?: string;
  table: string;
  alias?: string;
}

const CLAUSE_END = /\b(where|group|order|having|limit|offset|fetch|union|intersect|except|window|returning|set|values|on|using|join|inner|left|right|full|cross|natural|lateral)\b|[;)]/i;
const NOT_ALIAS = new Set([
  'where', 'group', 'order', 'having', 'limit', 'offset', 'fetch', 'union', 'intersect', 'except', 'on', 'using',
  'join', 'inner', 'left', 'right', 'full', 'cross', 'natural', 'outer', 'set', 'values', 'as', 'window', 'returning', 'lateral',
]);

/** Removes surrounding identifier quotes. */
export function unquote(s: string): string {
  const m = /^(["`])(.*)\1$/.exec(s);
  return m ? m[2].split(m[1] + m[1]).join(m[1]) : s;
}

/** Splits a possibly quoted dotted name: a."b.c" -> ['a', 'b.c']. */
export function splitName(s: string): string[] {
  const parts: string[] = [];
  const re = /"(?:[^"]|"")*"|`(?:[^`]|``)*`|[^.\s]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) parts.push(unquote(m[0]));
  return parts;
}

const NAME = String.raw`(?:"(?:[^"]|"")*"|\x60(?:[^\x60]|\x60\x60)*\x60|[\w$#]+)`;
const QNAME = String.raw`${NAME}(?:\s*\.\s*${NAME})*`;
const REF = new RegExp(String.raw`(${QNAME})(?:\s+(?:as\s+)?(${NAME}))?`, 'iy');

function parseRef(text: string, at: number): { ref: TableRef; end: number } | null {
  REF.lastIndex = at;
  const m = REF.exec(text);
  if (!m) return null;
  const parts = splitName(m[1]);
  let alias = m[2] ? unquote(m[2]) : undefined;
  let end = REF.lastIndex;
  if (alias && NOT_ALIAS.has(alias.toLowerCase())) {
    alias = undefined;
    end = at + m[1].length;
  }
  const table = parts[parts.length - 1];
  const schema = parts.length > 1 ? parts[parts.length - 2] : undefined;
  return { ref: { schema, table, alias }, end };
}

/** Finds the tables referenced by FROM / JOIN / UPDATE / INTO clauses, with their aliases. */
export function parseTableRefs(stmt: string): TableRef[] {
  const out: TableRef[] = [];
  const kw = /\b(from|join|update|into)\s+/gi;
  let m: RegExpExecArray | null;
  while ((m = kw.exec(stmt))) {
    let pos = kw.lastIndex;
    // FROM a x, b y: follow commas until the clause ends.
    for (;;) {
      if (stmt[pos] === '(') break; // subquery
      const r = parseRef(stmt, pos);
      if (!r) break;
      out.push(r.ref);
      const rest = stmt.slice(r.end);
      const comma = /^\s*,\s*/.exec(rest);
      if (m[1].toLowerCase() !== 'from' || !comma || CLAUSE_END.test(rest.slice(0, comma[0].length))) break;
      pos = r.end + comma[0].length;
    }
  }
  return out;
}

export interface CompletionContext {
  /** Identifier chain before the word being typed: `s.t.` -> ['s', 't']; empty when unqualified. */
  qualifier: string[];
  /** Partial word being typed. */
  word: string;
  /** Last keyword before the cursor (lower-case), used to rank tables vs columns. */
  keyword: string;
}

export function completionContext(before: string): CompletionContext {
  const m = /((?:(?:"(?:[^"]|"")*"|`(?:[^`]|``)*`|[\w$#]+)\s*\.\s*)*)("?[\w$#]*)$/.exec(before);
  const chain = m?.[1] ?? '';
  const word = (m?.[2] ?? '').replace(/^"/, '');
  const qualifier = chain ? splitName(chain.trim().replace(/\.$/, '')) : [];
  const head = before.slice(0, before.length - (m?.[0].length ?? 0));
  const kws = head.match(/\b(select|from|join|where|and|or|on|by|having|update|into|set|table|values|returning|as)\b/gi);
  return { qualifier, word, keyword: (kws?.[kws.length - 1] ?? '').toLowerCase() };
}

/** True when the cursor follows a keyword that expects a table name. */
export function expectsTable(keyword: string): boolean {
  return ['from', 'join', 'update', 'into', 'table'].includes(keyword);
}

/** Returns the statement around `offset`, splitting naively on semicolons outside quotes. */
export function statementAround(text: string, offset: number): { text: string; start: number } {
  let start = 0;
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = '';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === ';') {
      if (i >= offset) return { text: text.slice(start, i), start };
      start = i + 1;
    }
  }
  return { text: text.slice(start), start };
}
