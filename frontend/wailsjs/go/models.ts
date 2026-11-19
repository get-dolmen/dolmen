export namespace driver {
  export class Column {
    table: string;
    name: string;
    type: string;
    nullable: boolean;
    pk: boolean;

    static createFrom(source: any = {}) {
      return new Column(source);
    }

    constructor(source: any = {}) {
      if ('string' === typeof source) source = JSON.parse(source);
      this.table = source['table'];
      this.name = source['name'];
      this.type = source['type'];
      this.nullable = source['nullable'];
      this.pk = source['pk'];
    }
  }
  export class Config {
    id: string;
    name: string;
    kind: string;
    host?: string;
    port?: number;
    database?: string;
    user?: string;
    password?: string;
    filePath?: string;
    readOnly: boolean;
    color?: string;
    folderId?: string;
    options?: Record<string, string>;
    ssh?: sshtunnel.Config;
    updatedAt?: number;

    static createFrom(source: any = {}) {
      return new Config(source);
    }

    constructor(source: any = {}) {
      if ('string' === typeof source) source = JSON.parse(source);
      this.id = source['id'];
      this.name = source['name'];
      this.kind = source['kind'];
      this.host = source['host'];
      this.port = source['port'];
      this.database = source['database'];
      this.user = source['user'];
      this.password = source['password'];
      this.filePath = source['filePath'];
      this.readOnly = source['readOnly'];
      this.color = source['color'];
      this.folderId = source['folderId'];
      this.options = source['options'];
      this.ssh = this.convertValues(source['ssh'], sshtunnel.Config);
      this.updatedAt = source['updatedAt'];
    }

    convertValues(a: any, classs: any, asMap: boolean = false): any {
      if (!a) {
        return a;
      }
      if (a.slice && a.map) {
        return (a as any[]).map((elem) => this.convertValues(elem, classs));
      } else if ('object' === typeof a) {
        if (asMap) {
          for (const key of Object.keys(a)) {
            a[key] = new classs(a[key]);
          }
          return a;
        }
        return new classs(a);
      }
      return a;
    }
  }
  export class ForeignKey {
    constraint?: string;
    schema: string;
    table: string;
    column: string;
    refSchema: string;
    refTable: string;
    refColumn: string;

    static createFrom(source: any = {}) {
      return new ForeignKey(source);
    }

    constructor(source: any = {}) {
      if ('string' === typeof source) source = JSON.parse(source);
      this.constraint = source['constraint'];
      this.schema = source['schema'];
      this.table = source['table'];
      this.column = source['column'];
      this.refSchema = source['refSchema'];
      this.refTable = source['refTable'];
      this.refColumn = source['refColumn'];
    }
  }
  export class Table {
    schema: string;
    name: string;
    type: string;

    static createFrom(source: any = {}) {
      return new Table(source);
    }

    constructor(source: any = {}) {
      if ('string' === typeof source) source = JSON.parse(source);
      this.schema = source['schema'];
      this.name = source['name'];
      this.type = source['type'];
    }
  }
}

export namespace folder {
  export class Folder {
    id: string;
    name: string;
    parentId?: string;
    updatedAt?: number;

    static createFrom(source: any = {}) {
      return new Folder(source);
    }

    constructor(source: any = {}) {
      if ('string' === typeof source) source = JSON.parse(source);
      this.id = source['id'];
      this.name = source['name'];
      this.parentId = source['parentId'];
      this.updatedAt = source['updatedAt'];
    }
  }
}

export namespace gitsync {
  export class Config {
    enabled: boolean;
    remote: string;
    branch: string;
    encrypted: boolean;

    static createFrom(source: any = {}) {
      return new Config(source);
    }

    constructor(source: any = {}) {
      if ('string' === typeof source) source = JSON.parse(source);
      this.enabled = source['enabled'];
      this.remote = source['remote'];
      this.branch = source['branch'];
      this.encrypted = source['encrypted'];
    }
  }
  export class Result {
    commit?: string;
    changed: boolean;
    lastSyncAt: number;
    connections: number;
    scratches: number;

    static createFrom(source: any = {}) {
      return new Result(source);
    }

