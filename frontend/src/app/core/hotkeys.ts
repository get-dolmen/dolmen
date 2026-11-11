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

  install() {
    window.addEventListener('keydown', (e) => this.handle(e), true);
    window.addEventListener('beforeunload', () => this.tabs.flush());
  }

  private handle(e: KeyboardEvent) {
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const key = e.key.toLowerCase();
    let done = true;

    if (mod && !e.altKey && key === 'p') {
      this.ui.paletteOpen() ? this.ui.paletteOpen.set(false) : this.ui.openPalette(e.shiftKey ? '>' : '');
    } else if (this.ui.paletteOpen() || document.querySelector('.cdk-overlay-pane')) {
      return; // let the palette or a dialog handle its own keys
    } else if (mod && key === 'enter') {
      e.shiftKey ? this.cmds.runAll() : this.cmds.run();
    } else if (mod && !e.shiftKey && key === 't') {
      this.cmds.newTab();
    } else if (mod && !e.shiftKey && key === 'w') {
      this.cmds.closeTab();
    } else if (mod && !e.shiftKey && key === 'b') {
      this.ui.sidebarOpen.update((v) => !v);
    } else if (mod && !e.shiftKey && key === 's') {
      this.cmds.save();
    } else if (e.ctrlKey && key === 'tab') {
      this.tabs.activateRelative(e.shiftKey ? -1 : 1);
    } else if (mod && e.shiftKey && (e.key === ']' || e.key === '[' || e.key === '}' || e.key === '{')) {
      this.tabs.activateRelative(e.key === ']' || e.key === '}' ? 1 : -1);
    } else if (key === 'escape' && this.runs.get(this.tabs.activeId()).running) {
      this.cmds.cancel();
    } else {
      done = false;
    }

    if (done) {
      e.preventDefault();
      e.stopPropagation();
    }
  }
}
