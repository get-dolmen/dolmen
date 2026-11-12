import { Injectable, computed, inject, signal } from '@angular/core';
import { Api, errorText } from './api';
import { Toasts } from './toast';
import type { ConnectionConfig, ConnectionFolder, ConnectionView } from './models';

@Injectable({ providedIn: 'root' })
export class ConnectionStore {
  private api = inject(Api);
  private toasts = inject(Toasts);

  readonly connections = signal<ConnectionView[]>([]);
  readonly folders = signal<ConnectionFolder[]>([]);
  /** IDs currently connecting. */
  readonly pending = signal<ReadonlySet<string>>(new Set());
  readonly byId = computed(() => new Map(this.connections().map((c) => [c.id, c])));
  readonly connected = computed(() => this.connections().filter((c) => c.connected));

  /** Called after a connection is opened or closed, so schema caches can reset. */
  private listeners: ((id: string, connected: boolean) => void)[] = [];
  onChange(fn: (id: string, connected: boolean) => void) { this.listeners.push(fn); }

  async refresh() {
    try {
      const [connections, folders] = await Promise.all([this.api.listConnections(), this.api.listFolders()]);
      this.connections.set(connections);
      this.folders.set(folders);
    } catch (e) {
      this.toasts.error(errorText(e));
    }
  }

  get(id: string | undefined) { return id ? this.byId().get(id) : undefined; }

  /** Creates a folder (optionally nested) and returns it. */
  async createFolder(name: string, parentId = ''): Promise<ConnectionFolder | undefined> {
    try {
      const f = await this.api.saveFolder({ id: '', name, parentId });
      this.folders.update((fs) => [...fs, f]);
      return f;
    } catch (e) {
      this.toasts.error(errorText(e));
      return undefined;
    }
  }

  async renameFolder(id: string, name: string): Promise<boolean> {
    const cur = this.folders().find((f) => f.id === id);
    if (!cur || !name.trim()) return false;
    try {
      const saved = await this.api.saveFolder({ ...cur, name: name.trim() });
      this.folders.update((fs) => fs.map((f) => (f.id === id ? saved : f)));
      return true;
    } catch (e) {
      this.toasts.error(errorText(e));
      return false;
    }
  }

  async deleteFolder(id: string) {
    try {
      await this.api.deleteFolder(id);
      await this.refresh();
    } catch (e) {
      this.toasts.error(errorText(e));
    }
  }

  async moveToFolder(connId: string, folderId: string) {
    const cur = this.connections().find((c) => c.id === connId);
    if (!cur || (cur.folderId ?? '') === folderId) return;
    try {
      await this.api.moveConnectionToFolder(connId, folderId);
      this.connections.update((cs) => cs.map((c) => (c.id === connId ? { ...c, folderId: folderId || undefined } : c)));
    } catch (e) {
      this.toasts.error(errorText(e));
    }
  }

  /** Nests a folder inside another one ("" moves it back to the root). */
  async moveFolder(id: string, parentId: string) {
    const cur = this.folders().find((f) => f.id === id);
    if (!cur || (cur.parentId ?? '') === parentId) return;
    try {
      const saved = await this.api.saveFolder({ ...cur, parentId: parentId || undefined });
      this.folders.update((fs) => fs.map((f) => (f.id === id ? saved : f)));
    } catch (e) {
      this.toasts.error(errorText(e));
    }
  }

  async save(cfg: ConnectionConfig): Promise<ConnectionView> {
    const saved = await this.api.saveConnection(cfg);
    await this.refresh();
    this.emit(saved.id, saved.connected);
    return saved;
  }

  async remove(id: string) {
    await this.api.deleteConnection(id);
    await this.refresh();
    this.emit(id, false);
  }

  /** Opens the connection if needed. Returns false (after a toast) on failure. */
  async ensureConnected(id: string): Promise<boolean> {
    const c = this.get(id);
    if (!c) return false;
    if (c.connected) return true;
    return this.connect(id);
  }

  async connect(id: string): Promise<boolean> {
    if (this.pending().has(id)) return false;
    this.setPending(id, true);
    try {
      await this.api.connect(id);
      this.patch(id, { connected: true });
      this.emit(id, true);
      return true;
    } catch (e) {
      this.toasts.error(`${this.get(id)?.name ?? 'Connection'}: ${errorText(e)}`);
      return false;
    } finally {
      this.setPending(id, false);
    }
  }

  async disconnect(id: string) {
    await this.api.disconnect(id);
    this.patch(id, { connected: false });
    this.emit(id, false);
  }

  private patch(id: string, p: Partial<ConnectionView>) {
    this.connections.update((cs) => cs.map((c) => (c.id === id ? { ...c, ...p } : c)));
  }

  private setPending(id: string, on: boolean) {
    const s = new Set(this.pending());
    if (on) s.add(id); else s.delete(id);
    this.pending.set(s);
  }

  private emit(id: string, connected: boolean) {
    for (const l of this.listeners) l(id, connected);
  }
}
