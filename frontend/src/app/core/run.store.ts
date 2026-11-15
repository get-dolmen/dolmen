import { Injectable, inject, signal } from '@angular/core';
import { Api, errorText } from './api';
import { ConnectionStore } from './connection.store';
import { EditorBridge } from './editor-bridge';
import { TabStore } from './tab.store';
import { Toasts } from './toast';
import { TxStore } from './tx.store';
import { Ui } from './ui';
import type { QueryResult } from './models';

export interface RunMessage { time: number; kind: 'ok' | 'error' | 'info'; text: string; statement?: string; }
export type ResultsPanel = 'results' | 'messages' | 'history';

/** A result shown in the editor under the statement that produced it. */
export interface InlineBlock {
  id: string;
  /** The run it came from; only the latest run's results can still be exported. */
  seq: number;
  /** Model offset just past the statement when it ran. */
  offset: number;
  result: QueryResult;
}

/** Older inline results are dropped beyond this many per tab. */
const MAX_INLINE = 30;

export interface TabRun {
  running: boolean;
  startedAt: number;
  finishedMs?: number;
  results: QueryResult[]; // result sets only (isQuery && !error)
  activeResult: number;
  messages: RunMessage[];
  panel: ResultsPanel;
  inline: InlineBlock[];
  seq: number;
}

export const PAGE_SIZE = 1000;

const emptyRun = (): TabRun => ({ running: false, startedAt: 0, results: [], activeResult: 0, messages: [], panel: 'results', inline: [], seq: 0 });

@Injectable({ providedIn: 'root' })
export class RunStore {
  private api = inject(Api);
  private tabs = inject(TabStore);
  private conns = inject(ConnectionStore);
  private editor = inject(EditorBridge);
  private toasts = inject(Toasts);
  private tx = inject(TxStore);
  private ui = inject(Ui);

  public readonly runs = signal<Record<string, TabRun>>({});

  public get(tabId: string): TabRun { return this.runs()[tabId] ?? emptyRun(); }

  public setPanel(tabId: string, panel: ResultsPanel) { this.patch(tabId, { panel }); }
  public setActiveResult(tabId: string, i: number) { this.patch(tabId, { activeResult: i, panel: 'results' }); }

  /** Removes inline results from a tab (all of them when `ids` is omitted). */
  public dismissInline(tabId: string, ids?: readonly string[]) {
    const run = this.get(tabId);
    const drop = ids && new Set(ids);
    const inline = drop ? run.inline.filter((b) => !drop.has(b.id)) : [];
    if (inline.length !== run.inline.length) this.patch(tabId, { inline });
  }

  /** Runs the selection, else the statement under the cursor (`all` = whole script). */
  public async run(mode: 'cursor' | 'all') {
    const tab = this.tabs.active();
    if (!tab) return;
    if (this.get(tab.id).running) return;
    if (!tab.connId || !this.conns.get(tab.connId)) {
      this.toasts.error('Choose a connection for this tab first.');
      return;
    }
    const target = this.editor.runTarget(mode);
    if (!target || !target.sql.trim()) return;
    if (!(await this.conns.ensureConnected(tab.connId))) return;

    const startedAt = Date.now();
    this.patch(tab.id, { running: true, startedAt, finishedMs: undefined });
    try {
      const resp = await this.api.execute({ tabId: tab.id, connId: tab.connId, database: tab.database, sql: target.sql, cursor: target.cursor, maxRows: PAGE_SIZE, manual: tab.txMode === 'manual' });
      this.tx.set(tab.id, resp.tx);
      const now = Date.now();
      const messages: RunMessage[] = [];
      if (resp.notice) messages.push({ time: now, kind: resp.cancelled ? 'error' : 'info', text: resp.notice });
      for (const r of resp.results) messages.push(describe(r, now));
      const results = resp.results.filter((r) => r.isQuery && !r.error);
      const failed = resp.results.some((r) => r.error);
      const prev = this.get(tab.id);
      const inline = this.ui.inlineResults();
      this.patch(tab.id, {
        running: false,
        finishedMs: now - startedAt,
        results,
        activeResult: Math.max(0, results.length - 1),
        messages: [...messages, ...prev.messages].slice(0, 500),
        panel: failed || !results.length ? 'messages' : 'results',
        ...(inline ? this.inlineFor(prev, resp.results, target.base) : {}),
      });
      if (inline) {
        if (resp.notice) this.toasts.show(resp.notice, resp.cancelled ? 'error' : 'info');
        const done = resp.results.filter((r) => !r.error && !r.isQuery).length;
        if (resp.results.length > 1 && done) this.toasts.success(`${done} statement${done === 1 ? '' : 's'} executed.`);
      }
      if (failed) this.editor.flashError();
    } catch (e) {
      const prev = this.get(tab.id);
      this.patch(tab.id, {
        running: false,
        finishedMs: Date.now() - startedAt,
        messages: [{ time: Date.now(), kind: 'error' as const, text: errorText(e) }, ...prev.messages],
        panel: 'messages',
      });
      if (this.ui.inlineResults()) this.toasts.error(errorText(e));
    }
  }

