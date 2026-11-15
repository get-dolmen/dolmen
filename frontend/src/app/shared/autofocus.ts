import { Directive, ElementRef, afterNextRender, inject } from '@angular/core';

/** Focuses (and selects) an input once it is rendered. */
@Directive({ selector: 'input[dmAutofocus]' })
export class Autofocus {
  public constructor() {
    const el = inject<ElementRef<HTMLInputElement>>(ElementRef).nativeElement;
    afterNextRender(() => {
      el.focus();
      el.select();
    });
  }
}
