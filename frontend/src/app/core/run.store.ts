import { Injectable, inject, signal } from '@angular/core';
import { Api, errorText } from './api';
import { ConnectionStore } from './connection.store';
import { EditorBridge } from './editor-bridge';
import { TabStore } from './tab.store';
import { Toasts } from './toast';
import { TxStore } from './tx.store';
import type { QueryResult } from './models';

export interface RunMessage { time: number; kind: 'ok' | 'error' | 'info'; text: string; statement?: string; }
export type ResultsPanel = 'results' | 'messages' | 'history';

export interface TabRun {
  running: boolean;
  startedAt: number;
  finishedMs?: number;
  results: QueryResult[]; // result sets only (isQuery && !error)
  activeResult: number;
  messages: RunMessage[];
  panel: ResultsPanel;
}

export const PAGE_SIZE = 1000;

const emptyRun = (): TabRun => ({ running: false, startedAt: 0, results: [], activeResult: 0, messages: [], panel: 'results' });

@Injectable({ providedIn: 'root' })
export class RunStore {
  private api = inject(Api);
  private tabs = inject(TabStore);
  private conns = inject(ConnectionStore);
  private editor = inject(EditorBridge);
  private toasts = inject(Toasts);
  private tx = inject(TxStore);

  readonly runs = signal<Record<string, TabRun>>({});

  get(tabId: string): TabRun { return this.runs()[tabId] ?? emptyRun(); }

  setPanel(tabId: string, panel: ResultsPanel) { this.patch(tabId, { panel }); }
  setActiveResult(tabId: string, i: number) { this.patch(tabId, { activeResult: i, panel: 'results' }); }

  /** Runs the selection, else the statement under the cursor (`all` = whole script). */
  async run(mode: 'cursor' | 'all') {
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
      this.patch(tab.id, {
        running: false,
        finishedMs: now - startedAt,
        results,
        activeResult: Math.max(0, results.length - 1),
        messages: [...messages, ...prev.messages].slice(0, 500),
        panel: failed || !results.length ? 'messages' : 'results',
      });
      if (failed) this.editor.flashError();
    } catch (e) {
      const prev = this.get(tab.id);
      this.patch(tab.id, {
        running: false,
        finishedMs: Date.now() - startedAt,
        messages: [{ time: Date.now(), kind: 'error' as const, text: errorText(e) }, ...prev.messages],
        panel: 'messages',
      });
    }
  }

  cancel(tabId = this.tabs.activeId()) {
    if (this.get(tabId).running) void this.api.cancel(tabId);
  }

  async fetchMore(tabId: string, resultId: string) {
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

  async export(tabId: string, resultId: string, format: 'csv' | 'json') {
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

  forget(tabId: string) {
    const r = { ...this.runs() };
    delete r[tabId];
    this.runs.set(r);
  }

  private updateResult(tabId: string, resultId: string, fn: (r: QueryResult) => QueryResult) {
    const run = this.get(tabId);
    this.patch(tabId, { results: run.results.map((r) => (r.id === resultId ? fn(r) : r)) });
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
