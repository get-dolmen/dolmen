import {
  Component,
  DestroyRef,
  ElementRef,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { clampMenu } from './click-outside';
import { Icon } from './icon';

export interface SelectOption {
  value: string;
  label: string;
}

let nextSelectId = 0;

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

  public readonly listId = `dm-select-${nextSelectId++}`;
  public readonly open = signal(false);
  public readonly focus = signal(0);
  public readonly position = signal({ x: 0, y: 0 });
  public readonly width = signal(0);
  public readonly currentOption = computed(() =>
    this.options().find((option) => option.value === this.value()),
  );

  private elementRef = inject<ElementRef<HTMLElement>>(ElementRef);

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
    const bounds = this.elementRef.nativeElement.getBoundingClientRect();
    const height = Math.min(220, this.options().length * 26 + 8);
    // Open upwards when the list does not fit below but does above.
    const spaceBelow = window.innerHeight - bounds.bottom - 8;
    const top =
      spaceBelow >= height || bounds.top < height ? bounds.bottom + 4 : bounds.top - height - 4;
    const width = Math.max(bounds.width, 190);
    this.width.set(width);
    this.position.set(clampMenu(bounds.left, top, width, height));
    this.focus.set(
      Math.max(
        0,
        this.options().findIndex((option) => option.value === this.value()),
      ),
    );
    this.open.set(true);
  }

  public choose(option: SelectOption) {
    this.close();
    if (option.value !== this.value()) this.valueChange.emit(option.value);
  }

  public onKey(event: KeyboardEvent) {
    const options = this.options();
    if (!this.open()) {
      if (
        event.key === 'ArrowDown' ||
        event.key === 'ArrowUp' ||
        event.key === 'Enter' ||
        event.key === ' '
      ) {
        event.preventDefault();
        this.show();
      }
      return;
    }
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.focus.set(Math.min(options.length - 1, this.focus() + 1));
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.focus.set(Math.max(0, this.focus() - 1));
        break;
      case 'Home':
        event.preventDefault();
        this.focus.set(0);
        break;
      case 'End':
        event.preventDefault();
        this.focus.set(options.length - 1);
        break;
      case 'Enter':
      case ' ': {
        event.preventDefault();
        const option = options[this.focus()];
        if (option) this.choose(option);
        break;
      }
      case 'Escape':
        event.preventDefault();
        this.close();
        break;
      case 'Tab':
        this.close();
        break;
    }
  }

  public onOutside(event: MouseEvent) {
    if (this.open() && !this.elementRef.nativeElement.contains(event.target as Node)) this.close();
  }
}