    constructor(source: any = {}) {
      if ('string' === typeof source) source = JSON.parse(source);
      this.commit = source['commit'];
      this.changed = source['changed'];
      this.lastSyncAt = source['lastSyncAt'];
      this.connections = source['connections'];
      this.scratches = source['scratches'];
    }
  }
  export class Status {
    enabled: boolean;
    remote: string;
    branch: string;
    encrypted: boolean;
    dir: string;
    gitAvailable: boolean;
    repoExists: boolean;
    lastCommit?: string;
    lastSyncAt?: number;
    lastError?: string;

    static createFrom(source: any = {}) {
      return new Status(source);
    }

    constructor(source: any = {}) {
      if ('string' === typeof source) source = JSON.parse(source);
      this.enabled = source['enabled'];
      this.remote = source['remote'];
      this.branch = source['branch'];
      this.encrypted = source['encrypted'];
      this.dir = source['dir'];
      this.gitAvailable = source['gitAvailable'];
      this.repoExists = source['repoExists'];
      this.lastCommit = source['lastCommit'];
      this.lastSyncAt = source['lastSyncAt'];
      this.lastError = source['lastError'];
    }
  }
}

export namespace history {
  export class Entry {
    id: number;
    connId: string;
    sql: string;
    startedAt: number;
    durationMs: number;
    rows: number;
    status: string;
    error?: string;

    static createFrom(source: any = {}) {
      return new Entry(source);
    }

    constructor(source: any = {}) {
      if ('string' === typeof source) source = JSON.parse(source);
      this.id = source['id'];
      this.connId = source['connId'];
      this.sql = source['sql'];
      this.startedAt = source['startedAt'];
      this.durationMs = source['durationMs'];
      this.rows = source['rows'];
      this.status = source['status'];
      this.error = source['error'];
    }
  }
}

export namespace main {
  export class ConnectionView {
    id: string;
    name: string;
    kind: string;
    host?: string;
    port?: number;
    database?: string;
    user?: string;
    password?: string;
    filePath?: string;
    readOnly: boolean;
    color?: string;
    folderId?: string;
    options?: Record<string, string>;
    ssh?: sshtunnel.Config;
    updatedAt?: number;
    hasPassword: boolean;
    hasSSHPassword: boolean;
    hasSSHPassphrase: boolean;
    connected: boolean;

    static createFrom(source: any = {}) {
      return new ConnectionView(source);
    }

    constructor(source: any = {}) {
      if ('string' === typeof source) source = JSON.parse(source);
      this.id = source['id'];
      this.name = source['name'];
      this.kind = source['kind'];
      this.host = source['host'];
      this.port = source['port'];
      this.database = source['database'];
      this.user = source['user'];
      this.password = source['password'];
      this.filePath = source['filePath'];
      this.readOnly = source['readOnly'];
      this.color = source['color'];
      this.folderId = source['folderId'];
      this.options = source['options'];
      this.ssh = this.convertValues(source['ssh'], sshtunnel.Config);
      this.updatedAt = source['updatedAt'];
      this.hasPassword = source['hasPassword'];
      this.hasSSHPassword = source['hasSSHPassword'];
      this.hasSSHPassphrase = source['hasSSHPassphrase'];
      this.connected = source['connected'];
    }

    convertValues(a: any, classs: any, asMap: boolean = false): any {
      if (!a) {
        return a;
      }
      if (a.slice && a.map) {
        return (a as any[]).map((elem) => this.convertValues(elem, classs));
      } else if ('object' === typeof a) {
        if (asMap) {
          for (const key of Object.keys(a)) {
            a[key] = new classs(a[key]);
          }
          return a;
        }
        return new classs(a);
      }
      return a;
    }
  }
  export class DatabaseList {
    supported: boolean;
    databases: string[];
    current: string;

    static createFrom(source: any = {}) {
      return new DatabaseList(source);
    }

    constructor(source: any = {}) {
      if ('string' === typeof source) source = JSON.parse(source);
      this.supported = source['supported'];
      this.databases = source['databases'];
      this.current = source['current'];
    }
  }
  export class ExportResult {
    path: string;
    rows: number;

    static createFrom(source: any = {}) {
      return new ExportResult(source);
    }

    constructor(source: any = {}) {
      if ('string' === typeof source) source = JSON.parse(source);
      this.path = source['path'];
      this.rows = source['rows'];
    }
  }
  export class InstallResult {
    version: string;
    relaunch: boolean;
    message?: string;

