import { Component, Injectable, inject } from '@angular/core';
import { DIALOG_DATA, Dialog, DialogRef } from '@angular/cdk/dialog';
import { Autofocus } from './autofocus';

export interface PromptOptions {
  title: string;
  label: string;
  value?: string;
  placeholder?: string;
  confirmLabel?: string;
}

/** Asks for one line of text (a name). Native prompt() does not work in Wails' macOS web view. */
@Component({
  selector: 'dm-prompt-dialog',
  imports: [Autofocus],
  templateUrl: './prompt.html',
  styles: `
    .prompt { width: 100%; }
    .field { display: flex; flex-direction: column; gap: 6px; font-size: var(--fs-sm); color: var(--text-muted); }
    .spacer { flex: 1; }
  `,
})
export class PromptDialog {
  public readonly ref = inject<DialogRef<string | null>>(DialogRef);
  public readonly data = inject<PromptOptions>(DIALOG_DATA);

  public done(value: string) {
    const v = value.trim();
    if (v) this.ref.close(v);
  }
}

@Injectable({ providedIn: 'root' })
export class Prompt {
  private dialog = inject(Dialog);

  /** Resolves with the trimmed text, or null when cancelled. */
  public ask(options: PromptOptions): Promise<string | null> {
    const ref = this.dialog.open<string | null, PromptOptions>(PromptDialog, { data: options, width: '420px', maxWidth: '92vw' });
    return new Promise((resolve) => ref.closed.subscribe((v) => resolve(v ?? null)));
  }
}
