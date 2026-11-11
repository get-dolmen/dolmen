package sqlsplit

import "fmt"

var readOnlyLeads = map[string]bool{
	"SELECT": true, "WITH": true, "EXPLAIN": true, "SHOW": true,
	"DESCRIBE": true, "DESC": true, "PRAGMA": true, "VALUES": true, "TABLE": true,
}

// Keywords that make a WITH statement data-modifying (Postgres/MySQL allow
// INSERT/UPDATE/DELETE in or after CTEs).
var writeWords = map[string]bool{
	"INSERT": true, "UPDATE": true, "DELETE": true, "MERGE": true, "UPSERT": true,
	"CREATE": true, "DROP": true, "ALTER": true, "TRUNCATE": true, "GRANT": true, "REVOKE": true,
}

// CheckReadOnly returns an error when a statement may modify data. It is the
// second line of defence; read-only connections are also protected at the
// session level by the driver.
func CheckReadOnly(d Dialect, stmt string) error {
	toks := lex(d, stmt)
	var lead string
	for _, t := range toks {
		if t.kind == tPunct && stmt[t.start] == '(' {
			continue
		}
		if t.kind == tWord {
			lead = t.word
		}
		break
	}
	if lead == "" {
		return fmt.Errorf("read-only connection: statement not allowed")
	}
	if !readOnlyLeads[lead] {
		return fmt.Errorf("read-only connection: %s statements are not allowed", lead)
	}
	switch lead {
	case "WITH":
		for _, t := range toks {
			if t.kind == tWord && writeWords[t.word] {
				return fmt.Errorf("read-only connection: WITH ... %s is not allowed", t.word)
			}
		}
	case "PRAGMA":
		for _, t := range toks {
			if t.kind == tPunct && stmt[t.start] == '=' {
				return fmt.Errorf("read-only connection: setting a PRAGMA is not allowed")
			}
		}
	}
	return nil
}

// ReturnsRows guesses whether a statement produces a result set, so DML can
// go through Exec and report affected rows.
func ReturnsRows(d Dialect, stmt string) bool {
	toks := lex(d, stmt)
	var lead string
	for _, t := range toks {
		if t.kind == tPunct && stmt[t.start] == '(' {
			continue
		}
		if t.kind == tWord {
			lead = t.word
		}
		break
	}
	hasWord := func(set map[string]bool) bool {
		for _, t := range toks {
			if t.kind == tWord && set[t.word] {
				return true
			}
		}
		return false
	}
	returning := d != Oracle && hasWord(map[string]bool{"RETURNING": true})
	if lead == "WITH" && hasWord(map[string]bool{"INSERT": true, "UPDATE": true, "DELETE": true, "MERGE": true}) {
		return returning
	}
	switch lead {
	case "SELECT", "WITH", "EXPLAIN", "SHOW", "DESCRIBE", "DESC", "PRAGMA", "VALUES", "TABLE", "CALL", "FETCH":
		return true
	}
	// INSERT/UPDATE/DELETE ... RETURNING produce rows on Postgres and SQLite.
	return returning
}

// TxControl classifies transaction-control statements so a manual-mode
// session can route them to its own transaction: "begin", "commit",
// "rollback", or "" for anything else (including ROLLBACK TO SAVEPOINT and
// Oracle PL/SQL blocks that start with BEGIN).
func TxControl(d Dialect, stmt string) string {
	var words []string
	for _, t := range lex(d, stmt) {
		if t.kind != tWord {
			return ""
		}
		words = append(words, t.word)
	}
	if len(words) == 0 {
		return ""
	}
	rest := words[1:]
	only := func(allowed ...string) bool {
		for _, w := range rest {
			ok := false
			for _, a := range allowed {
				ok = ok || w == a
			}
			if !ok {
				return false
			}
		}
		return true
	}
	switch words[0] {
	case "COMMIT":
		if only("WORK", "TRANSACTION") {
			return "commit"
		}
	case "END":
		if d == Postgres && only("WORK", "TRANSACTION") {
			return "commit"
		}
	case "ROLLBACK":
		if only("WORK", "TRANSACTION") {
			return "rollback"
		}
	case "BEGIN":
		if d != Oracle && only("WORK", "TRANSACTION", "DEFERRED", "IMMEDIATE", "EXCLUSIVE") {
			return "begin"
		}
	case "START":
		if len(rest) == 1 && rest[0] == "TRANSACTION" {
			return "begin"
		}
	}
	return ""
}
