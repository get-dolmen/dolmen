import { Injectable, signal } from '@angular/core';

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error' | 'success';
}

@Injectable({ providedIn: 'root' })
export class Toasts {
  public readonly items = signal<Toast[]>([]);
  private sequence = 0;

  public show(text: string, kind: Toast['kind'] = 'info', durationMilliseconds = 4000) {
    const id = ++this.sequence;
    this.items.update((toasts) => [...toasts, { id, text, kind }]);
    setTimeout(
      () => this.dismiss(id),
      kind === 'error' ? Math.max(durationMilliseconds, 7000) : durationMilliseconds,
    );
  }
  public error(text: string) {
    this.show(text, 'error');
  }
  public success(text: string) {
    this.show(text, 'success');
  }
  public dismiss(id: number) {
    this.items.update((toasts) => toasts.filter((toast) => toast.id !== id));
  }
}
