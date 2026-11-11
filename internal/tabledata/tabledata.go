// Package tabledata reads a table page by page and applies grid edits
// (insert / update / delete by primary key) in a single transaction.
package tabledata

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"dolmen/internal/conn"
	"dolmen/internal/driver"
	"dolmen/internal/query"
)

type Column struct {
	Name     string `json:"name"`
	Type     string `json:"type"`
	PK       bool   `json:"pk"`
	Nullable bool   `json:"nullable"`
	Editable bool   `json:"editable"`
}

type PageRequest struct {
	Schema  string `json:"schema"`
	Table   string `json:"table"`
	Type    string `json:"type"` // "table" | "view"
	Where   string `json:"where"`
	OrderBy string `json:"orderBy"`
	Offset  int    `json:"offset"`
	Limit   int    `json:"limit"`
}

type Page struct {
	Columns    []Column `json:"columns"`
	Rows       [][]any  `json:"rows"`
	HasMore    bool     `json:"hasMore"`
	Offset     int      `json:"offset"`
	Editable   bool     `json:"editable"`
	ReadOnly   string   `json:"readOnly,omitempty"` // why editing is disabled
	SQL        string   `json:"sql"`
	DurationMs int64    `json:"durationMs"`
}

const maxLimit = 5000

// columns loads table metadata and marks which columns can be edited.
func columns(ctx context.Context, o *conn.Open, schema, table string) ([]Column, error) {
	meta, err := o.Driver.Columns(ctx, o.DB, schema, table)
	if err != nil {
		return nil, err
	}
	if len(meta) == 0 {
		return nil, fmt.Errorf("table %s.%s not found or has no columns", schema, table)
	}
	out := make([]Column, len(meta))
	for i, c := range meta {
		out[i] = Column{Name: c.Name, Type: c.Type, PK: c.PK, Nullable: c.Nullable, Editable: !isBinary(c.Type)}
	}
	return out, nil
}

// isBinary reports column types whose values Dolmen only previews (hex), so
// they must not be written back.
func isBinary(t string) bool {
	t = strings.ToLower(t)
	for _, b := range []string{"bytea", "blob", "binary", "raw", "bfile", "image"} {
		if strings.Contains(t, b) {
			return true
		}
	}
	return false
}

func qualified(d driver.Driver, schema, table string) string {
	if schema == "" {
		return d.QuoteIdent(table)
	}
	return d.QuoteIdent(schema) + "." + d.QuoteIdent(table)
}

// Querier runs statements: a connection, a session or a transaction.
type Querier interface {
	QueryContext(ctx context.Context, q string, args ...any) (*sql.Rows, error)
	ExecContext(ctx context.Context, q string, args ...any) (sql.Result, error)
}

// Read returns one page of a table, reading through q (so an open
// transaction sees its own uncommitted changes).
func Read(ctx context.Context, o *conn.Open, q Querier, req PageRequest) (*Page, error) {
	cols, err := columns(ctx, o, req.Schema, req.Table)
	if err != nil {
		return nil, err
	}
	limit := req.Limit
	if limit <= 0 {
		limit = 100
	}
	limit = min(limit, maxLimit)
	offset := max(req.Offset, 0)

	d := o.Driver
	names := make([]string, len(cols))
	var pks []string
	for i, c := range cols {
		names[i] = d.QuoteIdent(c.Name)
		if c.PK {
			pks = append(pks, names[i])
		}
	}
	sqlText := "SELECT " + strings.Join(names, ", ") + " FROM " + qualified(d, req.Schema, req.Table)
	if w := strings.TrimSpace(req.Where); w != "" {
		sqlText += " WHERE " + w
	}
	if ob := strings.TrimSpace(req.OrderBy); ob != "" {
		sqlText += " ORDER BY " + ob
	} else if len(pks) > 0 {
		sqlText += " ORDER BY " + strings.Join(pks, ", ") // stable paging
	}
	// One extra row tells whether another page exists.
	if o.Config.Kind == driver.Oracle {
		sqlText += fmt.Sprintf(" OFFSET %d ROWS FETCH NEXT %d ROWS ONLY", offset, limit+1)
	} else {
		sqlText += fmt.Sprintf(" LIMIT %d OFFSET %d", limit+1, offset)
	}

	start := time.Now()
	rows, err := q.QueryContext(ctx, sqlText)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	page := &Page{Columns: cols, Rows: [][]any{}, Offset: offset, SQL: sqlText}
	for rows.Next() {
		if len(page.Rows) == limit {
			page.HasMore = true
			break
		}
		vals := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return nil, err
		}
		for i, v := range vals {
			vals[i] = query.Normalize(v)
		}
		page.Rows = append(page.Rows, vals)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	page.DurationMs = time.Since(start).Milliseconds()

	switch {
	case o.Config.ReadOnly:
		page.ReadOnly = "Read-only connection"
	case req.Type == "view":
		page.ReadOnly = "Views are not editable"
	case len(pks) == 0:
		page.ReadOnly = "No primary key: rows cannot be identified safely"
	default:
		page.Editable = true
	}
	return page, nil
}

