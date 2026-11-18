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
  private commandService = inject(Commands);
  private uiState = inject(Ui);
  private tabStore = inject(TabStore);
  private runStore = inject(RunStore);

  public install() {
    window.addEventListener('keydown', (event) => this.handle(event), true);
    window.addEventListener('beforeunload', () => this.tabStore.flush());
  }

  private handle(event: KeyboardEvent) {
    const modifierPressed = isMac ? event.metaKey : event.ctrlKey;
    const key = event.key.toLowerCase();
    let handled = true;

    if (modifierPressed && !event.altKey && key === 'p') {
      this.uiState.paletteOpen()
        ? this.uiState.paletteOpen.set(false)
        : this.uiState.openPalette(event.shiftKey ? '>' : '');
    } else if (this.uiState.paletteOpen() || document.querySelector('.cdk-overlay-pane')) {
      return; // let the palette or a dialog handle its own keys
    } else if (modifierPressed && key === 'enter') {
      event.shiftKey ? this.commandService.runAll() : this.commandService.run();
    } else if (modifierPressed && !event.shiftKey && key === 't') {
      this.commandService.newTab();
    } else if (modifierPressed && !event.shiftKey && key === 'w') {
      this.commandService.closeTab();
    } else if (modifierPressed && !event.shiftKey && key === 'b') {
      this.uiState.sidebarOpen.update((open) => !open);
    } else if (modifierPressed && !event.shiftKey && key === 's') {
      this.commandService.save();
    } else if (modifierPressed && event.shiftKey && key === 'f') {
      this.commandService.formatSql();
    } else if (modifierPressed && !event.shiftKey && key === ',') {
      this.commandService.openSettings();
    } else if (event.ctrlKey && key === 'tab') {
      this.tabStore.activateRelative(event.shiftKey ? -1 : 1);
    } else if (
      modifierPressed &&
      event.shiftKey &&
      (event.key === ']' || event.key === '[' || event.key === '}' || event.key === '{')
    ) {
      this.tabStore.activateRelative(event.key === ']' || event.key === '}' ? 1 : -1);
    } else if (key === 'escape' && this.runStore.get(this.tabStore.activeId()).running) {
      this.commandService.cancel();
    } else {
      handled = false;
    }

    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  }
}
