# Changelog

Notable changes to Dolmen. Versions follow [semantic versioning](https://semver.org); each
release is published on the [GitHub releases page](https://github.com/get-dolmen/dolmen/releases).

## [0.6.0] - 2026-11-23

### Added

- **Schema per scratch**: a picker next to the database picker chooses the schema a scratch runs
  in (`search_path` on Postgres, `USE` on MySQL, `CURRENT_SCHEMA` on Oracle). The choice is saved
  with the tab and used by completion for unqualified names; a scratch created for a table starts
  in that table's schema. Not offered on SQLite.
- **Create schemas** from the explorer: on a Postgres database, and on MySQL and Oracle
  connections. Oracle schemas are created as schema-only users (`CREATE USER … NO
  AUTHENTICATION`, 18c+).
- **Create databases** from a Postgres connection's menu, or open the `CREATE DATABASE` as a script.
- **New table** from a schema's context menu.
- **Format SQL** from the editor's context menu (also ⌘⇧F / Ctrl+Shift+F).
- **Formatter line width** setting (Settings › Editor): how long function arguments and `IN (…)`
  lists may get before they are split one item per line. Defaults to 80, up from a fixed 50.
- **Pinned tabs** stay at the front of the tab bar.

### Changed

- **Built on Wails v3** instead of v2. On Linux, Dolmen now needs GTK 4 and WebKitGTK 6.0
  (`libgtk-4-1`, `libwebkitgtk-6.0-4`) instead of GTK 3 and WebKitGTK 4.1. The webview storage
  moved, so appearance and layout preferences (theme, panel sizes, result placement) may return
  to their defaults on first launch; connections, scratches and history are not affected.
- **Settings** are split into sections listed on the left: Appearance, Layout and Editor, then
  Git sync and MCP server.
- A database's context menu creates schemas only; databases are created from the connection's
  menu.
- Notifications no longer have a coloured left border.

### Fixed

- The Copy and Export menus of inline results are no longer clipped by the result, and closing
  them no longer blanks the whole window.
- Inline results are removed together with the statement they belong to.
- The editor's context menu no longer shows a focus outline above and below it.
- Restarting the MCP server on the same port (for example after saving its settings) could fail
  with "address already in use".

[0.6.0]: https://github.com/get-dolmen/dolmen/compare/v0.5.0...v0.6.0
