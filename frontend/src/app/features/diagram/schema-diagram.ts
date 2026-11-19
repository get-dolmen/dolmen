import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { Commands } from '../../core/commands';
import { SchemaStore } from '../../core/schema.store';
import { type EditorTab } from '../../core/tab.store';
import { Icon } from '../../shared/icon';
import type { DbTable } from '../../core/models';

const BOX_WIDTH = 240;
const HEADER_HEIGHT = 32;
const ROW_HEIGHT = 20;
const ROW_PADDING = 6;
const LAYER_GAP = 110;
const NODE_GAP = 36;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 2.5;

interface DiagramColumn {
  name: string;
  /** primary key, or one end of a foreign key */
  key: boolean;
  pk: boolean;
}

interface DiagramBox {
  key: string;
  name: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  columns: DiagramColumn[];
  /** columns hidden by the "key columns only" mode */
  hiddenColumns: number;
}

interface DiagramEdge {
  key: string;
  path: string;
  title: string;
}

interface DiagramScene {
  boxes: DiagramBox[];
  edges: DiagramEdge[];
}

interface DragState {
  mode: 'pan' | 'node';
  key?: string;
  x: number;
  y: number;
  originX?: number;
  originY?: number;
}

/** Draws a schema as boxes linked by their foreign keys: the macro view of a database. */
@Component({
  selector: 'dm-schema-diagram',
  imports: [Icon],
  templateUrl: './schema-diagram.html',
  styleUrl: './schema-diagram.scss',
})
export class SchemaDiagram implements AfterViewInit, OnDestroy {
  private commandService = inject(Commands);
  private schemaStore = inject(SchemaStore);
  private viewport = viewChild<ElementRef<SVGSVGElement>>('viewport');

  public readonly tab = input.required<EditorTab>();
  public readonly schema = computed(() => this.tab().diagram?.schema ?? '');
  public readonly showAllColumns = signal(false);
  public readonly zoom = signal(1);
  public readonly pan = signal({ x: 40, y: 40 });

  /** Positions changed by dragging a box, keyed by "schema.table". */
  private readonly positions = signal<Record<string, { x: number; y: number }>>({});
  private drag: DragState | null = null;
  private fitted = false;
  private resizeObserver?: ResizeObserver;

  public readonly loading = computed(() => {
    const tab = this.tab();
    const schema = tab.diagram?.schema ?? '';
    const scope = this.schemaStore.scopeFor(tab.connId, tab.database);
    const loading = this.schemaStore.loading();
    return (
      loading.has(`${scope}|tables|${schema}`) ||
      loading.has(`${scope}|allcols|${schema}`) ||
      loading.has(`${scope}|fks|${schema}`)
    );
  });

