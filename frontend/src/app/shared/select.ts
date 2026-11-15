import { Component, DestroyRef, ElementRef, computed, inject, input, output, signal } from '@angular/core';
import { clampMenu } from './click-outside';
import { Icon } from './icon';

export interface SelectOption {
  value: string;
  label: string;
}

let nextId = 0;

/**
 * A select drawn by the app instead of the OS, so it matches the menus and
 * the rest of the interface. The popup is fixed-positioned to escape the
 * scrolling dialog body, and the trigger keeps focus for keyboard use.
 */
@Component({
  selector: 'dm-select',
  imports: [Icon],
  templateUrl: './select.html',
  styleUrl: './select.scss',
  host: {
    '(document:mousedown)': 'onOutside($event)',
    '(document:keydown.escape)': 'close()',
  },
})
export class Select {
  public readonly options = input<readonly SelectOption[]>([]);
  public readonly value = input('');
  public readonly label = input('');
  public readonly placeholder = input('Choose…');
  public readonly disabled = input(false);
  public readonly valueChange = output<string>();

  public readonly listId = `dm-select-${nextId++}`;
  public readonly open = signal(false);
  public readonly focus = signal(0);
  public readonly pos = signal({ x: 0, y: 0 });
  public readonly width = signal(0);
  public readonly current = computed(() => this.options().find((o) => o.value === this.value()));

  private el = inject<ElementRef<HTMLElement>>(ElementRef);

  public constructor() {
    // A fixed popup cannot follow a scrolling dialog, so close it instead.
    const onScroll = () => this.close();
    window.addEventListener('scroll', onScroll, true);
    inject(DestroyRef).onDestroy(() => window.removeEventListener('scroll', onScroll, true));
  }

  public toggle() {
    if (this.open()) this.close();
    else this.show();
  }

  public close() {
    this.open.set(false);
  }

  public show() {
    if (this.disabled()) return;
    const r = this.el.nativeElement.getBoundingClientRect();
    const height = Math.min(220, this.options().length * 26 + 8);
    // Open upwards when the list does not fit below but does above.
    const below = window.innerHeight - r.bottom - 8;
    const y = below >= height || r.top < height ? r.bottom + 4 : r.top - height - 4;
    const width = Math.max(r.width, 190);
    this.width.set(width);
    this.pos.set(clampMenu(r.left, y, width, height));
    this.focus.set(Math.max(0, this.options().findIndex((o) => o.value === this.value())));
    this.open.set(true);
  }

  public choose(o: SelectOption) {
    this.close();
    if (o.value !== this.value()) this.valueChange.emit(o.value);
  }

  public onKey(e: KeyboardEvent) {
    const opts = this.options();
    if (!this.open()) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.show();
      }
      return;
    }
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); this.focus.set(Math.min(opts.length - 1, this.focus() + 1)); break;
      case 'ArrowUp': e.preventDefault(); this.focus.set(Math.max(0, this.focus() - 1)); break;
      case 'Home': e.preventDefault(); this.focus.set(0); break;
      case 'End': e.preventDefault(); this.focus.set(opts.length - 1); break;
      case 'Enter':
      case ' ': {
        e.preventDefault();
        const o = opts[this.focus()];
        if (o) this.choose(o);
        break;
      }
      case 'Escape': e.preventDefault(); this.close(); break;
      case 'Tab': this.close(); break;
    }
  }

  public onOutside(e: MouseEvent) {
    if (this.open() && !this.el.nativeElement.contains(e.target as Node)) this.close();
  }
}
