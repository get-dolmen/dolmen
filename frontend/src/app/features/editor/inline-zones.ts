import { ApplicationRef, type ComponentRef, EnvironmentInjector, createComponent } from '@angular/core';
import type { InlineBlock, RunStore, TabRun } from '../../core/run.store';
import { INLINE_HEADER_HEIGHT, InlineResult, inlineHeight } from '../results/inline-result';
import { monaco } from './monaco-setup';

const ZONE_GAP = 4; // space above and below a block inside its zone
const MIN_HEIGHT = INLINE_HEADER_HEIGHT;
const MAX_HEIGHT = 2000;

interface BlockZone {
  block: InlineBlock;
  viewZone: monaco.editor.IViewZone;
  zoneId: string;
  overlayWidget: monaco.editor.IOverlayWidget;
  element: HTMLElement;
  componentRef: ComponentRef<InlineResult>;
  /** Last position written, so scrolling only touches the DOM when it moves. */
  lastTop: number;
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
  private anchorsByBlockId = new Map<string, { model: monaco.editor.ITextModel; decoration: string }>();
  private zonesByBlockId = new Map<string, BlockZone>();
  /** Heights the user set by dragging, by block id. */
  private heightsByBlockId = new Map<string, number>();
  private currentTabId = '';
  private subscriptions: monaco.IDisposable[] = [];

  public constructor(
    private editor: monaco.editor.IStandaloneCodeEditor,
    private runStore: RunStore,
    private applicationRef: ApplicationRef,
    private environmentInjector: EnvironmentInjector,
    private modelsByTabId: Map<string, monaco.editor.ITextModel>,
  ) {
    this.subscriptions.push(editor.onDidLayoutChange(() => {
      for (const blockZone of this.zonesByBlockId.values()) this.placeHorizontally(blockZone);
    }));
    // Monaco shifts zones on its own, but splitting a statement's line keeps
    // the zone under the first half: follow the anchors instead.
    this.subscriptions.push(editor.onDidChangeModelContent(() => this.followAnchors()));
  }

  /** Brings the zones in line with the runs, for the tab shown in the editor. */
  public update(runs: Record<string, TabRun>, enabled: boolean, tabId: string) {
    this.syncAnchors(runs);
    if (tabId !== this.currentTabId || !enabled) this.clear();
    this.currentTabId = tabId;
    const run = runs[tabId];
    if (!enabled || !run || this.editor.getModel() !== this.modelsByTabId.get(tabId)) return;

    const wantedIds = new Set(run.inline.map((block) => block.id));
    const removedZones = [...this.zonesByBlockId.values()].filter((blockZone) => !wantedIds.has(blockZone.block.id));
    if (removedZones.length) {
      this.editor.changeViewZones((accessor) => {
        for (const blockZone of removedZones) this.removeZone(blockZone, accessor);
      });
    }

    for (const block of run.inline) {
      const blockZone = this.zonesByBlockId.get(block.id);
      if (!blockZone) {
        this.addZone(block, run.seq);
      } else {
        blockZone.componentRef.setInput('live', block.seq === run.seq);
        if (blockZone.block !== block) {
          blockZone.block = block;
          blockZone.componentRef.setInput('block', block);
          if (!this.heightsByBlockId.has(block.id)) this.resizeZone(blockZone, inlineHeight(block.result));
        }
      }
    }
  }

  private followAnchors() {
    const movedZones = [...this.zonesByBlockId.values()].filter((blockZone) => {
      const line = this.lineFor(blockZone.block.id);
      return line > 0 && line !== blockZone.viewZone.afterLineNumber;
    });
    if (!movedZones.length) return;
    this.editor.changeViewZones((accessor) => {
      for (const blockZone of movedZones) {
        blockZone.viewZone.afterLineNumber = this.lineFor(blockZone.block.id);
        accessor.layoutZone(blockZone.zoneId);
      }
    });
  }

  /** Removes every zone from the editor (before a model switch). */
  public clear() {
    if (!this.zonesByBlockId.size) return;
    this.editor.changeViewZones((accessor) => {
      for (const blockZone of [...this.zonesByBlockId.values()]) this.removeZone(blockZone, accessor);
    });
  }

  public dispose() {
    this.clear();
    for (const anchor of this.anchorsByBlockId.values()) {
      if (!anchor.model.isDisposed()) anchor.model.deltaDecorations([anchor.decoration], []);
    }
    this.anchorsByBlockId.clear();
    for (const subscription of this.subscriptions) subscription.dispose();
  }

