import { Directive, ElementRef, afterNextRender, inject } from '@angular/core';

/** Focuses (and selects) an input once it is rendered. */
@Directive({ selector: 'input[dmAutofocus]' })
export class Autofocus {
  public constructor() {
    const element = inject<ElementRef<HTMLInputElement>>(ElementRef).nativeElement;
    afterNextRender(() => {
      element.focus();
      element.select();
    });
  }
}