    static createFrom(source: any = {}) {
      return new InstallResult(source);
    }

    constructor(source: any = {}) {
      if ('string' === typeof source) source = JSON.parse(source);
      this.version = source['version'];
      this.relaunch = source['relaunch'];
      this.message = source['message'];
    }
  }
  export class SchemaList {
    schemas: string[];
    default: string;

    static createFrom(source: any = {}) {
      return new SchemaList(source);
    }

    constructor(source: any = {}) {
      if ('string' === typeof source) source = JSON.parse(source);
      this.schemas = source['schemas'];
      this.default = source['default'];
    }
  }
  export class TableApplyResult {
    result?: tabledata.ApplyResult;
    tx: query.TxStatus;

    static createFrom(source: any = {}) {
      return new TableApplyResult(source);
    }

    constructor(source: any = {}) {
      if ('string' === typeof source) source = JSON.parse(source);
      this.result = this.convertValues(source['result'], tabledata.ApplyResult);
      this.tx = this.convertValues(source['tx'], query.TxStatus);
    }

    convertValues(a: any, classs: any, asMap: boolean = false): any {
      if (!a) {
        return a;
      }
      if (a.slice && a.map) {
        return (a as any[]).map((elem) => this.convertValues(elem, classs));
      } else if ('object' === typeof a) {
        if (asMap) {
          for (const key of Object.keys(a)) {
            a[key] = new classs(a[key]);
          }
          return a;
        }
        return new classs(a);
      }
      return a;
    }
  }
  export class TableCountResult {
    count: number;
    tx: query.TxStatus;

    static createFrom(source: any = {}) {
      return new TableCountResult(source);
    }

    constructor(source: any = {}) {
      if ('string' === typeof source) source = JSON.parse(source);
      this.count = source['count'];
      this.tx = this.convertValues(source['tx'], query.TxStatus);
    }

    convertValues(a: any, classs: any, asMap: boolean = false): any {
      if (!a) {
        return a;
      }
      if (a.slice && a.map) {
        return (a as any[]).map((elem) => this.convertValues(elem, classs));
      } else if ('object' === typeof a) {
        if (asMap) {
          for (const key of Object.keys(a)) {
            a[key] = new classs(a[key]);
          }
          return a;
        }
        return new classs(a);
      }
      return a;
    }
  }
  export class TableReadResult {
    page?: tabledata.Page;
    tx: query.TxStatus;

    static createFrom(source: any = {}) {
      return new TableReadResult(source);
    }

    constructor(source: any = {}) {
      if ('string' === typeof source) source = JSON.parse(source);
      this.page = this.convertValues(source['page'], tabledata.Page);
      this.tx = this.convertValues(source['tx'], query.TxStatus);
    }

    convertValues(a: any, classs: any, asMap: boolean = false): any {
      if (!a) {
        return a;
      }
      if (a.slice && a.map) {
        return (a as any[]).map((elem) => this.convertValues(elem, classs));
      } else if ('object' === typeof a) {
        if (asMap) {
          for (const key of Object.keys(a)) {
            a[key] = new classs(a[key]);
          }
          return a;
        }
        return new classs(a);
      }
      return a;
    }
  }
  export class UpdateAsset {
    name: string;
    size: number;
    url: string;

    static createFrom(source: any = {}) {
      return new UpdateAsset(source);
    }

    constructor(source: any = {}) {
      if ('string' === typeof source) source = JSON.parse(source);
      this.name = source['name'];
      this.size = source['size'];
      this.url = source['url'];
    }
  }
  export class UpdateInfo {
    current: string;
    latest: string;
    newer: boolean;
    url: string;
    notes?: string;
    asset?: UpdateAsset;

    static createFrom(source: any = {}) {
      return new UpdateInfo(source);
    }

    constructor(source: any = {}) {
      if ('string' === typeof source) source = JSON.parse(source);
      this.current = source['current'];
      this.latest = source['latest'];
      this.newer = source['newer'];
      this.url = source['url'];
      this.notes = source['notes'];
      this.asset = this.convertValues(source['asset'], UpdateAsset);
    }

