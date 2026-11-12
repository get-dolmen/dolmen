import { Component, computed, inject, signal } from '@angular/core';
import { Commands } from '../../core/commands';
import { ConnectionStore } from '../../core/connection.store';
import { RunStore } from '../../core/run.store';
import { TxStore } from '../../core/tx.store';
import { TabStore } from '../../core/tab.store';
import { Ui, MOD, isMac } from '../../core/ui';
import { ClickOutside, clampMenu } from '../../shared/click-outside';
import { Icon } from '../../shared/icon';
import { KIND_LABELS, type ConnectionView } from '../../core/models';

@Component({
  selector: 'dm-topbar',
  imports: [ClickOutside, Icon],
  host: { '[class.mac]': 'mac' },
  template: `
    <div class="left">
    <div class="brand" aria-hidden="true">
      <svg class="mark" width="22" height="16" viewBox="0 0 22 16" aria-hidden="true">
        <path d="M1.6 4.6 C1.4 3.6 2.2 3 3.4 2.9 L18.6 1.9 C19.8 1.8 20.6 2.4 20.5 3.4 L20.3 4.9 C20.2 5.7 19.6 6.1 18.7 6.2 L3.2 6.9 C2.3 6.9 1.8 6.5 1.7 5.7 Z" fill="currentColor"/>
        <path d="M4.2 8.1 L7.6 7.9 L8 15 L3.8 15 Z" fill="currentColor" opacity=".78"/>
        <path d="M14.2 7.5 L17.7 7.3 L18.3 15 L14 15 Z" fill="currentColor" opacity=".78"/>
        <path d="M1 15.4 H21" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" opacity=".45"/>
      </svg>
      Dolmen
    </div>

    <button class="conn nodrag" (click)="openMenu($event)" title="Connection used by this tab">
      @if (conn(); as c) {
        <span class="dot" [style.background]="c.color" [class.off]="!c.connected"></span>
        <span class="ellipsis">{{ c.name }}</span>
        @if (database(); as db) { <span class="db ellipsis">/ {{ db }}</span> }
        @if (c.readOnly) { <span class="badge ro">🔒 RO</span> }
      } @else {
        <span class="faint">No connection</span>
      }
      <span class="caret">▾</span>
    </button>
    </div>

    <button class="search nodrag" (click)="ui.openPalette()">
      <span class="glass" aria-hidden="true">⌕</span>
      <span class="ph">Search tables, tabs, commands…</span>
      <span class="kbd">{{ mod }}P</span>
    </button>

    <div class="actions nodrag">
      @if (tab(); as t) {
        @if (!conn()?.readOnly) {
          <button class="txmode" (click)="openTxMenu($event)" [class.manual]="t.txMode === 'manual'"
                  title="Transaction mode for this tab">Tx: {{ t.txMode === 'manual' ? 'Manual' : 'Auto' }} <span class="caret">▾</span></button>
          @if (txState().open) {
            <span class="txopen" [title]="'Transaction open since ' + since()">
              <span class="pulse"></span>{{ txState().statements }}
            </span>
            <button class="btn sm" (click)="tx.commit()" title="Commit the transaction">✓ Commit</button>
            <button class="btn sm" (click)="tx.rollback()" title="Roll back the transaction">↶ Rollback</button>
          }
          <span class="vsep"></span>
        }
      }
      @if (running()) {
        <button class="btn danger" (click)="cmds.cancel()" title="Cancel (Esc)">■ Stop</button>
      } @else {
        <button class="btn primary run" (click)="cmds.run()" [title]="'Run statement at cursor (' + mod + '↵)'">▶ Run</button>
        <button class="btn" (click)="cmds.runAll()" [title]="'Run whole script (' + mod + '⇧↵)'">Run all</button>
      }
      <button class="btn ghost icon" (click)="ui.sidebarOpen.set(!ui.sidebarOpen())" [class.on]="ui.sidebarOpen()"
              [title]="'Toggle explorer (' + mod + 'B)'" aria-label="Toggle explorer">
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="none" stroke="currentColor"/><rect x="10" y="3" width="4" height="10" fill="currentColor" opacity=".5"/></svg>
      </button>
      <button class="btn ghost icon" (click)="cmds.openSettings()" [title]="'Settings (' + mod + ',)'" aria-label="Settings">
        <dm-icon name="settings" [size]="16" />
      </button>
    </div>

    @if (txMenu(); as m) {
      <div class="menu txmenu" [style.left.px]="m.x" [style.top.px]="m.y" (dmClickOutside)="txMenu.set(null)">
        <button class="menu-item" [class.active]="tab()?.txMode !== 'manual'" (click)="setMode('auto')" [disabled]="txState().open">
          <span><b>Auto-commit</b><small>Each statement is committed immediately.</small></span>
        </button>
        <button class="menu-item" [class.active]="tab()?.txMode === 'manual'" (click)="setMode('manual')" [disabled]="txState().open">
          <span><b>Manual</b><small>Changes stay in a transaction until you commit or roll back.</small></span>
        </button>
        @if (txState().open) { <div class="menu-label">Commit or roll back to switch</div> }
      </div>
    }

    @if (menu(); as m) {
      <div class="menu" [style.left.px]="m.x" [style.top.px]="m.y" (dmClickOutside)="menu.set(null)">
        <div class="menu-label">Use in this tab</div>
        @for (c of conns.connections(); track c.id) {
          <button class="menu-item" [class.active]="c.id === conn()?.id" (click)="choose(c)">
            <span class="dot" [style.background]="c.color" [style.opacity]="c.connected ? 1 : 0.35"></span>
            <span class="ellipsis">{{ c.name }}</span>
            @if (c.readOnly) { <span class="badge ro">RO</span> }
            <span class="hint">{{ kind(c) }}</span>
          </button>
        } @empty {
          <div class="menu-label">No saved connections</div>
        }
        <div class="menu-sep"></div>
        <button class="menu-item" (click)="menu.set(null); cmds.newConnection()">New connection…</button>
        @if (conn(); as c) {
          <button class="menu-item" (click)="menu.set(null); cmds.editConnection(c)">Edit “{{ c.name }}”…</button>
        }
      </div>
    }
  `,
  styles: `
    /* Three columns with equal sides keep the search bar centred in the window. */
    :host { display: grid; grid-template-columns: minmax(max-content, 1fr) minmax(180px, 440px) minmax(max-content, 1fr); align-items: center; gap: 12px; height: 44px; padding: 0 10px; background: var(--bg); border-bottom: 1px solid var(--border);
            --wails-draggable: drag; flex: none; }
    /* Room for the macOS traffic lights, inside the left column so the centre stays centred. */
    :host(.mac) { height: 52px; }
    :host(.mac) .left { padding-left: 80px; }
    .nodrag { --wails-draggable: no-drag; }
    .left { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .brand { display: flex; align-items: center; gap: 7px; font-weight: 700; letter-spacing: 0.01em; color: var(--text-muted); margin-right: 4px; flex: none; }
    .mark { color: var(--accent); flex: none; }
    .conn { display: flex; align-items: center; gap: 7px; height: 30px; max-width: 260px; padding: 0 10px; border: 1px solid var(--border-strong); border-radius: var(--radius);
            background: var(--bg-panel); cursor: pointer; font-weight: 500; border-color: var(--accent); }
    .conn:hover { background: var(--accent-soft); }
    .db { color: var(--text-muted); font-weight: 400; }
    .dot.off { opacity: 0.35; }
    .caret { color: var(--text-faint); font-size: 10px; margin-left: 2px; }
    .search { display: flex; align-items: center; gap: 8px; width: 100%; min-width: 0; height: 30px; padding: 0 6px 0 10px; border: 1px solid var(--border); border-radius: var(--radius);
              background: var(--bg-sunken); color: var(--text-faint); cursor: text; text-align: left; }
    .search:hover { border-color: var(--border-strong); }
    .glass { font-size: 15px; }
    .ph { flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    .actions { display: flex; align-items: center; gap: 6px; justify-self: end; }
    .run { min-width: 74px; justify-content: center; }
    .btn.icon.on { color: var(--accent); }
    .menu .badge { margin-left: 2px; }
    .txmode { height: 30px; padding: 0 10px; border: 1px solid var(--border); border-radius: var(--radius); background: none; color: var(--text-muted);
              font-size: var(--fs-sm); font-weight: 600; cursor: pointer; white-space: nowrap; }
    .txmode:hover { background: var(--bg-hover); color: var(--text); }
    .txmode.manual { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 45%, transparent); }
    .txopen { display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 8px; border-radius: 11px; background: var(--warn-soft);
              color: var(--warn); font-size: var(--fs-xs); font-weight: 700; font-variant-numeric: tabular-nums; }
    .pulse { width: 7px; height: 7px; border-radius: 50%; background: var(--warn); animation: pulse 1.6s ease-in-out infinite; }
    @keyframes pulse { 50% { opacity: 0.35; } }
    .vsep { width: 1px; height: 20px; background: var(--border); margin: 0 4px; }
    .txmenu { width: 300px; }
    .txmenu .menu-item { height: auto; padding: 6px 8px; align-items: flex-start; }
    .txmenu .menu-item span { display: flex; flex-direction: column; gap: 1px; }
    .txmenu .menu-item small { color: var(--text-muted); font-size: var(--fs-xs); white-space: normal; }
    .txmenu .menu-item:disabled { opacity: 0.5; cursor: default; }
  `,
})
export class Topbar {
  readonly ui = inject(Ui);
  readonly cmds = inject(Commands);
  readonly conns = inject(ConnectionStore);
  private tabs = inject(TabStore);
  private runs = inject(RunStore);
  readonly tx = inject(TxStore);
  readonly mod = MOD;
  readonly mac = isMac;

