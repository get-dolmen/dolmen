import { Component, inject } from '@angular/core';
import { DialogRef } from '@angular/cdk/dialog';
import { Ui, type Theme } from '../../core/ui';

/** Application settings. Appearance applies (and persists) as soon as it is picked. */
@Component({
  selector: 'dm-settings-dialog',
  template: `
    <div class="dialog settings">
      <header>
        <h2>Settings</h2>
      </header>
      <div class="body">
        <section class="group">
          <h3>Appearance</h3>
          <div class="field">
            <span class="label">Theme</span>
            <div class="choices" role="radiogroup" aria-label="Theme">
              @for (t of themes; track t.value) {
                <button type="button" class="choice" role="radio" [class.on]="ui.theme() === t.value"
                        [attr.aria-checked]="ui.theme() === t.value" (click)="ui.theme.set(t.value)">
                  <span class="preview" [attr.data-preview]="t.value" aria-hidden="true">
                    <span class="bar"></span><span class="pane"></span>
                  </span>
                  <span class="name">{{ t.label }}</span>
                  <span class="hint">{{ t.hint }}</span>
                </button>
              }
            </div>
          </div>

          <div class="field">
            <span class="label">Scratch files</span>
            <div class="choices two" role="radiogroup" aria-label="Scratch panel position">
              <button type="button" class="choice" role="radio" [class.on]="ui.scratchPosition() === 'explorer'"
                      [attr.aria-checked]="ui.scratchPosition() === 'explorer'" (click)="ui.scratchPosition.set('explorer')">
                <span class="preview dock" aria-hidden="true">
                  <span class="work"><span class="explorer"><span class="scratches"></span></span></span>
                </span>
                <span class="name">Explorer</span>
                <span class="hint">Bottom of the right sidebar</span>
              </button>
              <button type="button" class="choice" role="radio" [class.on]="ui.scratchPosition() === 'left'"
                      [attr.aria-checked]="ui.scratchPosition() === 'left'" (click)="ui.scratchPosition.set('left')">
                <span class="preview dock" aria-hidden="true">
                  <span class="work"><span class="left-dock"></span><span class="main-pane"></span><span class="explorer"></span></span>
                </span>
                <span class="name">Left panel</span>
                <span class="hint">Full-height pane, above the tab bar</span>
              </button>
            </div>
          </div>
        </section>
      </div>
      <footer>
        <span class="spacer"></span>
        <button type="button" class="btn primary" (click)="ref.close()">Done</button>
      </footer>
    </div>
  `,
  styles: `
    .settings { width: 560px; max-width: 94vw; }
    h3 { margin: 2px 0 10px; font-size: var(--fs-xs); font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-muted); }
    .group + .group { margin-top: 20px; padding-top: 18px; border-top: 1px solid var(--border); }
    .field { display: flex; flex-direction: column; gap: 6px; }
    .field > .label { font-size: var(--fs-sm); color: var(--text-muted); }
    .choices { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
    .choices.two { grid-template-columns: repeat(2, 1fr); }
    .field + .field { margin-top: 14px; }
    .choice { display: flex; flex-direction: column; align-items: stretch; gap: 5px; padding: 8px; text-align: left;
              border: 1px solid var(--border-strong); border-radius: var(--radius); background: var(--bg-panel); color: var(--text); cursor: pointer; }
    .choice:hover { background: var(--bg-hover); }
    .choice.on { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); background: var(--accent-soft); }
    .preview { display: flex; height: 44px; overflow: hidden; border: 1px solid var(--border); border-radius: var(--radius-sm); background: #f6f5f2; }
    .preview .bar { width: 28%; background: #eceae5; border-right: 1px solid #dedbd3; }
    .preview .pane { flex: 1; background: #ffffff; }
    .preview[data-preview='dark'] { background: #1b1a18; }
    .preview[data-preview='dark'] .bar { background: #171614; border-color: #34322d; }
    .preview[data-preview='dark'] .pane { background: #22211e; }
    .preview[data-preview='system'] { background: linear-gradient(105deg, #f6f5f2 50%, #1b1a18 50%); }
    .preview[data-preview='system'] .bar { background: transparent; border-right-color: transparent; background-image: linear-gradient(105deg, #eceae5 50%, #171614 50%); }
    .preview[data-preview='system'] .pane { background: linear-gradient(105deg, #ffffff 50%, #22211e 50%); }
    .name { font-weight: 600; }
    .hint { font-size: var(--fs-xs); color: var(--text-faint); line-height: 1.25; }
    .preview.dock { padding: 0; background: var(--bg); }
    .preview.dock .work { display: flex; flex: 1; gap: 3px; padding: 4px; }
    .preview.dock .explorer { display: flex; flex: 0 0 34%; flex-direction: column; justify-content: flex-end; padding: 3px; background: var(--bg-panel); border: 1px solid var(--border); border-radius: 2px; }
    .preview.dock .scratches { height: 40%; background: var(--accent-soft); border: 1px solid var(--accent); border-radius: 1px; }
    .preview.dock .main-pane { flex: 1; background: var(--bg-panel); border: 1px solid var(--border); border-radius: 2px; }
    .preview.dock .left-dock { flex: 0 0 34%; background: var(--accent-soft); border: 1px solid var(--accent); border-radius: 2px; }
  `,
})
export class SettingsDialog {
  readonly ref = inject(DialogRef);
  readonly ui = inject(Ui);

  readonly themes: { value: Theme; label: string; hint: string }[] = [
    { value: 'system', label: 'System', hint: 'Follow the OS' },
    { value: 'light', label: 'Light', hint: 'Stone and white' },
    { value: 'dark', label: 'Dark', hint: 'Low light' },
  ];
}
