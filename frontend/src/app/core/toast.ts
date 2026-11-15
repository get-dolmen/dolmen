import { Injectable, signal } from '@angular/core';

export interface Toast { id: number; text: string; kind: 'info' | 'error' | 'success'; }

@Injectable({ providedIn: 'root' })
export class Toasts {
  public readonly items = signal<Toast[]>([]);
  private seq = 0;

  public show(text: string, kind: Toast['kind'] = 'info', ms = 4000) {
    const id = ++this.seq;
    this.items.update((t) => [...t, { id, text, kind }]);
    setTimeout(() => this.dismiss(id), kind === 'error' ? Math.max(ms, 7000) : ms);
  }
  public error(text: string) { this.show(text, 'error'); }
  public success(text: string) { this.show(text, 'success'); }
  public dismiss(id: number) { this.items.update((t) => t.filter((x) => x.id !== id)); }
}