  readonly conn = computed(() => this.conns.get(this.tabs.active()?.connId));
  readonly database = computed(() => this.tabs.active()?.database ?? '');
  readonly running = computed(() => {
    const id = this.tabs.activeId();
    return !!this.runs.runs()[id]?.running;
  });
  readonly menu = signal<{ x: number; y: number } | null>(null);
  readonly txMenu = signal<{ x: number; y: number } | null>(null);
  readonly tab = computed(() => this.tabs.active());
  readonly txState = computed(() => this.tx.get(this.tabs.activeId()));
  readonly since = computed(() => new Date(this.txState().startedAt).toLocaleTimeString());

  openTxMenu(e: MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    this.txMenu.set(clampMenu(r.right - 300, r.bottom + 4, 300, 160));
  }

  setMode(mode: 'auto' | 'manual') {
    const t = this.tabs.active();
    if (t && this.tx.setMode(t.id, mode)) this.txMenu.set(null);
  }

  kind(c: ConnectionView) { return KIND_LABELS[c.kind]; }

  openMenu(e: MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    this.menu.set(clampMenu(r.left, r.bottom + 4, 260, 320));
  }

  async choose(c: ConnectionView) {
    this.menu.set(null);
    const t = this.tabs.active();
    if (t && t.connId !== c.id && !(await this.tx.confirmLeave(t.id))) return;
    if (t) this.tabs.setConnection(t.id, c.id);
    void this.conns.ensureConnected(c.id);
  }
}