// Change is one pending grid edit.
type Change struct {
	Op     string         `json:"op"`     // insert | update | delete
	Key    map[string]any `json:"key"`    // primary key values (update, delete)
	Values map[string]any `json:"values"` // new column values (insert, update)
}

type ApplyRequest struct {
	Schema  string   `json:"schema"`
	Table   string   `json:"table"`
	Changes []Change `json:"changes"`
}

type ApplyResult struct {
	Inserted int `json:"inserted"`
	Updated  int `json:"updated"`
	Deleted  int `json:"deleted"`
}

// Apply runs every change through q and stops at the first failure. The
// caller owns the transaction (and rolls it back, or to a savepoint, on error).
func Apply(ctx context.Context, o *conn.Open, q Querier, req ApplyRequest) (*ApplyResult, error) {
	if o.Config.ReadOnly {
		return nil, errors.New("read-only connection: changes are not allowed")
	}
	cols, err := columns(ctx, o, req.Schema, req.Table)
	if err != nil {
		return nil, err
	}
	byName := map[string]Column{}
	var pks []Column
	for _, c := range cols {
		byName[c.Name] = c
		if c.PK {
			pks = append(pks, c)
		}
	}
	if len(pks) == 0 {
		return nil, errors.New("the table has no primary key: rows cannot be identified safely")
	}

	b := builder{kind: o.Config.Kind, d: o.Driver, target: qualified(o.Driver, req.Schema, req.Table), cols: byName, pks: pks}
	type stmt struct {
		op   string
		sql  string
		args []any
	}
	for _, ch := range req.Changes {
		if ch.Op != "delete" && ch.Op != "update" && ch.Op != "insert" {
			return nil, fmt.Errorf("unknown change %q", ch.Op)
		}
	}
	var stmts []stmt
	// Deletes first, then updates, then inserts, so a re-inserted key does not collide.
	for _, op := range []string{"delete", "update", "insert"} {
		for _, ch := range req.Changes {
			if ch.Op != op {
				continue
			}
			s, args, err := b.build(ch)
			if err != nil {
				return nil, err
			}
			stmts = append(stmts, stmt{op, s, args})
		}
	}

	res := &ApplyResult{}
	for _, s := range stmts {
		r, err := q.ExecContext(ctx, s.sql, s.args...)
		if err != nil {
			return nil, fmt.Errorf("%s failed: %w", s.op, err)
		}
		n, err := r.RowsAffected()
		if err == nil && s.op != "insert" && n != 1 {
			return nil, fmt.Errorf("%s matched %d rows instead of 1: the row was changed or removed by someone else; refresh and try again", s.op, n)
		}
		switch s.op {
		case "insert":
			res.Inserted++
		case "update":
			res.Updated++
		case "delete":
			res.Deleted++
		}
	}
	return res, nil
}

type builder struct {
	kind   driver.Kind
	d      driver.Driver
	target string
	cols   map[string]Column
	pks    []Column
	n      int
	args   []any
}