  /** The boxes and edges, laid out on a layered grid with parents above children. */
  public readonly scene = computed<DiagramScene>(() => {
    const tab = this.tab();
    const schema = tab.diagram?.schema ?? '';
    const scope = this.schemaStore.scopeFor(tab.connId, tab.database);
    const cached = this.schemaStore.get(scope);
    const tables = (cached?.tables[schema] ?? []).filter((table) => table.type === 'table');
    const allColumns = cached?.columns ?? {};
    const foreignKeys = (cached?.foreignKeys[schema] ?? []).filter(
      (foreignKey) => foreignKey.schema === schema && foreignKey.refSchema === schema,
    );
    const names = new Set(tables.map((table) => table.name));

    const keyColumns = new Map<string, Set<string>>();
    const addKey = (table: string, column: string) => {
      if (!table || !column || !names.has(table)) return;
      const keySet = keyColumns.get(table) ?? new Set<string>();
      keySet.add(column);
      keyColumns.set(table, keySet);
    };
    for (const foreignKey of foreignKeys) {
      addKey(foreignKey.table, foreignKey.column);
      addKey(foreignKey.refTable, foreignKey.refColumn);
    }
    for (const table of tables)
      for (const column of allColumns[`${schema}.${table.name}`] ?? [])
        if (column.pk) addKey(table.name, column.name);

    const showAll = this.showAllColumns();
    const drafts = new Map<string, Omit<DiagramBox, 'x' | 'y'>>();
    for (const table of tables) {
      const columns: DiagramColumn[] = (allColumns[`${schema}.${table.name}`] ?? []).map(
        (column) => ({
          name: column.name,
          key: column.pk || (keyColumns.get(table.name)?.has(column.name) ?? false),
          pk: column.pk,
        }),
      );
      const displayed = showAll ? columns : columns.filter((column) => column.key);
      const hiddenColumns = columns.length - displayed.length;
      const rowCount = displayed.length + (hiddenColumns && !showAll ? 1 : 0);
      drafts.set(table.name, {
        key: `${schema}.${table.name}`,
        name: table.name,
        type: table.type,
        width: BOX_WIDTH,
        height: HEADER_HEIGHT + rowCount * ROW_HEIGHT + ROW_PADDING * 2,
        columns: displayed,
        hiddenColumns: showAll ? 0 : hiddenColumns,
      });
    }

    // Rank tables so referenced parents sit above the tables that point at them.
    // Cycles keep rank 0: the layout stays stable instead of growing forever.
    const parents = new Map<string, Set<string>>(tables.map((table) => [table.name, new Set()]));
    const children = new Map<string, Set<string>>(tables.map((table) => [table.name, new Set()]));
    for (const foreignKey of foreignKeys) {
      if (
        foreignKey.table === foreignKey.refTable ||
        !names.has(foreignKey.table) ||
        !names.has(foreignKey.refTable)
      )
        continue;
      parents.get(foreignKey.table)!.add(foreignKey.refTable);
      children.get(foreignKey.refTable)!.add(foreignKey.table);
    }
    const rank = new Map<string, number>(tables.map((table) => [table.name, 0]));
    const remainingParents = new Map(
      tables.map((table) => [table.name, parents.get(table.name)!.size]),
    );
    const queue = tables
      .filter((table) => remainingParents.get(table.name) === 0)
      .map((table) => table.name);
    while (queue.length) {
      const name = queue.shift()!;
      for (const child of children.get(name) ?? []) {
        rank.set(child, Math.max(rank.get(child) ?? 0, (rank.get(name) ?? 0) + 1));
        const count = (remainingParents.get(child) ?? 1) - 1;
        remainingParents.set(child, count);
        if (count === 0) queue.push(child);
      }
    }

    const ranks = [...new Set(rank.values())].sort((left, right) => left - right);
    const layerX = new Map(ranks.map((value, index) => [value, index * (BOX_WIDTH + LAYER_GAP)]));
    const overrides = this.positions();
    const boxes: DiagramBox[] = [];
    for (const value of ranks) {
      const layerTables = tables
        .map((table) => table.name)
        .filter((name) => rank.get(name) === value)
        .sort((left, right) => left.localeCompare(right));
      let y = 0;
      for (const name of layerTables) {
        const draft = drafts.get(name)!;
        const x = layerX.get(value)!;
        const override = overrides[draft.key];
        boxes.push({ ...draft, x: override?.x ?? x, y: override?.y ?? y });
        y += draft.height + NODE_GAP;
      }
    }

    const boxByTable = new Map(boxes.map((box) => [box.name, box]));
    const grouped = new Map<string, { table: string; refTable: string; pairs: string[] }>();
    for (const foreignKey of foreignKeys) {
      if (
        foreignKey.table === foreignKey.refTable ||
        !boxByTable.has(foreignKey.table) ||
        !boxByTable.has(foreignKey.refTable)
      )
        continue;
      const groupKey = `${foreignKey.table}|${foreignKey.constraint ?? ''}|${foreignKey.refTable}`;
      const group = grouped.get(groupKey) ?? {
        table: foreignKey.table,
        refTable: foreignKey.refTable,
        pairs: [],
      };
      group.pairs.push(`${foreignKey.column} → ${foreignKey.refColumn || '?'}`);
      grouped.set(groupKey, group);
    }
    const edges: DiagramEdge[] = [];
    for (const [key, group] of grouped) {
      const from = boxByTable.get(group.table)!;
      const to = boxByTable.get(group.refTable)!;
      edges.push({
        key,
        path: edgePath(from, to),
        title: `${group.table} → ${group.refTable}\n${group.pairs.join('\n')}`,
      });
    }
    return { boxes, edges };
  });

  public constructor() {
    // Load the metadata the diagram needs; cached schemas answer instantly.
    effect(() => {
      const tab = this.tab();
      const schema = tab.diagram?.schema ?? '';
      const scope = this.schemaStore.scopeFor(tab.connId, tab.database);
      if (!schema) return;
      untracked(() => {
        void this.schemaStore.loadTables(scope, schema);
        void this.schemaStore.loadAllColumns(scope, schema);
        void this.schemaStore.loadForeignKeys(scope, schema);
      });
    });
    // Fit once the first boxes exist and the canvas has a size.
    effect(() => {
      if (this.scene().boxes.length) untracked(() => this.fitIfNeeded());
    });
  }

  public ngAfterViewInit() {
    const viewport = this.viewport()?.nativeElement;
    if (!viewport) return;
    this.resizeObserver = new ResizeObserver(() => this.fitIfNeeded());
    this.resizeObserver.observe(viewport);
  }

  public ngOnDestroy() {
    this.resizeObserver?.disconnect();
  }

  public toggleColumns() {
    this.showAllColumns.update((showAll) => !showAll);
  }

  /** Reloads the scope and forgets dragged positions. */
  public async reload() {
    const tab = this.tab();
    const scope = this.schemaStore.scopeFor(tab.connId, tab.database);
    const schema = this.schema();
    this.positions.set({});
    this.fitted = false;
    await this.schemaStore.refreshScope(scope);
    void this.schemaStore.loadTables(scope, schema);
    void this.schemaStore.loadAllColumns(scope, schema);
    void this.schemaStore.loadForeignKeys(scope, schema);
  }

