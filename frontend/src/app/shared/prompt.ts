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
  template: `
    <form class="dialog prompt" role="dialog" aria-modal="true" [attr.aria-label]="data.title"
          (submit)="$event.preventDefault(); done(input.value)">
      <header><h2>{{ data.title }}</h2></header>
      <div class="body">
        <label class="field">{{ data.label }}
          <input #input class="input" [value]="data.value ?? ''" [placeholder]="data.placeholder ?? ''" spellcheck="false" autocomplete="off" dmAutofocus />
        </label>
      </div>
      <footer>
        <span class="spacer"></span>
        <button class="btn" type="button" (click)="ref.close(null)">Cancel</button>
        <button class="btn primary" type="submit">{{ data.confirmLabel || 'OK' }}</button>
      </footer>
    </form>
  `,
  styles: `
    .prompt { width: 100%; }
    .field { display: flex; flex-direction: column; gap: 6px; font-size: var(--fs-sm); color: var(--text-muted); }
    .spacer { flex: 1; }
  `,
})
export class PromptDialog {
  readonly ref = inject<DialogRef<string | null>>(DialogRef);
  readonly data = inject<PromptOptions>(DIALOG_DATA);

  done(value: string) {
    const v = value.trim();
    if (v) this.ref.close(v);
  }
}

@Injectable({ providedIn: 'root' })
export class Prompt {
  private dialog = inject(Dialog);

  /** Resolves with the trimmed text, or null when cancelled. */
  ask(options: PromptOptions): Promise<string | null> {
    const ref = this.dialog.open<string | null, PromptOptions>(PromptDialog, { data: options, width: '420px', maxWidth: '92vw' });
    return new Promise((resolve) => ref.closed.subscribe((v) => resolve(v ?? null)));
  }
}
