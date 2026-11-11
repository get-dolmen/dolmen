import type { ConnectionView, ScratchInfo } from '../../core/models';

/** Where a folder files its scratches: dropping a scratch on it links it there. */
export interface FolderTarget {
  connId: string;
  database: string; // '' = the connection's own database
  schema: string;
  table: string;
}

export interface FolderNode extends FolderTarget {
  kind: 'folder';
  key: string;
  level: 'conn' | 'db' | 'table' | 'none';
  label: string;
  detail?: string;
  color?: string;
  children: TreeNode[];
  count: number; // scratches below, recursively
}

export interface FileNode {
  kind: 'file';
  key: string;
  scratch: ScratchInfo;
}

export type TreeNode = FolderNode | FileNode;

export interface TreeContext {
  connections: ConnectionView[];
  /** The database a connection opens by itself (Postgres: from the server, once known). */
  currentDb: (connId: string) => string | undefined;
}

/** Label of a connection's own database: engines without a database level show their schema / service / file. */
export function ownDbLabel(c: ConnectionView, current?: string): string {
  if (current) return current;
  if (c.kind === 'sqlite') return c.filePath?.split(/[\\/]/).pop() || 'main';
  return c.database || (c.kind === 'postgres' ? 'postgres' : 'default');
}

const byLabel = (a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });

/**
 * Groups scratches into connection → database → table folders. Scratches
 * without a table sit directly in their database folder; scratches whose
 * connection no longer exists go to "No connection".
 */
export function buildScratchTree(scratches: ScratchInfo[], ctx: TreeContext): FolderNode[] {
  const conns = new Map(ctx.connections.map((c) => [c.id, c]));
  const roots = new Map<string, FolderNode>();
  const none: FolderNode = { kind: 'folder', key: 'none', level: 'none', label: 'No connection', connId: '', database: '', schema: '', table: '', children: [], count: 0 };

  const child = (parent: FolderNode, key: string, make: () => FolderNode): FolderNode => {
    let f = parent.children.find((n): n is FolderNode => n.kind === 'folder' && n.key === key);
    if (!f) {
      f = make();
      parent.children.push(f);
    }
    return f;
  };

  for (const s of scratches) {
    const c = conns.get(s.connId);
    if (!c) {
      none.children.push({ kind: 'file', key: `f:${s.id}`, scratch: s });
      none.count++;
      continue;
    }
    let conn = roots.get(c.id);
    if (!conn) {
      conn = { kind: 'folder', key: `c:${c.id}`, level: 'conn', label: c.name, color: c.color, connId: c.id, database: '', schema: '', table: '', children: [], count: 0 };
      roots.set(c.id, conn);
    }
    // The connection's own database may be stored as '' or by name: same folder.
    const current = ctx.currentDb(c.id);
    const own = !s.database || s.database === current;
    const dbLabel = own ? ownDbLabel(c, current) : s.database!;
    const db = child(conn, `d:${c.id}:${dbLabel}`, () => ({
      kind: 'folder', key: `d:${c.id}:${dbLabel}`, level: 'db', label: dbLabel, connId: c.id,
      database: own ? '' : s.database!, schema: '', table: '', children: [], count: 0,
    }));
    let parent = db;
    if (s.table) {
      parent = child(db, `t:${db.key}:${s.schema ?? ''}.${s.table}`, () => ({
        kind: 'folder', key: `t:${db.key}:${s.schema ?? ''}.${s.table}`, level: 'table', label: s.table!, detail: s.schema || undefined,
        connId: c.id, database: db.database, schema: s.schema ?? '', table: s.table!, children: [], count: 0,
      }));
      parent.count++;
    }
    parent.children.push({ kind: 'file', key: `f:${s.id}`, scratch: s });
    db.count++;
    conn.count++;
  }

  const sortTree = (f: FolderNode) => {
    const folders = f.children.filter((n): n is FolderNode => n.kind === 'folder').sort(byLabel);
    const files = f.children.filter((n): n is FileNode => n.kind === 'file')
      .sort((a, b) => a.scratch.name.localeCompare(b.scratch.name, undefined, { numeric: true, sensitivity: 'base' }));
    folders.forEach(sortTree);
    f.children = [...folders, ...files];
  };
  // Connections keep the explorer's order.
  const order = new Map(ctx.connections.map((c, i) => [c.id, i]));
  const out = [...roots.values()].sort((a, b) => (order.get(a.connId) ?? 0) - (order.get(b.connId) ?? 0));
  if (none.children.length) out.push(none);
  out.forEach(sortTree);
  return out;
}

export interface FlatRow {
  node: TreeNode;
  depth: number;
  open: boolean;
}

/** Flattens the tree for rendering; with a filter, keeps matching scratches and their folders, all expanded. */
export function flattenTree(roots: FolderNode[], collapsed: ReadonlySet<string>, filter = ''): FlatRow[] {
  const f = filter.trim().toLowerCase();
  const matches = (s: ScratchInfo) => !f || s.name.toLowerCase().includes(f) || (s.preview ?? '').toLowerCase().includes(f);
  const out: FlatRow[] = [];
  const walk = (n: TreeNode, depth: number): boolean => {
    if (n.kind === 'file') {
      if (!matches(n.scratch)) return false;
      out.push({ node: n, depth, open: false });
      return true;
    }
    const at = out.length;
    const open = !!f || !collapsed.has(n.key);
    out.push({ node: n, depth, open });
    let any = false;
    if (open) for (const c of n.children) any = walk(c, depth + 1) || any;
    else any = !f;
    if (f && !any) out.length = at; // nothing matches below: hide the folder
    return any || !f;
  };
  roots.forEach((r) => walk(r, 0));
  return out;
}