  public fit() {
    const scene = this.scene();
    const viewport = this.viewport()?.nativeElement;
    if (!viewport || !scene.boxes.length) return false;
    const bounds = viewport.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return false;
    const minX = Math.min(...scene.boxes.map((box) => box.x));
    const minY = Math.min(...scene.boxes.map((box) => box.y));
    const maxX = Math.max(...scene.boxes.map((box) => box.x + box.width));
    const maxY = Math.max(...scene.boxes.map((box) => box.y + box.height));
    const width = Math.max(1, maxX - minX);
    const height = Math.max(1, maxY - minY);
    const scale = Math.min(
      1,
      Math.max(MIN_ZOOM, Math.min((bounds.width - 48) / width, (bounds.height - 48) / height)),
    );
    this.zoom.set(scale);
    this.pan.set({
      x: (bounds.width - width * scale) / 2 - minX * scale,
      y: (bounds.height - height * scale) / 2 - minY * scale,
    });
    return true;
  }

  public zoomBy(factor: number) {
    const viewport = this.viewport()?.nativeElement;
    if (!viewport) return;
    const bounds = viewport.getBoundingClientRect();
    this.zoomAt(bounds.width / 2, bounds.height / 2, this.zoom() * factor);
  }

  public onWheel(event: WheelEvent) {
    event.preventDefault();
    const viewport = this.viewport()?.nativeElement;
    if (!viewport) return;
    const bounds = viewport.getBoundingClientRect();
    this.zoomAt(
      event.clientX - bounds.left,
      event.clientY - bounds.top,
      this.zoom() * (event.deltaY < 0 ? 1.1 : 1 / 1.1),
    );
  }

  public startPan(event: PointerEvent) {
    if (event.button !== 0) return;
    this.drag = { mode: 'pan', x: event.clientX, y: event.clientY };
    (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }

  public startNodeDrag(event: PointerEvent, box: DiagramBox) {
    event.stopPropagation();
    if (event.button !== 0) return;
    this.drag = {
      mode: 'node',
      key: box.key,
      x: event.clientX,
      y: event.clientY,
      originX: box.x,
      originY: box.y,
    };
    (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }

  public onPointerMove(event: PointerEvent) {
    const drag = this.drag;
    if (!drag) return;
    if (drag.mode === 'pan') {
      const pan = this.pan();
      this.pan.set({ x: pan.x + event.clientX - drag.x, y: pan.y + event.clientY - drag.y });
      drag.x = event.clientX;
      drag.y = event.clientY;
      return;
    }
    const scale = this.zoom();
    const x = (drag.originX ?? 0) + (event.clientX - drag.x) / scale;
    const y = (drag.originY ?? 0) + (event.clientY - drag.y) / scale;
    this.positions.set({ ...this.positions(), [drag.key!]: { x, y } });
  }

  public endDrag() {
    this.drag = null;
  }

  public openTable(box: DiagramBox) {
    const tab = this.tab();
    const table: DbTable = {
      schema: this.schema(),
      name: box.name,
      type: box.type === 'view' ? 'view' : 'table',
    };
    this.commandService.openTableData(tab.connId, tab.database, table);
  }

  public shortName(name: string) {
    return name.length > 27 ? `${name.slice(0, 26)}…` : name;
  }

  public shortColumn(name: string) {
    return name.length > 28 ? `${name.slice(0, 27)}…` : name;
  }

  private zoomAt(x: number, y: number, zoom: number) {
    const current = this.zoom();
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
    const pan = this.pan();
    this.pan.set({ x: x - ((x - pan.x) * next) / current, y: y - ((y - pan.y) * next) / current });
    this.zoom.set(next);
  }

  private fitIfNeeded() {
    if (this.fitted) return;
    if (this.fit()) this.fitted = true;
  }
}

/** A cubic bezier from the nearest edge of `from` to the nearest edge of `to`. */
function edgePath(from: DiagramBox, to: DiagramBox): string {
  const fromCenterX = from.x + from.width / 2;
  const toCenterX = to.x + to.width / 2;
  if (to.y + to.height <= from.y) {
    const startY = from.y;
    const endY = to.y + to.height;
    const offset = Math.min(90, Math.max(40, (startY - endY) / 2));
    return `M ${fromCenterX} ${startY} C ${fromCenterX} ${startY - offset}, ${toCenterX} ${endY + offset}, ${toCenterX} ${endY}`;
  }
  if (from.y + from.height <= to.y) {
    const startY = from.y + from.height;
    const endY = to.y;
    const offset = Math.min(90, Math.max(40, (endY - startY) / 2));
    return `M ${fromCenterX} ${startY} C ${fromCenterX} ${startY + offset}, ${toCenterX} ${endY - offset}, ${toCenterX} ${endY}`;
  }
  const toTheRight = fromCenterX <= toCenterX;
  const startX = toTheRight ? from.x + from.width : from.x;
  const endX = toTheRight ? to.x : to.x + to.width;
  const startY = from.y + from.height / 2;
  const endY = to.y + to.height / 2;
  const offset = Math.min(90, Math.max(40, Math.abs(endX - startX) / 2));
  return `M ${startX} ${startY} C ${startX + (toTheRight ? offset : -offset)} ${startY}, ${endX + (toTheRight ? -offset : offset)} ${endY}, ${endX} ${endY}`;
}
