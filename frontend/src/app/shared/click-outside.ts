import { Directive, ElementRef, inject, output } from '@angular/core';

/** Emits when the user presses the mouse outside the host or hits Escape; used to close menus. */
@Directive({
  selector: '[dmClickOutside]',
  host: {
    '(document:mousedown)': 'onMouseDown($event)',
    '(document:keydown.escape)': 'dmClickOutside.emit()',
  },
})
export class ClickOutside {
  private elementRef = inject<ElementRef<HTMLElement>>(ElementRef);
  public readonly dmClickOutside = output<void>();

  public onMouseDown(event: MouseEvent) {
    if (!this.elementRef.nativeElement.contains(event.target as Node)) this.dmClickOutside.emit();
  }
}

export type MenuPos = { x: number; y: number };

/** Keeps a menu opened at (x, y) inside the viewport. */
export function clampMenu(x: number, y: number, width = 220, height = 260): MenuPos {
  return {
    x: Math.max(4, Math.min(x, window.innerWidth - width - 4)),
    y: Math.max(4, Math.min(y, window.innerHeight - height - 4)),
  };
}

/** Places a menu at the bottom-right corner of its trigger, inside the viewport. */
export function clampMenuRight(trigger: DOMRect, width = 220, height = 260): MenuPos {
  return clampMenu(trigger.right - width, trigger.bottom + 4, width, height);
}

/** Places a menu under its trigger, or closes it when it is already open. */
export function toggleMenuAt(
  current: MenuPos | null,
  trigger: DOMRect,
  width = 220,
  height = 260,
): MenuPos | null {
  return current ? null : clampMenu(trigger.left, trigger.bottom + 4, width, height);
}
