package sqlsplit

import (
	"fmt"
	"slices"
)

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

// Words signalling that a statement produces rows: RETURNING for DML, and the
// data-modifying keywords allowed inside a WITH.
var (
	returningWords = map[string]bool{"RETURNING": true}
	cteWriteWords  = map[string]bool{"INSERT": true, "UPDATE": true, "DELETE": true, "MERGE": true}
)

// leadingWord returns the first keyword of a statement, ignoring opening
// parentheses, or "" when the statement does not start with a word.
func leadingWord(tokens []token, statement string) string {
	for _, token := range tokens {
		if token.kind == tokenPunctuation && statement[token.start] == '(' {
			continue
		}
		if token.kind == tokenWord {
			return token.word
		}
		break
	}
	return ""
}

// containsWord reports whether one of the statement's keywords is in set.
func containsWord(tokens []token, set map[string]bool) bool {
	for _, token := range tokens {
		if token.kind == tokenWord && set[token.word] {
			return true
		}
	}
	return false
}

// CheckReadOnly returns an error when a statement may modify data. It is the
// second line of defence; read-only connections are also protected at the
// session level by the driver.
func CheckReadOnly(dialect Dialect, statement string) error {
	tokens := lex(dialect, statement)
	lead := leadingWord(tokens, statement)
	if lead == "" {
		return fmt.Errorf("read-only connection: statement not allowed")
	}
	if !readOnlyLeads[lead] {
		return fmt.Errorf("read-only connection: %s statements are not allowed", lead)
	}
	switch lead {
	case "WITH":
		for _, token := range tokens {
			if token.kind == tokenWord && writeWords[token.word] {
				return fmt.Errorf("read-only connection: WITH ... %s is not allowed", token.word)
			}
		}
	case "PRAGMA":
		for _, token := range tokens {
			if token.kind == tokenPunctuation && statement[token.start] == '=' {
				return fmt.Errorf("read-only connection: setting a PRAGMA is not allowed")
			}
		}
	}
	return nil
}

// ReturnsRows guesses whether a statement produces a result set, so DML can
// go through Exec and report affected rows.
func ReturnsRows(dialect Dialect, statement string) bool {
	tokens := lex(dialect, statement)
	lead := leadingWord(tokens, statement)
	returning := dialect != Oracle && containsWord(tokens, returningWords)
	if lead == "WITH" && containsWord(tokens, cteWriteWords) {
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
func TxControl(dialect Dialect, statement string) string {
	var words []string
	for _, token := range lex(dialect, statement) {
		if token.kind != tokenWord {
			return ""
		}
		words = append(words, token.word)
	}
	if len(words) == 0 {
		return ""
	}
	rest := words[1:]
	only := func(allowed ...string) bool {
		for _, word := range rest {
			if !slices.Contains(allowed, word) {
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
		if dialect == Postgres && only("WORK", "TRANSACTION") {
			return "commit"
		}
	case "ROLLBACK":
		if only("WORK", "TRANSACTION") {
			return "rollback"
		}
	case "BEGIN":
		if dialect != Oracle && only("WORK", "TRANSACTION", "DEFERRED", "IMMEDIATE", "EXCLUSIVE") {
			return "begin"
		}
	case "START":
		if len(rest) == 1 && rest[0] == "TRANSACTION" {
			return "begin"
		}
	}
	return ""
}
