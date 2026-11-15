import { ApplicationRef, type ComponentRef, EnvironmentInjector, createComponent } from '@angular/core';
import type { InlineBlock, RunStore, TabRun } from '../../core/run.store';
import { INLINE_HEAD, InlineResult, inlineHeight } from '../results/inline-result';
import { monaco } from './monaco-setup';

const GAP = 4; // space above and below a block inside its zone
const MIN_HEIGHT = INLINE_HEAD;
const MAX_HEIGHT = 2000;

interface Zone {
  block: InlineBlock;
  zone: monaco.editor.IViewZone;
  zoneId: string;
  overlay: monaco.editor.IOverlayWidget;
  dom: HTMLElement;
  ref: ComponentRef<InlineResult>;
  /** Last position written, so scrolling only touches the DOM when it moves. */
  top: number;
}

/**
 * Shows query results inside the editor, under the statement that produced
 * them. Each block is a view zone (empty space after the statement's line,
 * which follows edits) with an overlay widget drawn on top of it: overlay
 * widgets receive mouse and wheel events, view zones do not.
 *
 * Every block is anchored by a model decoration, so it stays under its
 * statement while the text changes, also in tabs that are not shown.
 */
export class InlineZones {
  private anchors = new Map<string, { model: monaco.editor.ITextModel; decoration: string }>();
  private zones = new Map<string, Zone>();
  /** Heights the user set by dragging, by block id. */
  private heights = new Map<string, number>();
  private tabId = '';
  private disposables: monaco.IDisposable[] = [];

  public constructor(
    private editor: monaco.editor.IStandaloneCodeEditor,
    private runs: RunStore,
    private appRef: ApplicationRef,
    private injector: EnvironmentInjector,
    private models: Map<string, monaco.editor.ITextModel>,
  ) {
    this.disposables.push(editor.onDidLayoutChange(() => { for (const z of this.zones.values()) this.placeX(z); }));
    // Monaco shifts zones on its own, but splitting a statement's line keeps
    // the zone under the first half: follow the anchors instead.
    this.disposables.push(editor.onDidChangeModelContent(() => this.follow()));
  }

  /** Brings the zones in line with the runs, for the tab shown in the editor. */
  public update(runs: Record<string, TabRun>, enabled: boolean, tabId: string) {
    this.anchor(runs);
    if (tabId !== this.tabId || !enabled) this.clear();
    this.tabId = tabId;
    const run = runs[tabId];
    if (!enabled || !run || this.editor.getModel() !== this.models.get(tabId)) return;

    const wanted = new Set(run.inline.map((b) => b.id));
    const gone = [...this.zones.values()].filter((z) => !wanted.has(z.block.id));
    if (gone.length) this.editor.changeViewZones((acc) => { for (const z of gone) this.remove(z, acc); });

    for (const b of run.inline) {
      const z = this.zones.get(b.id);
      if (!z) {
        this.add(b, run.seq);
      } else {
        z.ref.setInput('live', b.seq === run.seq);
        if (z.block !== b) {
          z.block = b;
          z.ref.setInput('block', b);
          if (!this.heights.has(b.id)) this.resize(z, inlineHeight(b.result));
        }
      }
    }
  }

  private follow() {
    const moved = [...this.zones.values()].filter((z) => {
      const line = this.line(z.block.id);
      return line > 0 && line !== z.zone.afterLineNumber;
    });
    if (!moved.length) return;
    this.editor.changeViewZones((acc) => {
      for (const z of moved) {
        z.zone.afterLineNumber = this.line(z.block.id);
        acc.layoutZone(z.zoneId);
      }
    });
  }

  /** Removes every zone from the editor (before a model switch). */
  public clear() {
    if (!this.zones.size) return;
    this.editor.changeViewZones((acc) => { for (const z of [...this.zones.values()]) this.remove(z, acc); });
  }

  public dispose() {
    this.clear();
    for (const a of this.anchors.values()) if (!a.model.isDisposed()) a.model.deltaDecorations([a.decoration], []);
    this.anchors.clear();
    for (const d of this.disposables) d.dispose();
  }

  /**
   * Gives new blocks a decoration at the end of their statement, drops the
   * decorations of removed blocks, and replaces an older result that sits on
   * the same line as a new one (running a statement again).
   */
  private anchor(runs: Record<string, TabRun>) {
    const live = new Set<string>();
    for (const [tabId, run] of Object.entries(runs)) {
      const model = this.models.get(tabId);
      const fresh: InlineBlock[] = [];
      for (const b of run.inline) {
        live.add(b.id);
        if (this.anchors.has(b.id) || !model) continue;
        // The anchor covers the statement's last line up to its end: text
        // typed right after it (a new statement below) stays outside, where
        // an empty range would be pushed along onto the new line.
        const pos = model.getPositionAt(b.offset);
        const decoration = model.deltaDecorations([], [{
          range: new monaco.Range(pos.lineNumber, 1, pos.lineNumber, pos.column),
          options: { stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges },
        }])[0];
        this.anchors.set(b.id, { model, decoration });
        fresh.push(b);
      }
      if (!fresh.length) continue;
      const lines = new Set(fresh.map((b) => this.line(b.id)));
      const seq = Math.max(...fresh.map((b) => b.seq));
      const replaced = run.inline.filter((b) => b.seq < seq && lines.has(this.line(b.id))).map((b) => b.id);
      // Writes the store; the effect that called us runs again with the result.
      if (replaced.length) queueMicrotask(() => this.runs.dismissInline(tabId, replaced));
    }
    for (const [id, a] of [...this.anchors]) {
      if (live.has(id) && !a.model.isDisposed()) continue;
      if (!a.model.isDisposed()) a.model.deltaDecorations([a.decoration], []);
      this.anchors.delete(id);
      this.heights.delete(id);
    }
  }

