import { Directive, ElementRef, inject, output } from '@angular/core';

/** Emits when the user presses the mouse outside the host or hits Escape; used to close menus. */
@Directive({
  selector: '[dmClickOutside]',
  host: {
    '(document:mousedown)': 'onDown($event)',
    '(document:keydown.escape)': 'dmClickOutside.emit()',
  },
})
export class ClickOutside {
  private el = inject<ElementRef<HTMLElement>>(ElementRef);
  readonly dmClickOutside = output<void>();

  onDown(e: MouseEvent) {
    if (!this.el.nativeElement.contains(e.target as Node)) this.dmClickOutside.emit();
  }
}

export type MenuPos = { x: number; y: number };

/** Keeps a menu opened at (x, y) inside the viewport. */
export function clampMenu(x: number, y: number, w = 220, h = 260): MenuPos {
  return {
    x: Math.max(4, Math.min(x, window.innerWidth - w - 4)),
    y: Math.max(4, Math.min(y, window.innerHeight - h - 4)),
  };
}

/** Places a menu under its trigger, or closes it when it is already open. */
export function toggleMenuAt(current: MenuPos | null, trigger: DOMRect, w = 220, h = 260): MenuPos | null {
  return current ? null : clampMenu(trigger.left, trigger.bottom + 4, w, h);
}
