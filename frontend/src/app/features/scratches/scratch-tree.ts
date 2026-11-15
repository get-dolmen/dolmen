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
  currentDatabase: (connectionId: string) => string | undefined;
}

/** Label of a connection's own database: engines without a database level show their schema / service / file. */
export function ownDatabaseLabel(connection: ConnectionView, currentDatabase?: string): string {
  if (currentDatabase) return currentDatabase;
  if (connection.kind === 'sqlite') return connection.filePath?.split(/[\\/]/).pop() || 'main';
  return connection.database || (connection.kind === 'postgres' ? 'postgres' : 'default');
}

const byLabel = (first: { label: string }, second: { label: string }) =>
  first.label.localeCompare(second.label, undefined, { sensitivity: 'base' });

/** An empty folder node, filled in by the caller. */
function emptyFolder(key: string, level: FolderNode['level'], label: string): FolderNode {
  return {
    kind: 'folder', key, level, label, connId: '', database: '', schema: '', table: '', children: [], count: 0,
  };
}

/**
 * Groups scratches into connection → database → table folders. Scratches
 * without a table sit directly in their database folder; scratches whose
 * connection no longer exists go to "No connection".
 */
export function buildScratchTree(scratches: ScratchInfo[], context: TreeContext): FolderNode[] {
  const connectionsById = new Map(context.connections.map((connection) => [connection.id, connection]));
  const roots = new Map<string, FolderNode>();
  const orphansFolder = emptyFolder('none', 'none', 'No connection');

  const childFolder = (parent: FolderNode, key: string, create: () => FolderNode): FolderNode => {
    const existing = parent.children.find((child): child is FolderNode => child.kind === 'folder' && child.key === key);
    if (existing) return existing;
    const created = create();
    parent.children.push(created);
    return created;
  };

  for (const scratch of scratches) {
    const connection = connectionsById.get(scratch.connId);
    if (!connection) {
      orphansFolder.children.push({ kind: 'file', key: `f:${scratch.id}`, scratch });
      orphansFolder.count++;
      continue;
    }
    let connectionFolder = roots.get(connection.id);
    if (!connectionFolder) {
      connectionFolder = {
        ...emptyFolder(`c:${connection.id}`, 'conn', connection.name),
        color: connection.color, connId: connection.id,
      };
      roots.set(connection.id, connectionFolder);
    }
    // The connection's own database may be stored as '' or by name: same folder.
    const currentDatabase = context.currentDatabase(connection.id);
    const isOwnDatabase = !scratch.database || scratch.database === currentDatabase;
    const databaseLabel = isOwnDatabase
      ? ownDatabaseLabel(connection, currentDatabase)
      : scratch.database!;
    const databaseFolder = childFolder(connectionFolder, `d:${connection.id}:${databaseLabel}`, () => ({
      ...emptyFolder(`d:${connection.id}:${databaseLabel}`, 'db', databaseLabel),
      connId: connection.id,
      database: isOwnDatabase ? '' : scratch.database!,
    }));
    let parentFolder = databaseFolder;
    if (scratch.table) {
      const tableKey = `t:${databaseFolder.key}:${scratch.schema ?? ''}.${scratch.table}`;
      parentFolder = childFolder(databaseFolder, tableKey, () => ({
        ...emptyFolder(tableKey, 'table', scratch.table!),
        detail: scratch.schema || undefined,
        connId: connection.id,
        database: databaseFolder.database,
        schema: scratch.schema ?? '',
        table: scratch.table!,
      }));
      parentFolder.count++;
    }
    parentFolder.children.push({ kind: 'file', key: `f:${scratch.id}`, scratch });
    databaseFolder.count++;
    connectionFolder.count++;
  }

  const sortTree = (folder: FolderNode) => {
    const folders = folder.children.filter((child): child is FolderNode => child.kind === 'folder').sort(byLabel);
    const files = folder.children
      .filter((child): child is FileNode => child.kind === 'file')
      .sort((first, second) => first.scratch.name.localeCompare(
        second.scratch.name, undefined, { numeric: true, sensitivity: 'base' },
      ));
    folders.forEach(sortTree);
    folder.children = [...folders, ...files];
  };
  // Connections keep the explorer's order.
  const connectionOrder = new Map(context.connections.map((connection, index) => [connection.id, index]));
  const sortedRoots = [...roots.values()].sort(
    (first, second) => (connectionOrder.get(first.connId) ?? 0) - (connectionOrder.get(second.connId) ?? 0),
  );
  if (orphansFolder.children.length) sortedRoots.push(orphansFolder);
  sortedRoots.forEach(sortTree);
  return sortedRoots;
}

export interface FlatRow {
  node: TreeNode;
  depth: number;
  open: boolean;
}

/** Flattens the tree for rendering; with a filter, keeps matching scratches and their folders, all expanded. */
export function flattenTree(
  roots: FolderNode[],
  collapsedKeys: ReadonlySet<string>,
  filter = '',
): FlatRow[] {
  const searchText = filter.trim().toLowerCase();
  const matchesFilter = (scratch: ScratchInfo) => !searchText
    || scratch.name.toLowerCase().includes(searchText)
    || (scratch.preview ?? '').toLowerCase().includes(searchText);
  const rows: FlatRow[] = [];
  const walk = (node: TreeNode, depth: number): boolean => {
    if (node.kind === 'file') {
      if (!matchesFilter(node.scratch)) return false;
      rows.push({ node, depth, open: false });
      return true;
    }
    const rowStart = rows.length;
    const open = !!searchText || !collapsedKeys.has(node.key);
    rows.push({ node, depth, open });
    let anyMatch = false;
    if (open) {
      for (const child of node.children) anyMatch = walk(child, depth + 1) || anyMatch;
    } else {
      anyMatch = !searchText;
    }
    if (searchText && !anyMatch) rows.length = rowStart; // nothing matches below: hide the folder
    return anyMatch || !searchText;
  };
  roots.forEach((root) => walk(root, 0));
  return rows;
}
