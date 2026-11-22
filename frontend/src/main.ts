// Loads the Wails runtime first: it installs the window drag and context-menu
// handlers the native shell relies on.
import '@wailsio/runtime';
import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { applyStoredTheme } from './app/core/ui';

applyStoredTheme();
bootstrapApplication(App, appConfig).catch((err) => console.error(err));
