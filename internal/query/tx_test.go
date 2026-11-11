package query_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"dolmen/internal/conn"
	"dolmen/internal/driver"
	"dolmen/internal/query"
)

func count(t *testing.T, e *query.Executor, tab string) any {
	t.Helper()
	r := run(t, e, tab, "c", "select count(*) from t", -1, 0)
	if r.Results[0].Error != "" {
		t.Fatal(r.Results[0].Error)
	}
	return r.Results[0].Rows[0][0]
}

func TestManualTransactions(t *testing.T) {
	e, m, _, file := setup(t)
	if _, err := m.Connect(context.Background(), driver.Config{ID: "c", Name: "c", Kind: driver.SQLite, FilePath: file}); err != nil {
		t.Fatal(err)
	}
	run(t, e, "setup", "c", "create table t (id integer primary key, v text)", -1, 0)

	manual := func(tab, sql string) *query.ExecResponse {
		t.Helper()
		r, err := e.Execute(query.ExecRequest{TabID: tab, ConnID: "c", SQL: sql, Cursor: -1, Manual: true})
		if err != nil {
			t.Fatal(err)
		}
		return r
	}

	// Writes stay invisible to other sessions until commit.
	r := manual("a", "insert into t values (1, 'x'); insert into t values (2, 'y')")
	if !r.Tx.Open || r.Tx.Statements != 2 {
		t.Fatalf("tx after inserts: %+v", r.Tx)
	}
	if got := count(t, e, "b"); got != int64(0) {
		t.Fatalf("other tab sees uncommitted rows: %v", got)
	}
	if r := manual("a", "select count(*) from t"); r.Results[0].Rows[0][0] != int64(2) || r.Tx.Statements != 3 {
		t.Fatalf("own tab should see its rows: %+v", r)
	}
	// Auto mode is refused while the transaction is open.
	if _, err := e.Execute(query.ExecRequest{TabID: "a", ConnID: "c", SQL: "select 1", Cursor: -1}); err == nil {
		t.Fatal("switching to auto with an open transaction should fail")
	}
	st, err := e.EndTx("a", true)
	if err != nil || st.Open {
		t.Fatalf("commit: %+v %v", st, err)
	}
	if got := count(t, e, "b"); got != int64(2) {
		t.Fatalf("after commit other tab sees %v rows", got)
	}

	// A typed ROLLBACK ends the transaction.
	r = manual("a", "delete from t; rollback")
	if r.Tx.Open || !strings.HasPrefix(r.Results[1].Message, "Rolled back") {
		t.Fatalf("typed rollback: %+v", r)
	}
	if got := count(t, e, "b"); got != int64(2) {
		t.Fatalf("rollback lost: %v rows", got)
	}
	if _, err := e.EndTx("a", true); err == nil {
		t.Fatal("commit without a transaction should fail")
	}

	// Data editor writes in manual mode: a failing batch is undone alone (savepoint).
	ctx := context.Background()
	write := func(sql string) error {
		_, err := e.WithSession(ctx, "a", "c", "", true, true, func(ctx context.Context, _ *conn.Open, q query.Querier) (int, error) {
			_, err := q.ExecContext(ctx, sql)
			return 1, err
		})
		return err
	}
	if err := write("insert into t values (3, 'z')"); err != nil {
		t.Fatal(err)
	}
	if err := write("insert into t values (1, 'duplicate')"); err == nil {
		t.Fatal("duplicate key should fail")
	}
	st = e.TxStatusOf("a")
	if !st.Open || st.Statements != 1 {
		t.Fatalf("tx after failed batch: %+v", st)
	}
	if _, err := e.EndTx("a", true); err != nil {
		t.Fatal(err)
	}
	if got := count(t, e, "b"); got != int64(3) {
		t.Fatalf("expected the first batch only: %v rows", got)
	}

	// Auto-mode writes through WithSession commit on success and roll back on failure.
	_, err = e.WithSession(ctx, "d", "c", "", false, true, func(ctx context.Context, _ *conn.Open, q query.Querier) (int, error) {
		q.ExecContext(ctx, "insert into t values (4, 'w')")
		return 1, errors.New("boom")
	})
	if err == nil || count(t, e, "b") != int64(3) {
		t.Fatal("failed auto batch should roll back")
	}
}
