// Package sqlsplit splits SQL scripts into statements and classifies them,
// with enough dialect awareness for Postgres, MySQL, Oracle and SQLite.
package sqlsplit

import "strings"

// Dialect selects lexer rules.
type Dialect string

const (
	Postgres Dialect = "postgres"
	MySQL    Dialect = "mysql"
	Oracle   Dialect = "oracle"
	SQLite   Dialect = "sqlite"
)

type tokenKind int

const (
	tokenWord        tokenKind = iota // keyword or bare identifier (Word is upper-cased)
	tokenQuoted                       // string literal or quoted identifier
	tokenSemicolon                    // ;
	tokenSlashLine                    // Oracle "/" alone on its line
	tokenPunctuation                  // any other character
)

type token struct {
	kind       tokenKind
	start, end int // byte offsets in source
	word       string
}

func isIdentStart(c byte) bool {
	return c == '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c >= 0x80
}

func isIdentChar(c byte) bool {
	return isIdentStart(c) || (c >= '0' && c <= '9') || c == '$' || c == '#'
}

func isSpace(c byte) bool { return c == ' ' || c == '\t' || c == '\r' || c == '\n' || c == '\f' }

// lex tokenizes source, dropping whitespace and comments.
func lex(dialect Dialect, source string) []token {
	var tokens []token
	n := len(source)
	lineStart := true // only whitespace seen since the last newline
	for i := 0; i < n; {
		c := source[i]
		switch {
		case c == '\n':
			lineStart = true
			i++
			continue
		case isSpace(c):
			i++
			continue
		case c == '-' && i+1 < n && source[i+1] == '-', c == '#' && dialect == MySQL:
			for i < n && source[i] != '\n' {
				i++
			}
			continue
		case c == '/' && i+1 < n && source[i+1] == '*':
			end := strings.Index(source[i+2:], "*/")
			if end < 0 {
				i = n
			} else {
				i += end + 4
			}
			continue
		}

		start := i
		wasLineStart := lineStart
		lineStart = false

		switch {
		case c == '/' && dialect == Oracle && wasLineStart && restOfLineBlank(source, i+1):
			j := i + 1
			for j < n && source[j] != '\n' {
				j++
			}
			tokens = append(tokens, token{kind: tokenSlashLine, start: start, end: j})
			i = j
		case c == ';':
			tokens = append(tokens, token{kind: tokenSemicolon, start: i, end: i + 1})
			i++
		case c == '\'':
			i = scanQuoted(source, i, '\'', backslashEscapes(dialect, source, i))
			tokens = append(tokens, token{kind: tokenQuoted, start: start, end: i})
		case c == '"':
			i = scanQuoted(source, i, '"', dialect == MySQL)
			tokens = append(tokens, token{kind: tokenQuoted, start: start, end: i})
		case c == '`' && dialect == MySQL:
			i = scanQuoted(source, i, '`', false)
			tokens = append(tokens, token{kind: tokenQuoted, start: start, end: i})
		case c == '$' && dialect == Postgres && (i == 0 || !isIdentChar(source[i-1])):
			if end, ok := scanDollar(source, i); ok {
				i = end
				tokens = append(tokens, token{kind: tokenQuoted, start: start, end: i})
			} else {
				tokens = append(tokens, token{kind: tokenPunctuation, start: i, end: i + 1})
				i++
			}
		case dialect == Oracle && isOracleQQuote(source, i):
			i = scanOracleQQuote(source, i)
			tokens = append(tokens, token{kind: tokenQuoted, start: start, end: i})
		case isIdentStart(c):
			for i < n && isIdentChar(source[i]) {
				i++
			}
			// E'...' (Postgres) / N'...' / X'...' prefixes become part of the literal.
			if i < n && source[i] == '\'' && i-start == 1 {
				i = scanQuoted(source, i, '\'', backslashEscapes(dialect, source, i))
				tokens = append(tokens, token{kind: tokenQuoted, start: start, end: i})
				continue
			}
			tokens = append(tokens, token{kind: tokenWord, start: start, end: i, word: strings.ToUpper(source[start:i])})
		default:
			tokens = append(tokens, token{kind: tokenPunctuation, start: i, end: i + 1})
			i++
		}
	}
	return tokens
}

func restOfLineBlank(source string, i int) bool {
	for ; i < len(source) && source[i] != '\n'; i++ {
		if !isSpace(source[i]) {
			return false
		}
	}
	return true
}

// backslashEscapes reports whether the quote at i is a string where
// backslash escapes the next character.
func backslashEscapes(dialect Dialect, source string, i int) bool {
	if dialect == MySQL {
		return true
	}
	if dialect == Postgres && i > 0 && (source[i-1] == 'E' || source[i-1] == 'e') {
		return i < 2 || !isIdentChar(source[i-2])
	}
	return false
}

// scanQuoted returns the offset just past the closing quote. Doubled quotes
// are an escape in every dialect.
func scanQuoted(source string, i int, q byte, backslash bool) int {
	n := len(source)
	for i++; i < n; i++ {
		switch source[i] {
		case '\\':
			if backslash {
				i++
			}
		case q:
			if i+1 < n && source[i+1] == q {
				i++
				continue
			}
			return i + 1
		}
	}
	return n
}

// scanDollar handles Postgres $tag$ ... $tag$ strings.
func scanDollar(source string, i int) (int, bool) {
	j := i + 1
	for j < len(source) && source[j] != '$' {
		if !isIdentChar(source[j]) || source[j] == '$' || (j == i+1 && source[j] >= '0' && source[j] <= '9') {
			return 0, false
		}
		j++
	}
	if j >= len(source) {
		return 0, false
	}
	tag := source[i : j+1]
	end := strings.Index(source[j+1:], tag)
	if end < 0 {
		return len(source), true
	}
	return j + 1 + end + len(tag), true
}

func isOracleQQuote(source string, i int) bool {
	if i > 0 && isIdentChar(source[i-1]) {
		return false
	}
	j := i
	if j < len(source) && (source[j] == 'n' || source[j] == 'N') {
		j++
	}
	return j+2 < len(source) && (source[j] == 'q' || source[j] == 'Q') && source[j+1] == '\''
}

func scanOracleQQuote(source string, i int) int {
	j := i
	if source[j] == 'n' || source[j] == 'N' {
		j++
	}
	open := source[j+2]
	closing := open
	switch open {
	case '[':
		closing = ']'
	case '(':
		closing = ')'
	case '{':
		closing = '}'
	case '<':
		closing = '>'
	}
	end := strings.Index(source[j+3:], string(closing)+"'")
	if end < 0 {
		return len(source)
	}
	return j + 3 + end + 2
}
