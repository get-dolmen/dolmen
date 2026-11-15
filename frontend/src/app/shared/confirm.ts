import { Component, Injectable, inject } from '@angular/core';
import { DIALOG_DATA, Dialog, DialogRef } from '@angular/cdk/dialog';

export interface ConfirmOptions {
  title?: string;
  /** Main question; line breaks are preserved. */
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Draws the confirm button as a destructive action. */
  danger?: boolean;
}

/**
 * Confirmation dialog drawn by the app. Native `confirm()` cannot be used:
 * Wails' macOS web view does not implement JavaScript confirm panels, so it
 * silently returns false and destructive actions never happen.
 */
@Component({
  selector: 'dm-confirm-dialog',
  templateUrl: './confirm.html',
  styles: `
    .confirm { width: 100%; }
    .message { margin: 2px 0 4px; white-space: pre-line; }
    .spacer { flex: 1; }
  `,
})
export class ConfirmDialog {
  readonly ref = inject<DialogRef<boolean>>(DialogRef);
  readonly data = inject<ConfirmOptions>(DIALOG_DATA);
}

@Injectable({ providedIn: 'root' })
export class Confirm {
  private dialog = inject(Dialog);

  /** Opens the dialog and resolves true only when the user confirms. */
  ask(message: string, options: Omit<ConfirmOptions, 'message'> = {}): Promise<boolean> {
    const ref = this.dialog.open<boolean, ConfirmOptions>(ConfirmDialog, {
      data: { ...options, message },
      width: '420px',
      maxWidth: '92vw',
    });
    return new Promise((resolve) => ref.closed.subscribe((confirmed) => resolve(confirmed === true)));
  }
}
