import { Injectable, signal } from '@angular/core';

export interface Toast { id: number; text: string; kind: 'info' | 'error' | 'success'; }

@Injectable({ providedIn: 'root' })
export class Toasts {
  readonly items = signal<Toast[]>([]);
  private seq = 0;

  show(text: string, kind: Toast['kind'] = 'info', ms = 4000) {
    const id = ++this.seq;
    this.items.update((t) => [...t, { id, text, kind }]);
    setTimeout(() => this.dismiss(id), kind === 'error' ? Math.max(ms, 7000) : ms);
  }
  error(text: string) { this.show(text, 'error'); }
  success(text: string) { this.show(text, 'success'); }
  dismiss(id: number) { this.items.update((t) => t.filter((x) => x.id !== id)); }
}