  public cancel(tabId = this.tabs.activeId()) {
    if (this.get(tabId).running) void this.api.cancel(tabId);
  }

  public async fetchMore(tabId: string, resultId: string) {
    try {
      const r = await this.api.fetchMore(tabId, resultId, PAGE_SIZE);
      this.updateResult(tabId, resultId, (res) => ({
        ...res,
        rows: res.rows.concat(r.rows),
        hasMore: r.hasMore,
        canFetchMore: r.hasMore && !r.error,
      }));
      if (r.error) this.toasts.error(r.error);
    } catch (e) {
      this.toasts.error(errorText(e));
      this.updateResult(tabId, resultId, (res) => ({ ...res, canFetchMore: false }));
    }
  }

  public async export(tabId: string, resultId: string, format: 'csv' | 'json') {
    try {
      const r = await this.api.exportResult(tabId, resultId, format);
      if (!r.path) return;
      // Exporting drains the server cursor, so no further pages can be fetched.
      this.updateResult(tabId, resultId, (res) => ({ ...res, canFetchMore: false }));
      this.toasts.success(`Exported ${r.rows.toLocaleString()} rows to ${r.path}`);
    } catch (e) {
      this.toasts.error(`Export failed: ${errorText(e)}`);
    }
  }

  public forget(tabId: string) {
    const r = { ...this.runs() };
    delete r[tabId];
    this.runs.set(r);
  }

  /**
   * Inline blocks after a run: result sets and errors always, other
   * statements only when a single one ran (a script would flood the editor).
   * Earlier results lose their server cursor, so they cannot fetch more.
   */
  private inlineFor(prev: TabRun, results: QueryResult[], base: number): Pick<TabRun, 'inline' | 'seq'> {
    const seq = prev.seq + 1;
    const older = prev.inline.map((b) => (b.result.canFetchMore ? { ...b, result: { ...b.result, canFetchMore: false } } : b));
    const added = results
      .filter((r) => r.error || r.isQuery || results.length === 1)
      .map((r) => ({ id: r.id, seq, offset: base + r.end, result: r }));
    return { seq, inline: [...older, ...added].slice(-MAX_INLINE) };
  }

  private updateResult(tabId: string, resultId: string, fn: (r: QueryResult) => QueryResult) {
    const run = this.get(tabId);
    this.patch(tabId, {
      results: run.results.map((r) => (r.id === resultId ? fn(r) : r)),
      inline: run.inline.map((b) => (b.id === resultId ? { ...b, result: fn(b.result) } : b)),
    });
  }

  private patch(tabId: string, p: Partial<TabRun>) {
    this.runs.set({ ...this.runs(), [tabId]: { ...this.get(tabId), ...p } });
  }
}

function describe(r: QueryResult, time: number): RunMessage {
  const ms = `${r.durationMs.toLocaleString()} ms`;
  if (r.error) return { time, kind: 'error', text: r.error, statement: r.statement };
  if (r.message) return { time, kind: 'info', text: r.message, statement: r.statement };
  if (r.isQuery) {
    const n = r.rows.length.toLocaleString();
    return { time, kind: 'ok', text: `${n}${r.hasMore ? '+' : ''} row${r.rows.length === 1 ? '' : 's'} fetched in ${ms}`, statement: r.statement };
  }
  const affected = r.rowsAffected >= 0 ? `${r.rowsAffected.toLocaleString()} row${r.rowsAffected === 1 ? '' : 's'} affected` : 'Done';
  return { time, kind: 'ok', text: `${affected} in ${ms}`, statement: r.statement };
}
