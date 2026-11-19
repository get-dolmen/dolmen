import { Component, computed, input } from '@angular/core';

/** 16×16 stroke icons drawn for Dolmen (currentColor, 1.4px strokes). */
const PATHS: Record<string, string> = {
  refresh: 'M13 8a5 5 0 1 1-1.6-3.7M13 2.5v3h-3',
  plus: 'M8 3v10M3 8h10',
  minus: 'M3 8h10',
  undo: 'M5.5 4 2.5 7l3 3M2.5 7H10a3.5 3.5 0 0 1 0 7H8',
  eye: 'M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8ZM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z',
  submit: 'M8 13V3.5M4 7l4-4 4 4',
  null: 'M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11ZM4 12 12 4',
  search: 'M7 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10ZM10.7 10.7 14 14',
  copy: 'M5.5 5.5h7v8h-7zM3.5 10.5v-8h7',
  left: 'M10 3.5 5.5 8l4.5 4.5',
  right: 'M6 3.5 10.5 8 6 12.5',
  chevron: 'M4 6.5 8 10.5 12 6.5',
  clock: 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM8 4.5V8l2.5 1.5',
  filter: 'M2 3h12l-4.5 5.5V13l-3-1.5v-3Z',
  sort: 'M3 4h10M3 8h7M3 12h4',
  key: 'M10 9.5a3.5 3.5 0 1 0-3.4-2.7L2 11.4V14h2.6v-1.5h1.5V11h1.5l1-1a3.5 3.5 0 0 0 1.4.5ZM10.8 5.2h.01',
  table: 'M2 3h12v10H2zM2 6.5h12M2 10h12M6.5 6.5V13',
  diagram:
    'M2.5 2.5h3.5v3H2.5zM10 2.5h3.5v3H10zM6.25 10.5H9.75v3H6.25zM4.25 5.5v2.5h7.5V5.5M8 8v2.5',
  column: 'M3 2.5h10v11H3zM3 6h10',
  x: 'M4 4l8 8M12 4l-8 8',
  arrowUp: 'M8 13V3M4.5 6.5 8 3l3.5 3.5',
  arrowDown: 'M8 3v10M4.5 9.5 8 13l3.5-3.5',
  file: 'M4 1.5h5L12.5 5v9.5h-8.5zM9 1.5V5h3.5M6 8.5h4.5M6 11h4.5',
  folderOpen: 'M1.5 13V3.5h4l1.5 1.5h6v2M1.5 13l2-5.5h11L12.5 13z',
  folder: 'M1.5 13V3.5h4L7 5h7.5v8z',
  pencil: 'M10.5 2.5l3 3L5 14H2v-3zM9 4l3 3',
  trash: 'M2.5 4.5h11M6 4.5V2.5h4v2M4 4.5l.7 9h6.6l.7-9',
  download: 'M8 2v8.5M4.5 7 8 10.5 11.5 7M2.5 13.5h11',
  settings:
    'M6.54 3.22L6.74 1.52L9.26 1.52L9.46 3.22A5.0 5.0 0 0 1 10.35 3.59L11.69 2.53L13.47 4.31L12.41 5.65A5.0 5.0 0 0 1 12.78 6.54L14.48 6.74L14.48 9.26L12.78 9.46A5.0 5.0 0 0 1 12.41 10.35L13.47 11.69L11.69 13.47L10.35 12.41A5.0 5.0 0 0 1 9.46 12.78L9.26 14.48L6.74 14.48L6.54 12.78A5.0 5.0 0 0 1 5.65 12.41L4.31 13.47L2.53 11.69L3.59 10.35A5.0 5.0 0 0 1 3.22 9.46L1.52 9.26L1.52 6.74L3.22 6.54A5.0 5.0 0 0 1 3.59 5.65L2.53 4.31L4.31 2.53L5.65 3.59A5.0 5.0 0 0 1 6.54 3.22ZM8 10.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4Z',
  panelLeft:
    'M3.5 2.5h9A1.5 1.5 0 0 1 14 4v8a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12V4a1.5 1.5 0 0 1 1.5-1.5ZM6 2.5v11',
  panelRight:
    'M3.5 2.5h9A1.5 1.5 0 0 1 14 4v8a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12V4a1.5 1.5 0 0 1 1.5-1.5ZM10 2.5v11',
  panelBottom:
    'M3.5 2.5h9A1.5 1.5 0 0 1 14 4v8a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12V4a1.5 1.5 0 0 1 1.5-1.5ZM2 9.5h12',
  lock: 'M4.5 7V5.5a3.5 3.5 0 0 1 7 0V7M3 7h10v6.5H3z',
  unlock: 'M4.5 7V5.5a3.5 3.5 0 0 1 6.7-1.4M3 7h10v6.5H3z',
};

@Component({
  selector: 'dm-icon',
  template: `
    <svg
      [attr.width]="size()"
      [attr.height]="size()"
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      <path
        [attr.d]="path()"
        fill="none"
        stroke="currentColor"
        stroke-width="1.4"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  `,
  styles: `
    :host {
      display: inline-flex;
      flex: none;
    }
    svg {
      display: block;
    }
  `,
})
export class Icon {
  public readonly name = input.required<string>();
  public readonly size = input(16);
  public readonly path = computed(() => PATHS[this.name()] ?? '');
}
