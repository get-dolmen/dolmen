import { describe, expect, it } from 'vitest';
import { rankItems, type PaletteItem } from './palette';

const item = (
  label: string,
  group: PaletteItem['group'] = 'Tables',
  detail?: string,
): PaletteItem => ({ id: label, group, label, detail, run: () => {} });

describe('rankItems', () => {
  const items = [
    item('orders'),
    item('order_items'),
    item('users'),
    item('user_orders'),
    item('New tab', 'Commands'),
  ];

  it('keeps the original order for an empty query', () => {
    expect(rankItems('', items).map((i) => i.label)).toEqual(items.map((i) => i.label));
  });

  it('ranks the best fuzzy matches first', () => {
    const got = rankItems('ordr', items).map((i) => i.label);
    expect(got[0]).toBe('orders');
    expect(got).not.toContain('users');
  });

  it('matches on detail (schema / connection name)', () => {
    const got = rankItems('analytics', [
      item('events', 'Tables', 'prod · analytics'),
      item('users'),
    ]);
    expect(got.map((i) => i.label)).toEqual(['events']);
  });

  it('respects the limit', () => {
    expect(rankItems('o', items, 2)).toHaveLength(2);
  });
});
