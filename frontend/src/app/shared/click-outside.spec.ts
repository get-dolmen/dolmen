import { describe, expect, it } from 'vitest';
import { toggleMenuAt } from './click-outside';

/** The part of a trigger's rect that a menu is anchored to. */
const trigger = (left: number, bottom: number) => ({ left, bottom }) as DOMRect;

describe('toggleMenuAt', () => {
  it('opens the menu just under its trigger', () => {
    expect(toggleMenuAt(null, trigger(40, 44))).toEqual({ x: 40, y: 48 });
  });

  it('closes the menu when it is already open', () => {
    expect(toggleMenuAt({ x: 40, y: 48 }, trigger(40, 44))).toBeNull();
  });

  it('keeps a menu near the edge of the window inside it', () => {
    const pos = toggleMenuAt(null, trigger(window.innerWidth - 10, window.innerHeight - 10), 260, 320);
    expect(pos).toEqual({ x: window.innerWidth - 264, y: window.innerHeight - 324 });
  });
});
