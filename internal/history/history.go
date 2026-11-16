// Package history stores executed statements in an app-internal SQLite file.
package history

import (
	"context"
	"database/sql"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

type Entry struct {
	ID         int64  `json:"id"`
	ConnID     string `json:"connId"`
	SQL        string `json:"sql"`
	StartedAt  int64  `json:"startedAt"` // unix ms
	DurationMs int64  `json:"durationMs"`
	Rows       int64  `json:"rows"`
	Status     string `json:"status"` // ok | error | cancelled
	Error      string `json:"error,omitempty"`
}

type Store struct{ database *sql.DB }

// maxEntries caps the history size; older rows are pruned on insert.
const maxEntries = 20000

func Open(path string) (*Store, error) {
	database, err := sql.Open("sqlite", "file:"+path+"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)")
	if err != nil {
		return nil, err
	}
	database.SetMaxOpenConns(1)
	_, err = database.Exec(`
		create table if not exists history (
			id integer primary key autoincrement,
			conn_id text not null,
			sql text not null,
			started_at integer not null,
			duration_ms integer not null,
			rows integer not null,
			status text not null,
			error text
		);
		create index if not exists history_conn_time on history (conn_id, started_at desc);`)
	if err != nil {
		database.Close()
		return nil, err
	}
	return &Store{database: database}, nil
}

func (s *Store) Close() error { return s.database.Close() }

func (s *Store) Record(entry Entry) {
	if entry.StartedAt == 0 {
		entry.StartedAt = time.Now().UnixMilli()
	}
	execution, err := s.database.Exec(`insert into history (conn_id, sql, started_at, duration_ms, rows, status, error)
		values (?, ?, ?, ?, ?, ?, ?)`, entry.ConnID, entry.SQL, entry.StartedAt, entry.DurationMs, entry.Rows, entry.Status, entry.Error)
	if err != nil {
		return
	}
	if id, _ := execution.LastInsertId(); id%500 == 0 {
		s.database.Exec(`delete from history where id <= ?`, id-maxEntries)
	}
}

// List returns the latest entries for a connection ("" = all), optionally
// filtered by a case-insensitive substring.
func (s *Store) List(ctx context.Context, connID, search string, limit int) ([]Entry, error) {
	if limit <= 0 || limit > 1000 {
		limit = 200
	}
	query := `select id, conn_id, sql, started_at, duration_ms, rows, status, coalesce(error, '') from history where 1 = 1`
	var args []any
	if connID != "" {
		query += ` and conn_id = ?`
		args = append(args, connID)
	}
	if search = strings.TrimSpace(search); search != "" {
		query += ` and sql like ? escape '\'`
		wildcardEscaper := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
		args = append(args, "%"+wildcardEscaper.Replace(search)+"%")
	}
	query += ` order by started_at desc limit ?`
	args = append(args, limit)
	rows, err := s.database.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	entries := []Entry{}
	for rows.Next() {
		var entry Entry
		if err := rows.Scan(&entry.ID, &entry.ConnID, &entry.SQL, &entry.StartedAt, &entry.DurationMs, &entry.Rows, &entry.Status, &entry.Error); err != nil {
			return nil, err
		}
		entries = append(entries, entry)
	}
	return entries, rows.Err()
}

func (s *Store) Clear(connID string) error {
	if connID == "" {
		_, err := s.database.Exec(`delete from history`)
		return err
	}
	_, err := s.database.Exec(`delete from history where conn_id = ?`, connID)
	return err
}
