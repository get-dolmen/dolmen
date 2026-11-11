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

type tokKind int

const (
	tWord      tokKind = iota // keyword or bare identifier (Word is upper-cased)
	tQuoted                   // string literal or quoted identifier
	tSemi                     // ;
	tSlashLine                // Oracle "/" alone on its line
	tPunct                    // any other character
)

type token struct {
	kind       tokKind
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

// lex tokenizes src, dropping whitespace and comments.
func lex(d Dialect, src string) []token {
	var toks []token
	n := len(src)
	lineStart := true // only whitespace seen since the last newline
	for i := 0; i < n; {
		c := src[i]
		switch {
		case c == '\n':
			lineStart = true
			i++
			continue
		case isSpace(c):
			i++
			continue
		case c == '-' && i+1 < n && src[i+1] == '-', c == '#' && d == MySQL:
			for i < n && src[i] != '\n' {
				i++
			}
			continue
		case c == '/' && i+1 < n && src[i+1] == '*':
			end := strings.Index(src[i+2:], "*/")
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
		case c == '/' && d == Oracle && wasLineStart && restOfLineBlank(src, i+1):
			j := i + 1
			for j < n && src[j] != '\n' {
				j++
			}
			toks = append(toks, token{kind: tSlashLine, start: start, end: j})
			i = j
		case c == ';':
			toks = append(toks, token{kind: tSemi, start: i, end: i + 1})
			i++
		case c == '\'':
			i = scanQuoted(src, i, '\'', backslashEscapes(d, src, i))
			toks = append(toks, token{kind: tQuoted, start: start, end: i})
		case c == '"':
			i = scanQuoted(src, i, '"', d == MySQL)
			toks = append(toks, token{kind: tQuoted, start: start, end: i})
		case c == '`' && d == MySQL:
			i = scanQuoted(src, i, '`', false)
			toks = append(toks, token{kind: tQuoted, start: start, end: i})
		case c == '$' && d == Postgres && (i == 0 || !isIdentChar(src[i-1])):
			if end, ok := scanDollar(src, i); ok {
				i = end
				toks = append(toks, token{kind: tQuoted, start: start, end: i})
			} else {
				toks = append(toks, token{kind: tPunct, start: i, end: i + 1})
				i++
			}
		case d == Oracle && isOracleQQuote(src, i):
			i = scanOracleQQuote(src, i)
			toks = append(toks, token{kind: tQuoted, start: start, end: i})
		case isIdentStart(c):
			for i < n && isIdentChar(src[i]) {
				i++
			}
			// E'...' (Postgres) / N'...' / X'...' prefixes become part of the literal.
			if i < n && src[i] == '\'' && i-start == 1 {
				i = scanQuoted(src, i, '\'', backslashEscapes(d, src, i))
				toks = append(toks, token{kind: tQuoted, start: start, end: i})
				continue
			}
			toks = append(toks, token{kind: tWord, start: start, end: i, word: strings.ToUpper(src[start:i])})
		default:
			toks = append(toks, token{kind: tPunct, start: i, end: i + 1})
			i++
		}
	}
	return toks
}

func restOfLineBlank(src string, i int) bool {
	for ; i < len(src) && src[i] != '\n'; i++ {
		if !isSpace(src[i]) {
			return false
		}
	}
	return true
}

// backslashEscapes reports whether the quote at i is a string where
// backslash escapes the next character.
func backslashEscapes(d Dialect, src string, i int) bool {
	if d == MySQL {
		return true
	}
	if d == Postgres && i > 0 && (src[i-1] == 'E' || src[i-1] == 'e') {
		return i < 2 || !isIdentChar(src[i-2])
	}
	return false
}

// scanQuoted returns the offset just past the closing quote. Doubled quotes
// are an escape in every dialect.
func scanQuoted(src string, i int, q byte, backslash bool) int {
	n := len(src)
	for i++; i < n; i++ {
		switch src[i] {
		case '\\':
			if backslash {
				i++
			}
		case q:
			if i+1 < n && src[i+1] == q {
				i++
				continue
			}
			return i + 1
		}
	}
	return n
}

// scanDollar handles Postgres $tag$ ... $tag$ strings.
func scanDollar(src string, i int) (int, bool) {
	j := i + 1
	for j < len(src) && src[j] != '$' {
		if !isIdentChar(src[j]) || src[j] == '$' || (j == i+1 && src[j] >= '0' && src[j] <= '9') {
			return 0, false
		}
		j++
	}
	if j >= len(src) {
		return 0, false
	}
	tag := src[i : j+1]
	end := strings.Index(src[j+1:], tag)
	if end < 0 {
		return len(src), true
	}
	return j + 1 + end + len(tag), true
}

func isOracleQQuote(src string, i int) bool {
	if i > 0 && isIdentChar(src[i-1]) {
		return false
	}
	j := i
	if j < len(src) && (src[j] == 'n' || src[j] == 'N') {
		j++
	}
	return j+2 < len(src) && (src[j] == 'q' || src[j] == 'Q') && src[j+1] == '\''
}

func scanOracleQQuote(src string, i int) int {
	j := i
	if src[j] == 'n' || src[j] == 'N' {
		j++
	}
	open := src[j+2]
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
	end := strings.Index(src[j+3:], string(closing)+"'")
	if end < 0 {
		return len(src)
	}
	return j + 3 + end + 2
}