    convertValues(a: any, classs: any, asMap: boolean = false): any {
      if (!a) {
        return a;
      }
      if (a.slice && a.map) {
        return (a as any[]).map((elem) => this.convertValues(elem, classs));
      } else if ('object' === typeof a) {
        if (asMap) {
          for (const key of Object.keys(a)) {
            a[key] = new classs(a[key]);
          }
          return a;
        }
        return new classs(a);
      }
      return a;
    }
  }
  export class VersionInfo {
    version: string;
    repo: string;
    commit: string;

    static createFrom(source: any = {}) {
      return new VersionInfo(source);
    }

    constructor(source: any = {}) {
      if ('string' === typeof source) source = JSON.parse(source);
      this.version = source['version'];
      this.repo = source['repo'];
      this.commit = source['commit'];
    }
  }
}

export namespace mcp {
  export class Config {
    enabled: boolean;
    port: number;
    token: string;
    read: boolean;
    write: boolean;
    databases: string[];
    schemas: string[];

    static createFrom(source: any = {}) {
      return new Config(source);
    }

    constructor(source: any = {}) {
      if ('string' === typeof source) source = JSON.parse(source);
      this.enabled = source['enabled'];
      this.port = source['port'];
      this.token = source['token'];
      this.read = source['read'];
      this.write = source['write'];
      this.databases = source['databases'];
      this.schemas = source['schemas'];
    }
  }
  export class Status {
    enabled: boolean;
    port: number;
    token: string;
    read: boolean;
    write: boolean;
    databases: string[];
    schemas: string[];
    running: boolean;
    url: string;
    lastError?: string;

    static createFrom(source: any = {}) {
      return new Status(source);
    }

    constructor(source: any = {}) {
      if ('string' === typeof source) source = JSON.parse(source);
      this.enabled = source['enabled'];
      this.port = source['port'];
      this.token = source['token'];
      this.read = source['read'];
      this.write = source['write'];
      this.databases = source['databases'];
      this.schemas = source['schemas'];
      this.running = source['running'];
      this.url = source['url'];
      this.lastError = source['lastError'];
    }
  }
}

export namespace query {
  export class Column {
    name: string;
    type: string;

    static createFrom(source: any = {}) {
      return new Column(source);
    }

    constructor(source: any = {}) {
      if ('string' === typeof source) source = JSON.parse(source);
      this.name = source['name'];
      this.type = source['type'];
    }
  }
  export class ExecRequest {
    tabId: string;
    connId: string;
    database: string;
    sql: string;
    cursor: number;
    maxRows: number;
    manual: boolean;

    static createFrom(source: any = {}) {
      return new ExecRequest(source);
    }

    constructor(source: any = {}) {
      if ('string' === typeof source) source = JSON.parse(source);
      this.tabId = source['tabId'];
      this.connId = source['connId'];
      this.database = source['database'];
      this.sql = source['sql'];
      this.cursor = source['cursor'];
      this.maxRows = source['maxRows'];
      this.manual = source['manual'];
    }
  }
  export class TxStatus {
    open: boolean;
    statements: number;
    startedAt: number;

    static createFrom(source: any = {}) {
      return new TxStatus(source);
    }

    constructor(source: any = {}) {
      if ('string' === typeof source) source = JSON.parse(source);
      this.open = source['open'];
      this.statements = source['statements'];
      this.startedAt = source['startedAt'];
    }
  }
  export class Result {
    id: string;
    statement: string;
    columns: Column[];
    rows: any[][];
    isQuery: boolean;
    hasMore: boolean;
    canFetchMore: boolean;
    rowsAffected: number;
    message?: string;
    durationMs: number;
    error?: string;
    end: number;

    static createFrom(source: any = {}) {
      return new Result(source);
    }

    constructor(source: any = {}) {
      if ('string' === typeof source) source = JSON.parse(source);
      this.id = source['id'];
      this.statement = source['statement'];
      this.columns = this.convertValues(source['columns'], Column);
      this.rows = source['rows'];
      this.isQuery = source['isQuery'];
      this.hasMore = source['hasMore'];
      this.canFetchMore = source['canFetchMore'];
      this.rowsAffected = source['rowsAffected'];
      this.message = source['message'];
      this.durationMs = source['durationMs'];
      this.error = source['error'];
      this.end = source['end'];
    }

