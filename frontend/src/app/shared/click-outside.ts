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

/** Keeps a menu opened at (x, y) inside the viewport. */
export function clampMenu(x: number, y: number, w = 220, h = 260): { x: number; y: number } {
  return {
    x: Math.max(4, Math.min(x, window.innerWidth - w - 4)),
    y: Math.max(4, Math.min(y, window.innerHeight - h - 4)),
  };
}
