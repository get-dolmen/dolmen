# Dolmen

A desktop SQL client for **PostgreSQL, MySQL, Oracle and SQLite**, built with Go ([Wails v2](https://wails.io)) and Angular.

- **Scratch files:** SQL files linked to a connection (and database), autosaved, kept when their tab closes. The *Scratches* section of the explorer files them in connection → database → table folders (drag a scratch onto a folder to move it; *Select top 100*, *Show DDL* and *New scratch for this table* file theirs under the table): open, rename (F2), duplicate, save as a `.sql` file, delete; or open a `.sql` file from disk as a scratch. ⌘S saves immediately.
- **Explorer on the right:** connections → schemas → tables/views → columns, lazy-loaded, with a filter. The context menu has *Select top 100*, *Show DDL*, *Insert name* and *Copy name*.
- **Search palette (⌘P / Ctrl+P):** fuzzy search across tables of every open connection, tabs, connections and commands (`>` prefix = commands only).
- **Read-only connections:** enforced twice, by the database session (Postgres `default_transaction_read_only`, MySQL `transaction_read_only`, SQLite `mode=ro` + `query_only`, Oracle `SET TRANSACTION READ ONLY`) and by a statement guard that only lets queries through.
- **Execution:** run the statement at the cursor (⌘↵), the selection, or the whole script (⌘⇧↵). Cancel with Esc. Each tab has its own DB session, so `SET`, temp tables and transactions persist between runs.
- **Transactions:** per tab, *Tx: Auto* (each statement commits) or *Tx: Manual*: a transaction stays open across runs until **Commit** / **Rollback** (typed `COMMIT` / `ROLLBACK` work too). Data tabs submit into that transaction (with a savepoint per batch) and show its uncommitted rows. Closing or switching a tab with an open transaction asks first.
- **Table data editor:** double-click a table to browse and edit it: server-side WHERE / ORDER BY and paging, add / delete rows, SET NULL, a SQL preview of pending changes, and Submit (⌘S).
- **Results:** virtualised grid (AG Grid), 1,000-row pages with *Fetch more*, NULLs shown distinctly, copy as TSV (⌘C), and export to CSV/JSON. Exports stream every remaining row.
- **Schema-aware autocomplete** in Monaco: tables, schemas and columns, resolving aliases (`o.` → columns of `orders o`).
- **Query history** per connection, searchable.

## Shortcuts

| Action | macOS | Windows / Linux |
|---|---|---|
| Search palette | ⌘P | Ctrl+P |
| Command palette | ⌘⇧P | Ctrl+Shift+P |
| Run statement / selection | ⌘↵ | Ctrl+Enter |
| Run whole script | ⌘⇧↵ | Ctrl+Shift+Enter |
| Cancel query | Esc | Esc |
| New / close tab | ⌘T / ⌘W | Ctrl+T / Ctrl+W |
| Next / previous tab | Ctrl+Tab, ⌘⇧] / ⌘⇧[ | Ctrl+Tab |
| Toggle explorer | ⌘B | Ctrl+B |

## Development

Requirements: Go 1.25+, Node 22+, the Wails CLI (`go install github.com/wailsapp/wails/v2/cmd/wails@latest`).

```sh
wails dev          # app window + http://localhost:34115 in a browser, with live Go bindings
wails build        # build/bin/dolmen.app (or .exe)
```

All database drivers are pure Go (pgx, go-sql-driver/mysql, go-ora, modernc.org/sqlite): no Oracle Instant Client and no CGO for the drivers.

### Tests

```sh
go test ./internal/...                     # splitter, read-only guard, executor (SQLite)
cd frontend && npx ng test --watch=false   # completion parsing, palette ranking

docker compose up -d                       # Postgres, MySQL, Oracle Free
go test -tags integration ./internal/query/
```

## Releases

`.github/workflows/build.yml` runs the tests and builds macOS (universal), Linux (amd64) and Windows (amd64) on every push and pull request; the builds are downloadable from the run's *Artifacts*. Pushing a tag publishes a GitHub release with all three builds and a `SHA256SUMS.txt`:

```sh
git tag v0.1.0 && git push origin v0.1.0
```

The version, repository and commit are stamped into the binary (`-ldflags -X main.version=… -X main.repo=…`). The version button in the status bar shows them and, when clicked, asks GitHub for the latest release. Tags with a suffix (`v1.2.0-rc.1`) are published as pre-releases and are not offered as updates. Local builds report `dev build`.

The macOS build is not signed or notarized: on first launch, right-click the app and choose *Open* (or run `xattr -dr com.apple.quarantine Dolmen.app`).

## Layout

```
app.go, main.go          Wails bindings (thin) and window setup
internal/driver          per-engine DSN, read-only session, metadata queries
internal/sqlsplit        dialect-aware statement splitter + read-only guard
internal/query           per-tab sessions, execution, cancel, paging, value normalisation
internal/conn            saved connections (JSON) and open pools
internal/history         query history (SQLite)
internal/scratch         tab files + manifest
internal/export          CSV / JSON writers
frontend/src/app/core    stores (signals), API wrapper, commands, hotkeys
frontend/src/app/features  topbar, tabs, editor (Monaco), results (AG Grid), schema sidebar, palette, dialogs
```

App data lives in the OS config directory (`~/Library/Application Support/dolmen` on macOS). Connection passwords are currently stored in `connections.json` (mode 0600); OS keychain support is planned.