  /**
   * Gives new blocks a decoration at the end of their statement, drops the
   * decorations of removed blocks, and replaces an older result that sits on
   * the same line as a new one (running a statement again).
   */
  private syncAnchors(runs: Record<string, TabRun>) {
    const liveIds = new Set<string>();
    for (const [tabId, run] of Object.entries(runs)) {
      const model = this.modelsByTabId.get(tabId);
      const freshBlocks: InlineBlock[] = [];
      for (const block of run.inline) {
        liveIds.add(block.id);
        if (this.anchorsByBlockId.has(block.id) || !model) continue;
        // The anchor covers the statement's last line up to its end: text
        // typed right after it (a new statement below) stays outside, where
        // an empty range would be pushed along onto the new line.
        const position = model.getPositionAt(block.offset);
        const decoration = model.deltaDecorations([], [{
          range: new monaco.Range(position.lineNumber, 1, position.lineNumber, position.column),
          options: { stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges },
        }])[0];
        this.anchorsByBlockId.set(block.id, { model, decoration });
        freshBlocks.push(block);
      }
      if (!freshBlocks.length) continue;
      const usedLines = new Set(freshBlocks.map((block) => this.lineFor(block.id)));
      const latestSequence = Math.max(...freshBlocks.map((block) => block.seq));
      const replacedBlockIds = run.inline
        .filter((block) => block.seq < latestSequence && usedLines.has(this.lineFor(block.id)))
        .map((block) => block.id);
      // Writes the store; the effect that called us runs again with the result.
      if (replacedBlockIds.length) queueMicrotask(() => this.runStore.dismissInline(tabId, replacedBlockIds));
    }
    for (const [blockId, anchor] of [...this.anchorsByBlockId]) {
      if (liveIds.has(blockId) && !anchor.model.isDisposed()) continue;
      if (!anchor.model.isDisposed()) anchor.model.deltaDecorations([anchor.decoration], []);
      this.anchorsByBlockId.delete(blockId);
      this.heightsByBlockId.delete(blockId);
    }
  }

  private lineFor(blockId: string): number {
    const anchor = this.anchorsByBlockId.get(blockId);
    return anchor?.model.getDecorationRange(anchor.decoration)?.endLineNumber ?? 0;
  }

  private addZone(block: InlineBlock, sequence: number) {
    const line = this.lineFor(block.id);
    if (!line) return;
    const height = this.heightsByBlockId.get(block.id) ?? inlineHeight(block.result);

    const element = document.createElement('dm-inline-result');
    // Moved with a transform: no layout of the grid while the editor scrolls.
    element.style.top = '0';
    element.style.willChange = 'transform';
    element.style.transform = 'translate3d(0, -100000px, 0)'; // until the zone reports where it is
    const componentRef = createComponent(InlineResult, {
      environmentInjector: this.environmentInjector,
      hostElement: element,
    });
    componentRef.setInput('tabId', this.currentTabId);
    componentRef.setInput('block', block);
    componentRef.setInput('live', block.seq === sequence);
    this.applicationRef.attachView(componentRef.hostView);

    const blockZone = { block, zoneId: '', element, componentRef, lastTop: NaN } as BlockZone;
    // Called on every render, with a far negative top once out of view.
    const viewZone: monaco.editor.IViewZone = {
      afterLineNumber: line,
      heightInPx: height + 2 * ZONE_GAP,
      domNode: document.createElement('div'),
      onDomNodeTop: (top) => {
        const roundedTop = Math.max(-100000, Math.round(top + ZONE_GAP));
        if (roundedTop === blockZone.lastTop) return;
        blockZone.lastTop = roundedTop;
        element.style.transform = `translate3d(0, ${roundedTop}px, 0)`;
      },
    };
    const overlayWidget: monaco.editor.IOverlayWidget = {
      getId: () => `dolmen.inline.${block.id}`,
      getDomNode: () => element,
      getPosition: () => null,
    };
    blockZone.viewZone = viewZone;
    blockZone.overlayWidget = overlayWidget;
    element.style.height = `${height}px`;
    this.placeHorizontally(blockZone);
    this.wireEvents(blockZone);
    this.editor.addOverlayWidget(overlayWidget);
    this.editor.changeViewZones((accessor) => { blockZone.zoneId = accessor.addZone(viewZone); });
    this.zonesByBlockId.set(block.id, blockZone);
  }

