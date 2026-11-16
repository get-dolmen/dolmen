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

// loadColumns loads table metadata and marks which columns can be edited.
func loadColumns(ctx context.Context, opened *conn.Open, schema, table string) ([]Column, error) {
	metadata, err := opened.Driver.Columns(ctx, opened.DB, schema, table)
	if err != nil {
		return nil, err
	}
	if len(metadata) == 0 {
		return nil, fmt.Errorf("table %s.%s not found or has no columns", schema, table)
	}
	result := make([]Column, len(metadata))
	for index, column := range metadata {
		result[index] = Column{Name: column.Name, Type: column.Type, PK: column.PK, Nullable: column.Nullable, Editable: !isBinary(column.Type)}
	}
	return result, nil
}

// isBinary reports column types whose values Dolmen only previews (hex), so
// they must not be written back.
func isBinary(columnType string) bool {
	columnType = strings.ToLower(columnType)
	for _, binaryType := range []string{"bytea", "blob", "binary", "raw", "bfile", "image"} {
		if strings.Contains(columnType, binaryType) {
			return true
		}
	}
	return false
}

func qualified(dialect driver.Driver, schema, table string) string {
	if schema == "" {
		return dialect.QuoteIdent(table)
	}
	return dialect.QuoteIdent(schema) + "." + dialect.QuoteIdent(table)
}

// Querier runs statements: a connection, a session or a transaction.
type Querier interface {
	QueryContext(ctx context.Context, query string, arguments ...any) (*sql.Rows, error)
	ExecContext(ctx context.Context, query string, arguments ...any) (sql.Result, error)
}

