import { describe, expect, it } from 'vitest';
import { buildScratchTree, flattenTree, ownDatabaseLabel, type FolderNode } from './scratch-tree';
import type { ConnectionView, ScratchInfo } from '../../core/models';

const conn = (id: string, name: string, kind: ConnectionView['kind'], extra: Partial<ConnectionView> = {}): ConnectionView =>
  ({ id, name, kind, readOnly: false, hasPassword: false, hasSSHPassword: false, hasSSHPassphrase: false, connected: true, ...extra });
const scratch = (id: string, name: string, connId: string, database = '', table = '', schema = ''): ScratchInfo =>
  ({ id, name, connId, database, table, schema, createdAt: 0, updatedAt: 0, size: 1 });

const conns = [conn('pg', 'raspberry', 'postgres', { database: 'tabtime' }), conn('lite', 'shop', 'sqlite', { filePath: '/tmp/shop.db' })];
const context = {
  connections: conns,
  currentDatabase: (connectionId: string) => (connectionId === 'pg' ? 'tabtime' : undefined),
};

const labels = (f: FolderNode): unknown =>
  [f.label, f.children.map((c) => (c.kind === 'file' ? c.scratch.name : labels(c)))];

describe('buildScratchTree', () => {
  it('groups by connection, database and table', () => {
    const tree = buildScratchTree([
      scratch('1', 'b.sql', 'pg', '', 'users', 'public'),
      scratch('2', 'a.sql', 'pg', 'tabtime', 'users', 'public'), // own db by name: same folder as ''
      scratch('3', 'adhoc.sql', 'pg'),
      scratch('4', 'other.sql', 'pg', 'blog'),
      scratch('5', 'local.sql', 'lite'),
      scratch('6', 'lost.sql', 'gone'),
    ], context);
    expect(tree.map(labels)).toEqual([
      ['raspberry', [
        ['blog', ['other.sql']],
        ['tabtime', [['users', ['a.sql', 'b.sql']], 'adhoc.sql']],
      ]],
      ['shop', [['shop.db', ['local.sql']]]],
      ['No connection', ['lost.sql']],
    ]);
    const tabtime = tree[0].children[1] as FolderNode;
    expect(tabtime.database).toBe('');
    expect(tabtime.count).toBe(3);
    const users = tabtime.children[0] as FolderNode;
    expect([users.level, users.schema, users.table, users.database]).toEqual(['table', 'public', 'users', '']);
  });

  it('labels engines without a database level', () => {
    expect(ownDatabaseLabel(conns[1])).toBe('shop.db');
    expect(ownDatabaseLabel(conn('m', 'm', 'mysql', { database: 'app' }))).toBe('app');
    expect(ownDatabaseLabel(conn('o', 'o', 'oracle'))).toBe('default');
  });
});

describe('flattenTree', () => {
  const tree = buildScratchTree([scratch('1', 'users.sql', 'pg', '', 'users', 'public'), scratch('2', 'report.sql', 'pg')], context);

  it('honours collapsed folders', () => {
    const rows = flattenTree(tree, new Set(['c:pg']));
    expect(rows.map((r) => r.depth)).toEqual([0]);
  });

  it('filters to matching scratches and their folders', () => {
    const rows = flattenTree(tree, new Set(['c:pg']), 'report');
    expect(rows.map((r) => (r.node.kind === 'file' ? r.node.scratch.name : r.node.label))).toEqual(['raspberry', 'tabtime', 'report.sql']);
  });
});