    convertValues(a: any, classs: any, asMap: boolean = false): any {
      if (!a) {
        return a;
      }
      if (a.slice && a.map) {
        return (a as any[]).map((elem) => this.convertValues(elem, classs));
      } else if ('object' === typeof a) {
        if (asMap) {
          for (const key of Object.keys(a)) {
            a[key] = new classs(a[key]);
          }
          return a;
        }
        return new classs(a);
      }
      return a;
    }
  }
  export class ExecResponse {
    results: Result[];
    cancelled: boolean;
    tx: TxStatus;
    notice?: string;

    static createFrom(source: any = {}) {
      return new ExecResponse(source);
    }

    constructor(source: any = {}) {
      if ('string' === typeof source) source = JSON.parse(source);
      this.results = this.convertValues(source['results'], Result);
      this.cancelled = source['cancelled'];
      this.tx = this.convertValues(source['tx'], TxStatus);
      this.notice = source['notice'];
    }

    convertValues(a: any, classs: any, asMap: boolean = false): any {
      if (!a) {
        return a;
      }
      if (a.slice && a.map) {
        return (a as any[]).map((elem) => this.convertValues(elem, classs));
      } else if ('object' === typeof a) {
        if (asMap) {
          for (const key of Object.keys(a)) {
            a[key] = new classs(a[key]);
          }
          return a;
        }
        return new classs(a);
      }
      return a;
    }
  }
  export class FetchResult {
    rows: any[][];
    hasMore: boolean;
    error?: string;

    static createFrom(source: any = {}) {
      return new FetchResult(source);
    }

    constructor(source: any = {}) {
      if ('string' === typeof source) source = JSON.parse(source);
      this.rows = source['rows'];
      this.hasMore = source['hasMore'];
      this.error = source['error'];
    }
  }
}

export namespace scratch {
  export class Info {
    id: string;
    name: string;
    connId: string;
    database?: string;
    schema?: string;
    table?: string;
    locked?: boolean;
    createdAt: number;
    updatedAt: number;
    size: number;
    preview?: string;

    static createFrom(source: any = {}) {
      return new Info(source);
    }

    constructor(source: any = {}) {
      if ('string' === typeof source) source = JSON.parse(source);
      this.id = source['id'];
      this.name = source['name'];
      this.connId = source['connId'];
      this.database = source['database'];
      this.schema = source['schema'];
      this.table = source['table'];
      this.locked = source['locked'];
      this.createdAt = source['createdAt'];
      this.updatedAt = source['updatedAt'];
      this.size = source['size'];
      this.preview = source['preview'];
    }
  }
  export class Tab {
    id: string;
    name: string;
    connId: string;
    database?: string;
    kind?: string;
    schema?: string;
    table?: string;
    tableType?: string;
    txMode?: string;
    locked?: boolean;
    content?: string;

    static createFrom(source: any = {}) {
      return new Tab(source);
    }

    constructor(source: any = {}) {
      if ('string' === typeof source) source = JSON.parse(source);
      this.id = source['id'];
      this.name = source['name'];
      this.connId = source['connId'];
      this.database = source['database'];
      this.kind = source['kind'];
      this.schema = source['schema'];
      this.table = source['table'];
      this.tableType = source['tableType'];
      this.txMode = source['txMode'];
      this.locked = source['locked'];
      this.content = source['content'];
    }
  }
  export class Workspace {
    tabs: Tab[];
    activeId: string;

    static createFrom(source: any = {}) {
      return new Workspace(source);
    }

    constructor(source: any = {}) {
      if ('string' === typeof source) source = JSON.parse(source);
      this.tabs = this.convertValues(source['tabs'], Tab);
      this.activeId = source['activeId'];
    }

    convertValues(a: any, classs: any, asMap: boolean = false): any {
      if (!a) {
        return a;
      }
      if (a.slice && a.map) {
        return (a as any[]).map((elem) => this.convertValues(elem, classs));
      } else if ('object' === typeof a) {
        if (asMap) {
          for (const key of Object.keys(a)) {
            a[key] = new classs(a[key]);
          }
          return a;
        }
        return new classs(a);
      }
      return a;
    }
  }
}

export namespace sshtunnel {
  export class Config {
    enabled: boolean;
    host?: string;
    port?: number;
    user?: string;
    method?: string;
    password?: string;
    keyPath?: string;
    passphrase?: string;
    insecureHostKey?: boolean;

