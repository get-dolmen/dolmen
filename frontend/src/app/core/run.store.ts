import { Injectable, inject, signal } from '@angular/core';
import { Api, errorText } from './api';
import { ConnectionStore } from './connection.store';
import { EditorBridge } from './editor-bridge';
import { TabStore } from './tab.store';
import { Toasts } from './toast';
import { TxStore } from './tx.store';
import { Ui } from './ui';
import { formatAffectedRows, formatCount, formatDuration } from '../shared/format';
import type { QueryResult } from './models';

export interface RunMessage {
  time: number;
  kind: 'ok' | 'error' | 'info';
  text: string;
  statement?: string;
}
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
const MAX_INLINE_BLOCKS = 30;

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

const createEmptyRun = (): TabRun => ({
  running: false,
  startedAt: 0,
  results: [],
  activeResult: 0,
  messages: [],
  panel: 'results',
  inline: [],
  seq: 0,
});

@Injectable({ providedIn: 'root' })
export class RunStore {
  private api = inject(Api);
  private tabStore = inject(TabStore);
  private connectionStore = inject(ConnectionStore);
  private editorBridge = inject(EditorBridge);
  private toastService = inject(Toasts);
  private transactionStore = inject(TxStore);
  private uiState = inject(Ui);

  public readonly runs = signal<Record<string, TabRun>>({});

  public get(tabId: string): TabRun {
    return this.runs()[tabId] ?? createEmptyRun();
  }

  public setPanel(tabId: string, panel: ResultsPanel) {
    this.patch(tabId, { panel });
  }
  public setActiveResult(tabId: string, index: number) {
    this.patch(tabId, { activeResult: index, panel: 'results' });
  }

  /** Removes inline results from a tab (all of them when `ids` is omitted). */
  public dismissInline(tabId: string, resultIds?: readonly string[]) {
    const run = this.get(tabId);
    const dismissedIds = resultIds && new Set(resultIds);
    const inline = dismissedIds ? run.inline.filter((block) => !dismissedIds.has(block.id)) : [];
    if (inline.length !== run.inline.length) this.patch(tabId, { inline });
  }

  /** Runs the selection, else the statement under the cursor (`all` = whole script). */
  public async run(mode: 'cursor' | 'all') {
    const tab = this.tabStore.active();
    if (!tab) return;
    if (this.get(tab.id).running) return;
    if (!tab.connId || !this.connectionStore.get(tab.connId)) {
      this.toastService.error('Choose a connection for this tab first.');
      return;
    }
    const runTarget = this.editorBridge.runTarget(mode);
    if (!runTarget || !runTarget.sql.trim()) return;
    if (!(await this.connectionStore.ensureConnected(tab.connId))) return;

    const startedAt = Date.now();
    this.patch(tab.id, { running: true, startedAt, finishedMs: undefined });
    try {
      const response = await this.api.execute({
        tabId: tab.id,
        connId: tab.connId,
        database: tab.database,
        sql: runTarget.sql,
        cursor: runTarget.cursor,
        maxRows: PAGE_SIZE,
        manual: tab.txMode === 'manual',
      });
      this.transactionStore.set(tab.id, response.tx);
      const now = Date.now();
      const messages: RunMessage[] = [];
      if (response.notice)
        messages.push({
          time: now,
          kind: response.cancelled ? 'error' : 'info',
          text: response.notice,
        });
      for (const result of response.results) messages.push(describeResult(result, now));
      const results = response.results.filter((result) => result.isQuery && !result.error);
      const hasFailure = response.results.some((result) => result.error);
      const previous = this.get(tab.id);
      const inlineResultsEnabled = this.uiState.inlineResults();
      this.patch(tab.id, {
        running: false,
        finishedMs: now - startedAt,
        results,
        activeResult: Math.max(0, results.length - 1),
        messages: [...messages, ...previous.messages].slice(0, 500),
        panel: hasFailure || !results.length ? 'messages' : 'results',
        ...(inlineResultsEnabled
          ? this.inlineFor(previous, response.results, runTarget.startOffset)
          : {}),
      });
      if (inlineResultsEnabled) {
        if (response.notice)
          this.toastService.show(response.notice, response.cancelled ? 'error' : 'info');
        const executedCount = response.results.filter(
          (result) => !result.error && !result.isQuery,
        ).length;
        if (response.results.length > 1 && executedCount) {
          this.toastService.success(
            `${executedCount} statement${executedCount === 1 ? '' : 's'} executed.`,
          );
        }
      }
      if (hasFailure) this.editorBridge.flashError();
    } catch (error) {
      const previous = this.get(tab.id);
      this.patch(tab.id, {
        running: false,
        finishedMs: Date.now() - startedAt,
        messages: [
          { time: Date.now(), kind: 'error' as const, text: errorText(error) },
          ...previous.messages,
        ],
        panel: 'messages',
      });
      if (this.uiState.inlineResults()) this.toastService.error(errorText(error));
    }
  }