  private removeZone(blockZone: BlockZone, accessor: monaco.editor.IViewZoneChangeAccessor) {
    accessor.removeZone(blockZone.zoneId);
    this.editor.removeOverlayWidget(blockZone.overlayWidget);
    this.applicationRef.detachView(blockZone.componentRef.hostView);
    blockZone.componentRef.destroy();
    this.zonesByBlockId.delete(blockZone.block.id);
  }

  private resizeZone(blockZone: BlockZone, height: number) {
    blockZone.element.style.height = `${height}px`;
    blockZone.viewZone.heightInPx = height + 2 * ZONE_GAP;
    this.editor.changeViewZones((accessor) => accessor.layoutZone(blockZone.zoneId));
  }

  /** Spans the text area, from the end of the gutter to the scrollbar. */
  private placeHorizontally(blockZone: BlockZone) {
    const layoutInfo = this.editor.getLayoutInfo();
    blockZone.element.style.left = `${layoutInfo.contentLeft}px`;
    const width = layoutInfo.width - layoutInfo.contentLeft - layoutInfo.verticalScrollbarWidth - 16;
    blockZone.element.style.width = `${Math.max(200, width)}px`;
  }

  private wireEvents(blockZone: BlockZone) {
    const blockId = blockZone.block.id;
    blockZone.componentRef.instance.closed.subscribe(() => this.runStore.dismissInline(this.currentTabId, [blockId]));
    blockZone.componentRef.instance.resetHeight.subscribe(() => {
      this.heightsByBlockId.delete(blockId);
      this.resizeZone(blockZone, inlineHeight(blockZone.block.result));
    });
    blockZone.componentRef.instance.resizeStart.subscribe((event) => {
      event.preventDefault();
      const target = event.target as HTMLElement;
      const startClientY = event.clientY;
      const startHeight = blockZone.element.offsetHeight;
      target.setPointerCapture(event.pointerId);
      document.body.style.cursor = 'row-resize';
      const onPointerMove = (moveEvent: PointerEvent) => {
        const height = Math.round(
          Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, startHeight + moveEvent.clientY - startClientY)),
        );
        this.heightsByBlockId.set(blockId, height);
        this.resizeZone(blockZone, height);
      };
      const onPointerUp = () => {
        target.removeEventListener('pointermove', onPointerMove);
        target.removeEventListener('pointerup', onPointerUp);
        document.body.style.cursor = '';
      };
      target.addEventListener('pointermove', onPointerMove);
      target.addEventListener('pointerup', onPointerUp);
    });

    // Keys typed in the grid must not reach Monaco's keybindings (the app's
    // own shortcuts listen on window in the capture phase and still work).
    blockZone.element.addEventListener('keydown', (event) => event.stopPropagation());
    // The wheel scrolls the grid while it can, then the editor (vertically).
    // Monaco never sees it: it would cancel the grid's native scrolling.
    blockZone.element.addEventListener('wheel', (event) => {
      event.stopPropagation();
      if (event.defaultPrevented || event.ctrlKey) return;
      if (canScroll(event.target as HTMLElement, blockZone.element, event.deltaX, event.deltaY)) return;
      event.preventDefault();
      const lineHeight = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 20 : 1;
      this.editor.setScrollTop(this.editor.getScrollTop() + event.deltaY * lineHeight);
    }, { passive: false });
  }
}

/** True when an element between `from` and `root` can still scroll that way. */
function canScroll(from: HTMLElement | null, root: HTMLElement, deltaX: number, deltaY: number): boolean {
  const isVertical = Math.abs(deltaY) >= Math.abs(deltaX);
  for (let element = from; element && element !== root.parentElement; element = element.parentElement) {
    const style = getComputedStyle(element);
    if (isVertical) {
      if (element.scrollHeight <= element.clientHeight || !/auto|scroll/.test(style.overflowY)) continue;
      const canScrollDown = deltaY > 0
        && element.scrollTop + element.clientHeight < element.scrollHeight - 1;
      if ((deltaY < 0 && element.scrollTop > 0) || canScrollDown) return true;
    } else {
      if (element.scrollWidth <= element.clientWidth || !/auto|scroll/.test(style.overflowX)) continue;
      const canScrollRight = deltaX > 0
        && element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
      if ((deltaX < 0 && element.scrollLeft > 0) || canScrollRight) return true;
    }
  }
  return !isVertical; // horizontal wheel never scrolls the editor vertically
}