    static createFrom(source: any = {}) {
      return new Config(source);
    }

    constructor(source: any = {}) {
      if ('string' === typeof source) source = JSON.parse(source);
      this.enabled = source['enabled'];
      this.host = source['host'];
      this.port = source['port'];
      this.user = source['user'];
      this.method = source['method'];
      this.password = source['password'];
      this.keyPath = source['keyPath'];
      this.passphrase = source['passphrase'];
      this.insecureHostKey = source['insecureHostKey'];
    }
  }
}

export namespace tabledata {
  export class Change {
    op: string;
    key: Record<string, any>;
    values: Record<string, any>;

    static createFrom(source: any = {}) {
      return new Change(source);
    }

    constructor(source: any = {}) {
      if ('string' === typeof source) source = JSON.parse(source);
      this.op = source['op'];
      this.key = source['key'];
      this.values = source['values'];
    }
  }
  export class ApplyRequest {
    schema: string;
    table: string;
    changes: Change[];

    static createFrom(source: any = {}) {
      return new ApplyRequest(source);
    }

    constructor(source: any = {}) {
      if ('string' === typeof source) source = JSON.parse(source);
      this.schema = source['schema'];
      this.table = source['table'];
      this.changes = this.convertValues(source['changes'], Change);
    }

    convertValues(a: any, classs: any, asMap: boolean = false): any {
      if (!a) {
        return a;
      }
      if (a.slice && a.map) {
        return (a as any[]).map((elem) => this.convertValues(elem, classs));
      } else if ('object' === typeof a) {
        if (asMap) {
          for (const key of Object.keys(a)) {
            a[key] = new classs(a[key]);
          }
          return a;
        }
        return new classs(a);
      }
      return a;
    }
  }
  export class ApplyResult {
    inserted: number;
    updated: number;
    deleted: number;

    static createFrom(source: any = {}) {
      return new ApplyResult(source);
    }

    constructor(source: any = {}) {
      if ('string' === typeof source) source = JSON.parse(source);
      this.inserted = source['inserted'];
      this.updated = source['updated'];
      this.deleted = source['deleted'];
    }
  }

  export class Column {
    name: string;
    type: string;
    pk: boolean;
    nullable: boolean;
    editable: boolean;

    static createFrom(source: any = {}) {
      return new Column(source);
    }

    constructor(source: any = {}) {
      if ('string' === typeof source) source = JSON.parse(source);
      this.name = source['name'];
      this.type = source['type'];
      this.pk = source['pk'];
      this.nullable = source['nullable'];
      this.editable = source['editable'];
    }
  }
  export class Page {
    columns: Column[];
    rows: any[][];
    hasMore: boolean;
    offset: number;
    editable: boolean;
    readOnly?: string;
    sql: string;
    durationMs: number;

    static createFrom(source: any = {}) {
      return new Page(source);
    }

    constructor(source: any = {}) {
      if ('string' === typeof source) source = JSON.parse(source);
      this.columns = this.convertValues(source['columns'], Column);
      this.rows = source['rows'];
      this.hasMore = source['hasMore'];
      this.offset = source['offset'];
      this.editable = source['editable'];
      this.readOnly = source['readOnly'];
      this.sql = source['sql'];
      this.durationMs = source['durationMs'];
    }

    convertValues(a: any, classs: any, asMap: boolean = false): any {
      if (!a) {
        return a;
      }
      if (a.slice && a.map) {
        return (a as any[]).map((elem) => this.convertValues(elem, classs));
      } else if ('object' === typeof a) {
        if (asMap) {
          for (const key of Object.keys(a)) {
            a[key] = new classs(a[key]);
          }
          return a;
        }
        return new classs(a);
      }
      return a;
    }
  }
  export class PageRequest {
    schema: string;
    table: string;
    type: string;
    where: string;
    orderBy: string;
    offset: number;
    limit: number;

    static createFrom(source: any = {}) {
      return new PageRequest(source);
    }

    constructor(source: any = {}) {
      if ('string' === typeof source) source = JSON.parse(source);
      this.schema = source['schema'];
      this.table = source['table'];
      this.type = source['type'];
      this.where = source['where'];
      this.orderBy = source['orderBy'];
      this.offset = source['offset'];
      this.limit = source['limit'];
    }
  }
}
