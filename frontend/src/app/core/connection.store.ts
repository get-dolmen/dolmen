import { Injectable, computed, inject, signal } from '@angular/core';
import { Api, errorText } from './api';
import { Toasts } from './toast';
import type { ConnectionConfig, ConnectionFolder, ConnectionView } from './models';

@Injectable({ providedIn: 'root' })
export class ConnectionStore {
  private api = inject(Api);
  private toastService = inject(Toasts);

  public readonly connections = signal<ConnectionView[]>([]);
  public readonly folders = signal<ConnectionFolder[]>([]);
  /** IDs currently connecting. */
  public readonly pending = signal<ReadonlySet<string>>(new Set());
  public readonly byId = computed(
    () => new Map(this.connections().map((connection) => [connection.id, connection])),
  );
  public readonly connected = computed(() =>
    this.connections().filter((connection) => connection.connected),
  );

  /** Called after a connection is opened or closed, so schema caches can reset. */
  private listeners: ((id: string, connected: boolean) => void)[] = [];
  public onChange(listener: (id: string, connected: boolean) => void) {
    this.listeners.push(listener);
  }

  public async refresh() {
    try {
      const [connections, folders] = await Promise.all([
        this.api.listConnections(),
        this.api.listFolders(),
      ]);
      this.connections.set(connections);
      this.folders.set(folders);
    } catch (error) {
      this.toastService.error(errorText(error));
    }
  }

  public get(id: string | undefined) {
    return id ? this.byId().get(id) : undefined;
  }

  /** Creates a folder (optionally nested) and returns it. */
  public async createFolder(name: string, parentId = ''): Promise<ConnectionFolder | undefined> {
    try {
      const folder = await this.api.saveFolder({ id: '', name, parentId });
      this.folders.update((folders) => [...folders, folder]);
      return folder;
    } catch (error) {
      this.toastService.error(errorText(error));
      return undefined;
    }
  }

  public async renameFolder(id: string, name: string): Promise<boolean> {
    const current = this.folders().find((folder) => folder.id === id);
    if (!current || !name.trim()) return false;
    try {
      const saved = await this.api.saveFolder({ ...current, name: name.trim() });
      this.folders.update((folders) =>
        folders.map((folder) => (folder.id === id ? saved : folder)),
      );
      return true;
    } catch (error) {
      this.toastService.error(errorText(error));
      return false;
    }
  }

  public async deleteFolder(id: string) {
    try {
      await this.api.deleteFolder(id);
      await this.refresh();
    } catch (error) {
      this.toastService.error(errorText(error));
    }
  }

  public async moveToFolder(connectionId: string, folderId: string) {
    const current = this.connections().find((connection) => connection.id === connectionId);
    if (!current || (current.folderId ?? '') === folderId) return;
    try {
      await this.api.moveConnectionToFolder(connectionId, folderId);
      this.connections.update((connections) =>
        connections.map((connection) =>
          connection.id === connectionId
            ? { ...connection, folderId: folderId || undefined }
            : connection,
        ),
      );
    } catch (error) {
      this.toastService.error(errorText(error));
    }
  }

  /** Nests a folder inside another one ("" moves it back to the root). */
  public async moveFolder(id: string, parentId: string) {
    const current = this.folders().find((folder) => folder.id === id);
    if (!current || (current.parentId ?? '') === parentId) return;
    try {
      const saved = await this.api.saveFolder({ ...current, parentId: parentId || undefined });
      this.folders.update((folders) =>
        folders.map((folder) => (folder.id === id ? saved : folder)),
      );
    } catch (error) {
      this.toastService.error(errorText(error));
    }
  }

  public async save(config: ConnectionConfig): Promise<ConnectionView> {
    const saved = await this.api.saveConnection(config);
    await this.refresh();
    this.emit(saved.id, saved.connected);
    return saved;
  }

  public async remove(id: string) {
    await this.api.deleteConnection(id);
    await this.refresh();
    this.emit(id, false);
  }

  /** Opens the connection if needed. Returns false (after a toast) on failure. */
  public async ensureConnected(id: string): Promise<boolean> {
    const connection = this.get(id);
    if (!connection) return false;
    if (connection.connected) return true;
    return this.connect(id);
  }

  public async connect(id: string): Promise<boolean> {
    if (this.pending().has(id)) return false;
    this.setPending(id, true);
    try {
      await this.api.connect(id);
      this.patch(id, { connected: true });
      this.emit(id, true);
      return true;
    } catch (error) {
      this.toastService.error(`${this.get(id)?.name ?? 'Connection'}: ${errorText(error)}`);
      return false;
    } finally {
      this.setPending(id, false);
    }
  }

  public async disconnect(id: string) {
    await this.api.disconnect(id);
    this.patch(id, { connected: false });
    this.emit(id, false);
  }

  private patch(id: string, changes: Partial<ConnectionView>) {
    this.connections.update((connections) =>
      connections.map((connection) =>
        connection.id === id ? { ...connection, ...changes } : connection,
      ),
    );
  }

  private setPending(id: string, connecting: boolean) {
    const pending = new Set(this.pending());
    if (connecting) pending.add(id);
    else pending.delete(id);
    this.pending.set(pending);
  }

  private emit(id: string, connected: boolean) {
    for (const listener of this.listeners) listener(id, connected);
  }
}
