package query

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"dolmen/internal/conn"
	"dolmen/internal/driver"
	"dolmen/internal/history"
)

func TestIdleTransactionsAreRolledBack(t *testing.T) {
	dir := t.TempDir()
	historyStore, err := history.Open(filepath.Join(dir, "history.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { historyStore.Close() })
	connections := conn.NewManager()
	t.Cleanup(connections.CloseAll)
	executor := NewExecutor(connections, historyStore)
	t.Cleanup(executor.Close)

	config := driver.Config{ID: "sqlite", Name: "sqlite", Kind: driver.SQLite, FilePath: filepath.Join(dir, "data.db")}
	if _, err := connections.Connect(context.Background(), config); err != nil {
		t.Fatal(err)
	}
	expired := make(chan TxExpired, 1)
	executor.SetTxExpiredHandler(func(event TxExpired) { expired <- event })

	// The table lives outside the transaction, the two rows inside it.
	if _, err := executor.Execute(ExecRequest{TabID: "tab", ConnID: "sqlite", SQL: "create table t (id integer)", Cursor: -1}); err != nil {
		t.Fatal(err)
	}
	response, err := executor.Execute(ExecRequest{
		TabID:  "tab",
		ConnID: "sqlite",
		SQL:    "insert into t values (1); insert into t values (2);",
		Cursor: -1,
		Manual: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !response.Tx.Open || response.Tx.Statements != 2 {
		t.Fatalf("want an open transaction with 2 statements, got %+v", response.Tx)
	}

	// A recently used transaction stays open.
	executor.expireIdleTransactions()
	if !executor.TxStatusOf("tab").Open {
		t.Fatal("a fresh transaction must not expire")
	}

	executor.mu.Lock()
	tabSession := executor.tabs["tab"]
	executor.mu.Unlock()
	tabSession.txLastUsed = time.Now().Add(-TxIdleTimeout - time.Minute)

	executor.expireIdleTransactions()
	if executor.TxStatusOf("tab").Open {
		t.Fatal("the idle transaction should have been rolled back")
	}
	select {
	case event := <-expired:
		if event.TabID != "tab" || event.Statements != 2 || event.TimeoutMs != TxIdleTimeout.Milliseconds() {
			t.Errorf("unexpected expiration event: %+v", event)
		}
	default:
		t.Fatal("the expiration should have been reported")
	}

	// The rows did not survive the rollback.
	response, err = executor.Execute(ExecRequest{TabID: "tab", ConnID: "sqlite", SQL: "select count(*) from t", Cursor: -1})
	if err != nil {
		t.Fatal(err)
	}
	if len(response.Results) != 1 || len(response.Results[0].Rows) != 1 || response.Results[0].Rows[0][0] != int64(0) {
		t.Fatalf("the insert should have been rolled back, got %+v", response.Results)
	}
}