func (b *builder) build(ch Change) (string, []any, error) {
	b.n, b.args = 0, nil
	switch ch.Op {
	case "insert":
		if len(ch.Values) == 0 {
			switch b.kind {
			case driver.MySQL:
				return "INSERT INTO " + b.target + " () VALUES ()", nil, nil
			case driver.Oracle:
				return "", nil, errors.New("fill in at least one column of the new row")
			}
			return "INSERT INTO " + b.target + " DEFAULT VALUES", nil, nil
		}
		var names, vals []string
		for _, name := range sortedKeys(ch.Values) {
			c, err := b.col(name)
			if err != nil {
				return "", nil, err
			}
			expr, err := b.bind(c, ch.Values[name])
			if err != nil {
				return "", nil, err
			}
			names = append(names, b.d.QuoteIdent(name))
			vals = append(vals, expr)
		}
		return fmt.Sprintf("INSERT INTO %s (%s) VALUES (%s)", b.target, strings.Join(names, ", "), strings.Join(vals, ", ")), b.args, nil
	case "update":
		if len(ch.Values) == 0 {
			return "", nil, errors.New("update without values")
		}
		var sets []string
		for _, name := range sortedKeys(ch.Values) {
			c, err := b.col(name)
			if err != nil {
				return "", nil, err
			}
			expr, err := b.bind(c, ch.Values[name])
			if err != nil {
				return "", nil, err
			}
			sets = append(sets, b.d.QuoteIdent(name)+" = "+expr)
		}
		where, err := b.where(ch.Key)
		if err != nil {
			return "", nil, err
		}
		return fmt.Sprintf("UPDATE %s SET %s WHERE %s", b.target, strings.Join(sets, ", "), where), b.args, nil
	case "delete":
		where, err := b.where(ch.Key)
		if err != nil {
			return "", nil, err
		}
		return fmt.Sprintf("DELETE FROM %s WHERE %s", b.target, where), b.args, nil
	}
	return "", nil, fmt.Errorf("unknown change %q", ch.Op)
}

func (b *builder) col(name string) (Column, error) {
	c, ok := b.cols[name]
	if !ok {
		return c, fmt.Errorf("unknown column %q", name)
	}
	if !c.Editable {
		return c, fmt.Errorf("column %q is not editable", name)
	}
	return c, nil
}

func (b *builder) where(key map[string]any) (string, error) {
	var parts []string
	for _, pk := range b.pks {
		v, ok := key[pk.Name]
		if !ok || v == nil {
			return "", fmt.Errorf("missing value for primary key %q", pk.Name)
		}
		expr, err := b.bind(pk, v)
		if err != nil {
			return "", err
		}
		parts = append(parts, b.d.QuoteIdent(pk.Name)+" = "+expr)
	}
	return strings.Join(parts, " AND "), nil
}

// bind adds a parameter and returns its SQL expression. Values travel as text
// and are converted by the database, so every column type round-trips the
// way the grid displays it.
func (b *builder) bind(c Column, v any) (string, error) {
	if v == nil {
		return "NULL", nil
	}
	s, err := text(v)
	if err != nil {
		return "", err
	}
	b.n++
	switch b.kind {
	case driver.Postgres:
		b.args = append(b.args, s)
		return fmt.Sprintf("CAST($%d AS text)::%s", b.n, c.Type), nil
	case driver.Oracle:
		up := strings.ToUpper(c.Type)
		if strings.HasPrefix(up, "DATE") || strings.HasPrefix(up, "TIMESTAMP") {
			t, err := parseTime(s)
			if err != nil {
				return "", fmt.Errorf("column %q: %w", c.Name, err)
			}
			b.args = append(b.args, t)
		} else {
			b.args = append(b.args, s)
		}
		return fmt.Sprintf(":%d", b.n), nil
	default:
		b.args = append(b.args, s)
		return "?", nil
	}
}

func text(v any) (string, error) {
	switch x := v.(type) {
	case string:
		return x, nil
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64), nil
	case bool:
		return strconv.FormatBool(x), nil
	case int, int64:
		return fmt.Sprint(x), nil
	}
	return "", fmt.Errorf("unsupported value %T", v)
}

var timeLayouts = []string{
	"2006-01-02 15:04:05.999999999 -07:00",
	"2006-01-02 15:04:05.999999999",
	"2006-01-02T15:04:05.999999999Z07:00",
	"2006-01-02T15:04:05",
	"2006-01-02 15:04",
	"2006-01-02",
}

func parseTime(s string) (time.Time, error) {
	for _, l := range timeLayouts {
		if t, err := time.ParseInLocation(l, strings.TrimSpace(s), time.Local); err == nil {
			return t, nil
		}
	}
	return time.Time{}, fmt.Errorf("cannot read %q as a date (use YYYY-MM-DD HH:MM:SS)", s)
}

func sortedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys) // deterministic SQL helps debugging and tests
	return keys
}
