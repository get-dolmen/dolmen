import { Injectable, inject } from '@angular/core';
import { Commands } from './commands';
import { RunStore } from './run.store';
import { TabStore } from './tab.store';
import { Ui, isMac } from './ui';

/**
 * Global shortcuts, registered in the capture phase so they also work while
 * Monaco has focus (Monaco would otherwise take ⌘↵ for "insert line below").
 */
@Injectable({ providedIn: 'root' })
export class Hotkeys {
  private cmds = inject(Commands);
  private ui = inject(Ui);
  private tabs = inject(TabStore);
  private runs = inject(RunStore);

  public install() {
    window.addEventListener('keydown', (e) => this.handle(e), true);
    window.addEventListener('beforeunload', () => this.tabs.flush());
  }

  private handle(event: KeyboardEvent) {
    const mod = isMac ? event.metaKey : event.ctrlKey;
    const key = event.key.toLowerCase();
    let done = true;

    if (mod && !event.altKey && key === 'p') {
      this.ui.paletteOpen() ? this.ui.paletteOpen.set(false) : this.ui.openPalette(event.shiftKey ? '>' : '');
    } else if (this.ui.paletteOpen() || document.querySelector('.cdk-overlay-pane')) {
      return; // let the palette or a dialog handle its own keys
    } else if (mod && key === 'enter') {
      event.shiftKey ? this.cmds.runAll() : this.cmds.run();
    } else if (mod && !event.shiftKey && key === 't') {
      this.cmds.newTab();
    } else if (mod && !event.shiftKey && key === 'w') {
      this.cmds.closeTab();
    } else if (mod && !event.shiftKey && key === 'b') {
      this.ui.sidebarOpen.update((v) => !v);
    } else if (mod && !event.shiftKey && key === 's') {
      this.cmds.save();
    } else if (mod && !event.shiftKey && key === ',') {
      this.cmds.openSettings();
    } else if (event.ctrlKey && key === 'tab') {
      this.tabs.activateRelative(event.shiftKey ? -1 : 1);
    } else if (mod && event.shiftKey && (event.key === ']' || event.key === '[' || event.key === '}' || event.key === '{')) {
      this.tabs.activateRelative(event.key === ']' || event.key === '}' ? 1 : -1);
    } else if (key === 'escape' && this.runs.get(this.tabs.activeId()).running) {
      this.cmds.cancel();
    } else {
      done = false;
    }

    if (done) {
      event.preventDefault();
      event.stopPropagation();
    }
  }
}