// Read returns one page of a table, reading through querier (so an open
// transaction sees its own uncommitted changes).
func Read(ctx context.Context, opened *conn.Open, querier Querier, request PageRequest) (*Page, error) {
	columns, err := loadColumns(ctx, opened, request.Schema, request.Table)
	if err != nil {
		return nil, err
	}
	limit := request.Limit
	if limit <= 0 {
		limit = 100
	}
	limit = min(limit, maxLimit)
	offset := max(request.Offset, 0)

	dialect := opened.Driver
	quotedNames := make([]string, len(columns))
	var primaryKeys []string
	for index, column := range columns {
		quotedNames[index] = dialect.QuoteIdent(column.Name)
		if column.PK {
			primaryKeys = append(primaryKeys, quotedNames[index])
		}
	}
	sqlText := "SELECT " + strings.Join(quotedNames, ", ") + " FROM " + qualified(dialect, request.Schema, request.Table)
	if where := strings.TrimSpace(request.Where); where != "" {
		sqlText += " WHERE " + where
	}
	if orderBy := strings.TrimSpace(request.OrderBy); orderBy != "" {
		sqlText += " ORDER BY " + orderBy
	} else if len(primaryKeys) > 0 {
		sqlText += " ORDER BY " + strings.Join(primaryKeys, ", ") // stable paging
	}
	// One extra row tells whether another page exists.
	if opened.Config.Kind == driver.Oracle {
		sqlText += fmt.Sprintf(" OFFSET %d ROWS FETCH NEXT %d ROWS ONLY", offset, limit+1)
	} else {
		sqlText += fmt.Sprintf(" LIMIT %d OFFSET %d", limit+1, offset)
	}

	start := time.Now()
	rows, err := querier.QueryContext(ctx, sqlText)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	page := &Page{Columns: columns, Rows: [][]any{}, Offset: offset, SQL: sqlText}
	for rows.Next() {
		if len(page.Rows) == limit {
			page.HasMore = true
			break
		}
		row, err := query.ScanRow(rows, len(columns))
		if err != nil {
			return nil, err
		}
		page.Rows = append(page.Rows, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	page.DurationMs = time.Since(start).Milliseconds()

	switch {
	case opened.Config.ReadOnly:
		page.ReadOnly = "Read-only connection"
	case request.Type == "view":
		page.ReadOnly = "Views are not editable"
	case len(primaryKeys) == 0:
		page.ReadOnly = "No primary key: rows cannot be identified safely"
	default:
		page.Editable = true
	}
	return page, nil
}

// Count returns how many rows the table holds under the request's filter.
// It runs on the same querier as Read so an open transaction sees its own
// uncommitted changes.
func Count(ctx context.Context, opened *conn.Open, querier Querier, request PageRequest) (int64, error) {
	sqlText := "SELECT COUNT(*) FROM " + qualified(opened.Driver, request.Schema, request.Table)
	if where := strings.TrimSpace(request.Where); where != "" {
		sqlText += " WHERE " + where
	}
	var rowCount int64
	rows, err := querier.QueryContext(ctx, sqlText)
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return 0, err
		}
		return 0, errors.New("the count query returned no row")
	}
	if err := rows.Scan(&rowCount); err != nil {
		return 0, err
	}
	return rowCount, rows.Err()
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

// Apply runs every change through querier and stops at the first failure. The
// caller owns the transaction (and rolls it back, or to a savepoint, on error).
func Apply(ctx context.Context, opened *conn.Open, querier Querier, request ApplyRequest) (*ApplyResult, error) {
	if opened.Config.ReadOnly {
		return nil, errors.New("read-only connection: changes are not allowed")
	}
	columns, err := loadColumns(ctx, opened, request.Schema, request.Table)
	if err != nil {
		return nil, err
	}
	columnsByName := map[string]Column{}
	var primaryKeys []Column
	for _, column := range columns {
		columnsByName[column.Name] = column
		if column.PK {
			primaryKeys = append(primaryKeys, column)
		}
	}
	if len(primaryKeys) == 0 {
		return nil, errors.New("the table has no primary key: rows cannot be identified safely")
	}

	statementBuilder := builder{kind: opened.Config.Kind, dialect: opened.Driver, target: qualified(opened.Driver, request.Schema, request.Table), columns: columnsByName, primaryKeys: primaryKeys}
	type statement struct {
		op        string
		sql       string
		arguments []any
	}
	for _, change := range request.Changes {
		if change.Op != "delete" && change.Op != "update" && change.Op != "insert" {
			return nil, fmt.Errorf("unknown change %q", change.Op)
		}
	}
	var statements []statement
	// Deletes first, then updates, then inserts, so a re-inserted key does not collide.
	for _, op := range []string{"delete", "update", "insert"} {
		for _, change := range request.Changes {
			if change.Op != op {
				continue
			}
			sql, arguments, err := statementBuilder.build(change)
			if err != nil {
				return nil, err
			}
			statements = append(statements, statement{op, sql, arguments})
		}
	}

	result := &ApplyResult{}
	for _, statement := range statements {
		execution, err := querier.ExecContext(ctx, statement.sql, statement.arguments...)
		if err != nil {
			return nil, fmt.Errorf("%s failed: %w", statement.op, err)
		}
		affected, err := execution.RowsAffected()
		if err == nil && statement.op != "insert" && affected != 1 {
			return nil, fmt.Errorf("%s matched %d rows instead of 1: the row was changed or removed by someone else; refresh and try again", statement.op, affected)
		}
		switch statement.op {
		case "insert":
			result.Inserted++
		case "update":
			result.Updated++
		case "delete":
			result.Deleted++
		}
	}
	return result, nil
}

type builder struct {
	kind          driver.Kind
	dialect       driver.Driver
	target        string
	columns       map[string]Column
	primaryKeys   []Column
	argumentIndex int
	arguments     []any
}

func (b *builder) build(change Change) (string, []any, error) {
	b.argumentIndex, b.arguments = 0, nil
	switch change.Op {
	case "insert":
		if len(change.Values) == 0 {
			switch b.kind {
			case driver.MySQL:
				return "INSERT INTO " + b.target + " () VALUES ()", nil, nil
			case driver.Oracle:
				return "", nil, errors.New("fill in at least one column of the new row")
			}
			return "INSERT INTO " + b.target + " DEFAULT VALUES", nil, nil
		}
		var columnNames, valueExpressions []string
		for _, name := range sortedKeys(change.Values) {
			column, err := b.editableColumn(name)
			if err != nil {
				return "", nil, err
			}
			expression, err := b.bind(column, change.Values[name])
			if err != nil {
				return "", nil, err
			}
			columnNames = append(columnNames, b.dialect.QuoteIdent(name))
			valueExpressions = append(valueExpressions, expression)
		}
		return fmt.Sprintf("INSERT INTO %s (%s) VALUES (%s)", b.target, strings.Join(columnNames, ", "), strings.Join(valueExpressions, ", ")), b.arguments, nil
	case "update":
		if len(change.Values) == 0 {
			return "", nil, errors.New("update without values")
		}
		var assignments []string
		for _, name := range sortedKeys(change.Values) {
			column, err := b.editableColumn(name)
			if err != nil {
				return "", nil, err
			}
			expression, err := b.bind(column, change.Values[name])
			if err != nil {
				return "", nil, err
			}
			assignments = append(assignments, b.dialect.QuoteIdent(name)+" = "+expression)
		}
		where, err := b.where(change.Key)
		if err != nil {
			return "", nil, err
		}
		return fmt.Sprintf("UPDATE %s SET %s WHERE %s", b.target, strings.Join(assignments, ", "), where), b.arguments, nil
	case "delete":
		where, err := b.where(change.Key)
		if err != nil {
			return "", nil, err
		}
		return fmt.Sprintf("DELETE FROM %s WHERE %s", b.target, where), b.arguments, nil
	}
	return "", nil, fmt.Errorf("unknown change %q", change.Op)
}

func (b *builder) editableColumn(name string) (Column, error) {
	column, ok := b.columns[name]
	if !ok {
		return column, fmt.Errorf("unknown column %q", name)
	}
	if !column.Editable {
		return column, fmt.Errorf("column %q is not editable", name)
	}
	return column, nil
}

func (b *builder) where(key map[string]any) (string, error) {
	var parts []string
	for _, primaryKey := range b.primaryKeys {
		value, ok := key[primaryKey.Name]
		if !ok || value == nil {
			return "", fmt.Errorf("missing value for primary key %q", primaryKey.Name)
		}
		expression, err := b.bind(primaryKey, value)
		if err != nil {
			return "", err
		}
		parts = append(parts, b.dialect.QuoteIdent(primaryKey.Name)+" = "+expression)
	}
	return strings.Join(parts, " AND "), nil
}

// bind adds a parameter and returns its SQL expression. Values travel as text
// and are converted by the database, so every column type round-trips the
// way the grid displays it.
func (b *builder) bind(column Column, value any) (string, error) {
	if value == nil {
		return "NULL", nil
	}
	textValue, err := text(value)
	if err != nil {
		return "", err
	}
	b.argumentIndex++
	switch b.kind {
	case driver.Postgres:
		b.arguments = append(b.arguments, textValue)
		return fmt.Sprintf("CAST($%d AS text)::%s", b.argumentIndex, column.Type), nil
	case driver.Oracle:
		upperType := strings.ToUpper(column.Type)
		if strings.HasPrefix(upperType, "DATE") || strings.HasPrefix(upperType, "TIMESTAMP") {
			parsedTime, err := parseTime(textValue)
			if err != nil {
				return "", fmt.Errorf("column %q: %w", column.Name, err)
			}
			b.arguments = append(b.arguments, parsedTime)
		} else {
			b.arguments = append(b.arguments, textValue)
		}
		return fmt.Sprintf(":%d", b.argumentIndex), nil
	default:
		b.arguments = append(b.arguments, textValue)
		return "?", nil
	}
}

func text(value any) (string, error) {
	switch typed := value.(type) {
	case string:
		return typed, nil
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64), nil
	case bool:
		return strconv.FormatBool(typed), nil
	case int, int64:
		return fmt.Sprint(typed), nil
	}
	return "", fmt.Errorf("unsupported value %T", value)
}

var timeLayouts = []string{
	"2006-01-02 15:04:05.999999999 -07:00",
	"2006-01-02 15:04:05.999999999",
	"2006-01-02T15:04:05.999999999Z07:00",
	"2006-01-02T15:04:05",
	"2006-01-02 15:04",
	"2006-01-02",
}

func parseTime(value string) (time.Time, error) {
	for _, layout := range timeLayouts {
		if parsed, err := time.ParseInLocation(layout, strings.TrimSpace(value), time.Local); err == nil {
			return parsed, nil
		}
	}
	return time.Time{}, fmt.Errorf("cannot read %q as a date (use YYYY-MM-DD HH:MM:SS)", value)
}

func sortedKeys(values map[string]any) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys) // deterministic SQL helps debugging and tests
	return keys
}
