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

type Store struct{ db *sql.DB }

// maxEntries caps the history size; older rows are pruned on insert.
const maxEntries = 20000

func Open(path string) (*Store, error) {
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	_, err = db.Exec(`
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
		db.Close()
		return nil, err
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) Record(e Entry) {
	if e.StartedAt == 0 {
		e.StartedAt = time.Now().UnixMilli()
	}
	res, err := s.db.Exec(`insert into history (conn_id, sql, started_at, duration_ms, rows, status, error)
		values (?, ?, ?, ?, ?, ?, ?)`, e.ConnID, e.SQL, e.StartedAt, e.DurationMs, e.Rows, e.Status, e.Error)
	if err != nil {
		return
	}
	if id, _ := res.LastInsertId(); id%500 == 0 {
		s.db.Exec(`delete from history where id <= ?`, id-maxEntries)
	}
}

// List returns the latest entries for a connection ("" = all), optionally
// filtered by a case-insensitive substring.
func (s *Store) List(ctx context.Context, connID, search string, limit int) ([]Entry, error) {
	if limit <= 0 || limit > 1000 {
		limit = 200
	}
	q := `select id, conn_id, sql, started_at, duration_ms, rows, status, coalesce(error, '') from history where 1 = 1`
	var args []any
	if connID != "" {
		q += ` and conn_id = ?`
		args = append(args, connID)
	}
	if search = strings.TrimSpace(search); search != "" {
		q += ` and sql like ? escape '\'`
		r := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
		args = append(args, "%"+r.Replace(search)+"%")
	}
	q += ` order by started_at desc limit ?`
	args = append(args, limit)
	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Entry{}
	for rows.Next() {
		var e Entry
		if err := rows.Scan(&e.ID, &e.ConnID, &e.SQL, &e.StartedAt, &e.DurationMs, &e.Rows, &e.Status, &e.Error); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

func (s *Store) Clear(connID string) error {
	if connID == "" {
		_, err := s.db.Exec(`delete from history`)
		return err
	}
	_, err := s.db.Exec(`delete from history where conn_id = ?`, connID)
	return err
}
