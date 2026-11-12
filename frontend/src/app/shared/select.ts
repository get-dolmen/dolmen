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
  template: `
    <button type="button" class="input trigger" role="combobox" aria-haspopup="listbox"
            [attr.aria-label]="label()" [attr.aria-expanded]="open()"
            [attr.aria-controls]="open() ? listId : null"
            [attr.aria-activedescendant]="open() ? listId + '-' + focus() : null"
            [disabled]="disabled()" (click)="toggle()" (keydown)="onKey($event)">
      <span class="text" [class.faint]="!current()">{{ current()?.label ?? placeholder() }}</span>
      <dm-icon name="chevron" [size]="14" />
    </button>
    @if (open()) {
      <div class="menu" role="listbox" [id]="listId" [attr.aria-label]="label()"
           [style.left.px]="pos().x" [style.top.px]="pos().y" [style.width.px]="width()">
        @for (o of options(); track o.value; let i = $index) {
          <button type="button" class="menu-item" role="option" [id]="listId + '-' + i"
                  [attr.aria-selected]="o.value === value()" [class.sel]="o.value === value()"
                  [class.focus]="i === focus()" (mouseenter)="focus.set(i)" (click)="choose(o)">
            <span class="text">{{ o.label }}</span>
            @if (o.value === value()) { <span class="check">✓</span> }
          </button>
        }
      </div>
    }
  `,
  styles: `
    :host { display: block; min-width: 0; }
    .trigger { display: flex; align-items: center; gap: 6px; text-align: left; cursor: pointer; }
    .trigger:disabled { opacity: 0.55; cursor: default; }
    .text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .text.faint { color: var(--text-faint); }
    .trigger dm-icon { color: var(--text-faint); transition: transform 0.12s ease; }
    .trigger[aria-expanded='true'] dm-icon { transform: rotate(180deg); }
    .menu { position: fixed; min-width: 0; max-height: 220px; overflow: auto; }
    .menu-item.sel { font-weight: 600; }
    .menu-item.focus { background: var(--accent-soft); }
    .check { color: var(--accent); }
  `,
  host: {
    '(document:mousedown)': 'onOutside($event)',
    '(document:keydown.escape)': 'close()',
  },
})
export class Select {
  readonly options = input<readonly SelectOption[]>([]);
  readonly value = input('');
  readonly label = input('');
  readonly placeholder = input('Choose…');
  readonly disabled = input(false);
  readonly valueChange = output<string>();

  readonly listId = `dm-select-${nextId++}`;
  readonly open = signal(false);
  readonly focus = signal(0);
  readonly pos = signal({ x: 0, y: 0 });
  readonly width = signal(0);
  readonly current = computed(() => this.options().find((o) => o.value === this.value()));

  private el = inject<ElementRef<HTMLElement>>(ElementRef);

  constructor() {
    // A fixed popup cannot follow a scrolling dialog, so close it instead.
    const onScroll = () => this.close();
    window.addEventListener('scroll', onScroll, true);
    inject(DestroyRef).onDestroy(() => window.removeEventListener('scroll', onScroll, true));
  }

  toggle() {
    if (this.open()) this.close();
    else this.show();
  }

  close() {
    this.open.set(false);
  }

  show() {
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

  choose(o: SelectOption) {
    this.close();
    if (o.value !== this.value()) this.valueChange.emit(o.value);
  }

  onKey(e: KeyboardEvent) {
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

  onOutside(e: MouseEvent) {
    if (this.open() && !this.el.nativeElement.contains(e.target as Node)) this.close();
  }
}
