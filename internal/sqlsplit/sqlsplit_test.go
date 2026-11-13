package sqlsplit

import (
	"reflect"
	"testing"
)

func texts(st []Statement) []string {
	out := make([]string, len(st))
	for i, s := range st {
		out[i] = s.Text
	}
	return out
}

func TestSplit(t *testing.T) {
	cases := []struct {
		name string
		d    Dialect
		src  string
		want []string
	}{
		{"basic", Postgres, "select 1; select 2;", []string{"select 1", "select 2"}},
		{"no trailing semi", Postgres, "select 1;\n\nselect 2", []string{"select 1", "select 2"}},
		{"empty statements and comments", Postgres, ";; -- hi\n/* x; */ select 1 ; -- tail", []string{"select 1"}},
		{"semicolon in string", Postgres, "select 'a;b', 'it''s;'; select 2", []string{"select 'a;b', 'it''s;'", "select 2"}},
		{"quoted identifier", Postgres, `select "a;b" from t; select 2`, []string{`select "a;b" from t`, "select 2"}},
		{"dollar quote", Postgres, "create function f() returns int as $body$ begin; return 1; end; $body$ language plpgsql; select 1",
			[]string{"create function f() returns int as $body$ begin; return 1; end; $body$ language plpgsql", "select 1"}},
		{"pg escape string", Postgres, `select E'a\';b'; select 2`, []string{`select E'a\';b'`, "select 2"}},
		{"pg positional param not dollar quote", Postgres, "select $1; select 2", []string{"select $1", "select 2"}},
		{"mysql backslash + backtick + hash", MySQL, "select 'a\\';b', `c;d` # x;y\n; select 2",
			[]string{"select 'a\\';b', `c;d`", "select 2"}},
		{"oracle plsql block", Oracle, "begin\n  null;\n  dbms_output.put_line('x');\nend;\n/\nselect 1 from dual;",
			[]string{"begin\n  null;\n  dbms_output.put_line('x');\nend;", "select 1 from dual"}},
		{"oracle create or replace procedure", Oracle, "create or replace procedure p as begin null; end;\n/\nselect 1 from dual",
			[]string{"create or replace procedure p as begin null; end;", "select 1 from dual"}},
		{"oracle slash after plain statement", Oracle, "select 1 from dual\n/\nselect 2 from dual", []string{"select 1 from dual", "select 2 from dual"}},
		{"oracle division is not terminator", Oracle, "select 4\n/ 2 from dual", []string{"select 4\n/ 2 from dual"}},
		{"oracle q-quote", Oracle, "select q'[a;']b]' from dual; select 2 from dual", []string{"select q'[a;']b]' from dual", "select 2 from dual"}},
		{"oracle create table is plain", Oracle, "create table t (a number); select 1 from dual", []string{"create table t (a number)", "select 1 from dual"}},
		{"sqlite trigger", SQLite, "create trigger tr after insert on t begin update x set a = 1; delete from y; end; select 1",
			[]string{"create trigger tr after insert on t begin update x set a = 1; delete from y; end", "select 1"}},
		{"unicode", Postgres, "select 'é;😀'; select 2", []string{"select 'é;😀'", "select 2"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := texts(Split(c.d, c.src))
			if !reflect.DeepEqual(got, c.want) {
				t.Fatalf("got %q\nwant %q", got, c.want)
			}
		})
	}
}

func TestAtCursor(t *testing.T) {
	src := "select 1;\n\nselect 2;\nselect 3"
	st := Split(Postgres, src)
	at := func(c int) string { s, _ := AtCursor(st, c); return s.Text }
	if got := at(0); got != "select 1" {
		t.Errorf("cursor 0: %q", got)
	}
	if got := at(9); got != "select 1" { // just after the ;
		t.Errorf("after semi: %q", got)
	}
	if got := at(10); got != "select 1" { // blank line
		t.Errorf("blank line: %q", got)
	}
	if got := at(13); got != "select 2" {
		t.Errorf("in second: %q", got)
	}
	if got := at(len(src)); got != "select 3" {
		t.Errorf("end: %q", got)
	}
}

func TestUTF16ToByteOffset(t *testing.T) {
	s := "a😀é b"
	// JS: a=1 unit, 😀=2 units, é=1 unit
	for u16, want := range map[int]int{0: 0, 1: 1, 3: 5, 4: 7, 5: 8, 99: len(s)} {
		if got := UTF16ToByteOffset(s, u16); got != want {
			t.Errorf("UTF16ToByteOffset(%d) = %d, want %d", u16, got, want)
		}
	}
}

func TestCheckReadOnly(t *testing.T) {
	allowed := []string{
		"select * from t",
		"  -- comment\n SELECT 1",
		"(select 1) union (select 2)",
		"with x as (select 1) select * from x",
		"explain select 1",
		"show tables",
		"describe t",
		"pragma table_info(t)",
		"values (1)",
		"select * from t where note = 'delete me'",
		"select 1 for update",
	}
	for _, s := range allowed {
		if err := CheckReadOnly(Postgres, s); err != nil {
			t.Errorf("%q should be allowed: %v", s, err)
		}
	}
	rejected := []string{
		"insert into t values (1)",
		"update t set a = 1",
		"delete from t",
		"drop table t",
		"create table t (a int)",
		"truncate t",
		"with x as (delete from t returning *) select * from x",
		"with x as (select 1) update t set a = 1",
		"pragma journal_mode = wal",
		"begin",
		"/* only a comment */",
	}
	for _, s := range rejected {
		if err := CheckReadOnly(Postgres, s); err == nil {
			t.Errorf("%q should be rejected", s)
		}
	}
}

func TestReturnsRows(t *testing.T) {
	yes := []string{"select 1", "with a as (select 1) select * from a", "insert into t values (1) returning id", "show tables", "with x as (delete from t returning *) select * from x"}
	no := []string{"with x as (select 1) insert into t select * from x", "insert into t values (1)", "update t set a = 1", "create table t (a int)"}
	for _, s := range yes {
		if !ReturnsRows(Postgres, s) {
			t.Errorf("%q should return rows", s)
		}
	}
	for _, s := range no {
		if ReturnsRows(Postgres, s) {
			t.Errorf("%q should not return rows", s)
		}
	}
}

func TestTxControl(t *testing.T) {
	cases := []struct {
		d    Dialect
		stmt string
		want string
	}{
		{Postgres, "commit", "commit"},
		{Postgres, "COMMIT WORK", "commit"},
		{Postgres, "end", "commit"},
		{MySQL, "end", ""},
		{Postgres, "rollback", "rollback"},
		{Postgres, "rollback to savepoint a", ""},
		{Postgres, "begin", "begin"},
		{SQLite, "begin immediate", "begin"},
		{MySQL, "start transaction", "begin"},
		{Oracle, "begin", ""},
		{Oracle, "begin null; end;", ""},
		{Postgres, "select 1", ""},
		{Postgres, "-- note\ncommit", "commit"},
	}
	for _, c := range cases {
		if got := TxControl(c.d, c.stmt); got != c.want {
			t.Errorf("TxControl(%s, %q) = %q, want %q", c.d, c.stmt, got, c.want)
		}
	}
}

func TestByteToUTF16Offset(t *testing.T) {
	s := "é😀a"
	for _, c := range []struct{ b, u16 int }{{0, 0}, {2, 1}, {6, 3}, {7, 4}, {99, 4}} {
		if got := ByteToUTF16Offset(s, c.b); got != c.u16 {
			t.Errorf("ByteToUTF16Offset(%d) = %d, want %d", c.b, got, c.u16)
		}
	}
}