  private line(id: string): number {
    const a = this.anchors.get(id);
    return a?.model.getDecorationRange(a.decoration)?.endLineNumber ?? 0;
  }

  private add(block: InlineBlock, seq: number) {
    const line = this.line(block.id);
    if (!line) return;
    const height = this.heights.get(block.id) ?? inlineHeight(block.result);

    const dom = document.createElement('dm-inline-result');
    // Moved with a transform: no layout of the grid while the editor scrolls.
    dom.style.top = '0';
    dom.style.willChange = 'transform';
    dom.style.transform = 'translate3d(0, -100000px, 0)'; // until the zone reports where it is
    const ref = createComponent(InlineResult, { environmentInjector: this.injector, hostElement: dom });
    ref.setInput('tabId', this.tabId);
    ref.setInput('block', block);
    ref.setInput('live', block.seq === seq);
    this.appRef.attachView(ref.hostView);

    const z = { block, zoneId: '', dom, ref, top: NaN } as Zone;
    // Called on every render, with a far negative top once out of view.
    const zone: monaco.editor.IViewZone = {
      afterLineNumber: line,
      heightInPx: height + 2 * GAP,
      domNode: document.createElement('div'),
      onDomNodeTop: (top) => {
        const y = Math.max(-100000, Math.round(top + GAP));
        if (y === z.top) return;
        z.top = y;
        dom.style.transform = `translate3d(0, ${y}px, 0)`;
      },
    };
    const overlay: monaco.editor.IOverlayWidget = {
      getId: () => `dolmen.inline.${block.id}`,
      getDomNode: () => dom,
      getPosition: () => null,
    };
    z.zone = zone;
    z.overlay = overlay;
    dom.style.height = `${height}px`;
    this.placeX(z);
    this.wire(z);
    this.editor.addOverlayWidget(overlay);
    this.editor.changeViewZones((acc) => { z.zoneId = acc.addZone(zone); });
    this.zones.set(block.id, z);
  }

  private remove(z: Zone, acc: monaco.editor.IViewZoneChangeAccessor) {
    acc.removeZone(z.zoneId);
    this.editor.removeOverlayWidget(z.overlay);
    this.appRef.detachView(z.ref.hostView);
    z.ref.destroy();
    this.zones.delete(z.block.id);
  }

  private resize(z: Zone, height: number) {
    z.dom.style.height = `${height}px`;
    z.zone.heightInPx = height + 2 * GAP;
    this.editor.changeViewZones((acc) => acc.layoutZone(z.zoneId));
  }

  /** Spans the text area, from the end of the gutter to the scrollbar. */
  private placeX(z: Zone) {
    const info = this.editor.getLayoutInfo();
    z.dom.style.left = `${info.contentLeft}px`;
    z.dom.style.width = `${Math.max(200, info.width - info.contentLeft - info.verticalScrollbarWidth - 16)}px`;
  }

  private wire(z: Zone) {
    const id = z.block.id;
    z.ref.instance.closed.subscribe(() => this.runs.dismissInline(this.tabId, [id]));
    z.ref.instance.resetHeight.subscribe(() => {
      this.heights.delete(id);
      this.resize(z, inlineHeight(z.block.result));
    });
    z.ref.instance.resizeStart.subscribe((e) => {
      e.preventDefault();
      const target = e.target as HTMLElement;
      const startY = e.clientY;
      const startH = z.dom.offsetHeight;
      target.setPointerCapture(e.pointerId);
      document.body.style.cursor = 'row-resize';
      const move = (ev: PointerEvent) => {
        const h = Math.round(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, startH + ev.clientY - startY)));
        this.heights.set(id, h);
        this.resize(z, h);
      };
      const up = () => {
        target.removeEventListener('pointermove', move);
        target.removeEventListener('pointerup', up);
        document.body.style.cursor = '';
      };
      target.addEventListener('pointermove', move);
      target.addEventListener('pointerup', up);
    });

    // Keys typed in the grid must not reach Monaco's keybindings (the app's
    // own shortcuts listen on window in the capture phase and still work).
    z.dom.addEventListener('keydown', (e) => e.stopPropagation());
    // The wheel scrolls the grid while it can, then the editor (vertically).
    // Monaco never sees it: it would cancel the grid's native scrolling.
    z.dom.addEventListener('wheel', (e) => {
      e.stopPropagation();
      if (e.defaultPrevented || e.ctrlKey || canScroll(e.target as HTMLElement, z.dom, e.deltaX, e.deltaY)) return;
      e.preventDefault();
      const unit = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 20 : 1;
      this.editor.setScrollTop(this.editor.getScrollTop() + e.deltaY * unit);
    }, { passive: false });
  }
}

/** True when an element between `from` and `root` can still scroll that way. */
function canScroll(from: HTMLElement | null, root: HTMLElement, dx: number, dy: number): boolean {
  const vertical = Math.abs(dy) >= Math.abs(dx);
  for (let el = from; el && el !== root.parentElement; el = el.parentElement) {
    const style = getComputedStyle(el);
    if (vertical) {
      if (el.scrollHeight <= el.clientHeight || !/auto|scroll/.test(style.overflowY)) continue;
      if ((dy < 0 && el.scrollTop > 0) || (dy > 0 && el.scrollTop + el.clientHeight < el.scrollHeight - 1)) return true;
    } else {
      if (el.scrollWidth <= el.clientWidth || !/auto|scroll/.test(style.overflowX)) continue;
      if ((dx < 0 && el.scrollLeft > 0) || (dx > 0 && el.scrollLeft + el.clientWidth < el.scrollWidth - 1)) return true;
    }
  }
  return !vertical; // horizontal wheel never scrolls the editor vertically
}
