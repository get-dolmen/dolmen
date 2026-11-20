import { Component, Injectable, inject, signal } from '@angular/core';
import { DIALOG_DATA, Dialog, DialogRef } from '@angular/cdk/dialog';
import { Autofocus } from './autofocus';

export interface PromptOptions {
  title: string;
  label: string;
  value?: string;
  placeholder?: string;
  confirmLabel?: string;
  /** Adds a second action beside the main one (e.g. open a script). */
  secondaryLabel?: string;
}

export type PromptAction = 'primary' | 'secondary';

export interface PromptResult {
  value: string;
  action: PromptAction;
}

/** Asks for one line of text (a name). Native prompt() does not work in Wails' macOS web view. */
@Component({
  selector: 'dm-prompt-dialog',
  imports: [Autofocus],
  templateUrl: './prompt.html',
  styles: `
    .prompt {
      width: 100%;
    }
    .field {
      display: flex;
      flex-direction: column;
      gap: 6px;
      font-size: var(--fs-sm);
      color: var(--text-muted);
    }
    .spacer {
      flex: 1;
    }
    .input.invalid,
    .input.invalid:focus {
      border-color: var(--danger);
      box-shadow: 0 0 0 2px var(--danger-soft);
    }
  `,
})
export class PromptDialog {
  public readonly dialogRef = inject<DialogRef<PromptResult | null>>(DialogRef);
  public readonly options = inject<PromptOptions>(DIALOG_DATA);
  /** Set when an action is chosen with an empty value. */
  public readonly invalid = signal(false);

  public submit(value: string, action: PromptAction = 'primary') {
    const text = value.trim();
    if (!text) {
      this.invalid.set(true);
      return;
    }
    this.dialogRef.close({ value: text, action });
  }

  public clearInvalid() {
    this.invalid.set(false);
  }
}

@Injectable({ providedIn: 'root' })
export class Prompt {
  private dialog = inject(Dialog);

  /** Resolves with the trimmed text, or null when cancelled. */
  public async ask(options: PromptOptions): Promise<string | null> {
    const result = await this.open(options);
    return result?.value ?? null;
  }

  /** Resolves with the trimmed text and which action was chosen, or null when cancelled. */
  public open(options: PromptOptions): Promise<PromptResult | null> {
    const dialogRef = this.dialog.open<PromptResult | null, PromptOptions>(PromptDialog, {
      data: options,
      width: '420px',
      maxWidth: '92vw',
    });
    return new Promise((resolve) =>
      dialogRef.closed.subscribe((result) => resolve(result ?? null)),
    );
  }
}