  public cancel(tabId = this.tabStore.activeId()) {
    if (this.get(tabId).running) void this.api.cancel(tabId);
  }

  public async fetchMore(tabId: string, resultId: string) {
    try {
      const page = await this.api.fetchMore(tabId, resultId, PAGE_SIZE);
      this.updateResult(tabId, resultId, (current) => ({
        ...current,
        rows: current.rows.concat(page.rows),
        hasMore: page.hasMore,
        canFetchMore: page.hasMore && !page.error,
      }));
      if (page.error) this.toastService.error(page.error);
    } catch (error) {
      this.toastService.error(errorText(error));
      this.updateResult(tabId, resultId, (current) => ({ ...current, canFetchMore: false }));
    }
  }

  public async export(tabId: string, resultId: string, format: 'csv' | 'json') {
    try {
      const exported = await this.api.exportResult(tabId, resultId, format);
      if (!exported.path) return;
      // Exporting drains the server cursor, so no further pages can be fetched.
      this.updateResult(tabId, resultId, (current) => ({ ...current, canFetchMore: false }));
      this.toastService.success(`Exported ${formatCount(exported.rows)} rows to ${exported.path}`);
    } catch (error) {
      this.toastService.error(`Export failed: ${errorText(error)}`);
    }
  }

  public forget(tabId: string) {
    const runs = { ...this.runs() };
    delete runs[tabId];
    this.runs.set(runs);
  }

  /**
   * Inline blocks after a run: result sets and errors always, other
   * statements only when a single one ran (a script would flood the editor).
   * Earlier results lose their server cursor, so they cannot fetch more.
   */
  private inlineFor(
    previous: TabRun,
    results: QueryResult[],
    baseOffset: number,
  ): Pick<TabRun, 'inline' | 'seq'> {
    const seq = previous.seq + 1;
    const older = previous.inline.map((block) =>
      block.result.canFetchMore
        ? { ...block, result: { ...block.result, canFetchMore: false } }
        : block,
    );
    const added = results
      .filter((result) => result.error || result.isQuery || results.length === 1)
      .map((result) => ({ id: result.id, seq, offset: baseOffset + result.end, result }));
    return { seq, inline: [...older, ...added].slice(-MAX_INLINE_BLOCKS) };
  }

  private updateResult(
    tabId: string,
    resultId: string,
    transform: (result: QueryResult) => QueryResult,
  ) {
    const run = this.get(tabId);
    this.patch(tabId, {
      results: run.results.map((result) => (result.id === resultId ? transform(result) : result)),
      inline: run.inline.map((block) =>
        block.id === resultId ? { ...block, result: transform(block.result) } : block,
      ),
    });
  }

  private patch(tabId: string, changes: Partial<TabRun>) {
    this.runs.set({ ...this.runs(), [tabId]: { ...this.get(tabId), ...changes } });
  }
}

function describeResult(result: QueryResult, time: number): RunMessage {
  const elapsed = formatDuration(result.durationMs);
  if (result.error) return { time, kind: 'error', text: result.error, statement: result.statement };
  if (result.message)
    return { time, kind: 'info', text: result.message, statement: result.statement };
  if (result.isQuery) {
    const count = formatCount(result.rows.length);
    return {
      time,
      kind: 'ok',
      text: `${count}${result.hasMore ? '+' : ''} row${result.rows.length === 1 ? '' : 's'} fetched in ${elapsed}`,
      statement: result.statement,
    };
  }
  const affected = formatAffectedRows(result.rowsAffected);
  return { time, kind: 'ok', text: `${affected} in ${elapsed}`, statement: result.statement };
}
