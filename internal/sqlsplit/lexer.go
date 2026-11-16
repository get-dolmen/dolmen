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

func isIdentStart(character byte) bool {
	return character == '_' || (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') || character >= 0x80
}

func isIdentChar(character byte) bool {
	return isIdentStart(character) || (character >= '0' && character <= '9') || character == '$' || character == '#'
}

func isSpace(character byte) bool {
	return character == ' ' || character == '\t' || character == '\r' || character == '\n' || character == '\f'
}

// lex tokenizes source, dropping whitespace and comments.
func lex(dialect Dialect, source string) []token {
	var tokens []token
	length := len(source)
	lineStart := true // only whitespace seen since the last newline
	for index := 0; index < length; {
		character := source[index]
		switch {
		case character == '\n':
			lineStart = true
			index++
			continue
		case isSpace(character):
			index++
			continue
		case character == '-' && index+1 < length && source[index+1] == '-', character == '#' && dialect == MySQL:
			for index < length && source[index] != '\n' {
				index++
			}
			continue
		case character == '/' && index+1 < length && source[index+1] == '*':
			commentEnd := strings.Index(source[index+2:], "*/")
			if commentEnd < 0 {
				index = length
			} else {
				index += commentEnd + 4
			}
			continue
		}

		start := index
		wasLineStart := lineStart
		lineStart = false

		switch {
		case character == '/' && dialect == Oracle && wasLineStart && restOfLineBlank(source, index+1):
			lineEnd := index + 1
			for lineEnd < length && source[lineEnd] != '\n' {
				lineEnd++
			}
			tokens = append(tokens, token{kind: tokenSlashLine, start: start, end: lineEnd})
			index = lineEnd
		case character == ';':
			tokens = append(tokens, token{kind: tokenSemicolon, start: index, end: index + 1})
			index++
		case character == '\'':
			index = scanQuoted(source, index, '\'', backslashEscapes(dialect, source, index))
			tokens = append(tokens, token{kind: tokenQuoted, start: start, end: index})
		case character == '"':
			index = scanQuoted(source, index, '"', dialect == MySQL)
			tokens = append(tokens, token{kind: tokenQuoted, start: start, end: index})
		case character == '`' && dialect == MySQL:
			index = scanQuoted(source, index, '`', false)
			tokens = append(tokens, token{kind: tokenQuoted, start: start, end: index})
		case character == '$' && dialect == Postgres && (index == 0 || !isIdentChar(source[index-1])):
			if dollarEnd, ok := scanDollar(source, index); ok {
				index = dollarEnd
				tokens = append(tokens, token{kind: tokenQuoted, start: start, end: index})
			} else {
				tokens = append(tokens, token{kind: tokenPunctuation, start: index, end: index + 1})
				index++
			}
		case dialect == Oracle && isOracleQQuote(source, index):
			index = scanOracleQQuote(source, index)
			tokens = append(tokens, token{kind: tokenQuoted, start: start, end: index})
		case isIdentStart(character):
			for index < length && isIdentChar(source[index]) {
				index++
			}
			// E'...' (Postgres) / N'...' / X'...' prefixes become part of the literal.
			if index < length && source[index] == '\'' && index-start == 1 {
				index = scanQuoted(source, index, '\'', backslashEscapes(dialect, source, index))
				tokens = append(tokens, token{kind: tokenQuoted, start: start, end: index})
				continue
			}
			tokens = append(tokens, token{kind: tokenWord, start: start, end: index, word: strings.ToUpper(source[start:index])})
		default:
			tokens = append(tokens, token{kind: tokenPunctuation, start: index, end: index + 1})
			index++
		}
	}
	return tokens
}

func restOfLineBlank(source string, index int) bool {
	for ; index < len(source) && source[index] != '\n'; index++ {
		if !isSpace(source[index]) {
			return false
		}
	}
	return true
}

// backslashEscapes reports whether the quote at index is a string where
// backslash escapes the next character.
func backslashEscapes(dialect Dialect, source string, index int) bool {
	if dialect == MySQL {
		return true
	}
	if dialect == Postgres && index > 0 && (source[index-1] == 'E' || source[index-1] == 'e') {
		return index < 2 || !isIdentChar(source[index-2])
	}
	return false
}

// scanQuoted returns the offset just past the closing quote. Doubled quotes
// are an escape in every dialect.
func scanQuoted(source string, index int, quote byte, backslash bool) int {
	length := len(source)
	for index++; index < length; index++ {
		switch source[index] {
		case '\\':
			if backslash {
				index++
			}
		case quote:
			if index+1 < length && source[index+1] == quote {
				index++
				continue
			}
			return index + 1
		}
	}
	return length
}

// scanDollar handles Postgres $tag$ ... $tag$ strings.
func scanDollar(source string, index int) (int, bool) {
	tagEnd := index + 1
	for tagEnd < len(source) && source[tagEnd] != '$' {
		if !isIdentChar(source[tagEnd]) || source[tagEnd] == '$' || (tagEnd == index+1 && source[tagEnd] >= '0' && source[tagEnd] <= '9') {
			return 0, false
		}
		tagEnd++
	}
	if tagEnd >= len(source) {
		return 0, false
	}
	tag := source[index : tagEnd+1]
	bodyEnd := strings.Index(source[tagEnd+1:], tag)
	if bodyEnd < 0 {
		return len(source), true
	}
	return tagEnd + 1 + bodyEnd + len(tag), true
}

func isOracleQQuote(source string, index int) bool {
	if index > 0 && isIdentChar(source[index-1]) {
		return false
	}
	cursor := index
	if cursor < len(source) && (source[cursor] == 'n' || source[cursor] == 'N') {
		cursor++
	}
	return cursor+2 < len(source) && (source[cursor] == 'q' || source[cursor] == 'Q') && source[cursor+1] == '\''
}

func scanOracleQQuote(source string, index int) int {
	cursor := index
	if source[cursor] == 'n' || source[cursor] == 'N' {
		cursor++
	}
	opener := source[cursor+2]
	closer := opener
	switch opener {
	case '[':
		closer = ']'
	case '(':
		closer = ')'
	case '{':
		closer = '}'
	case '<':
		closer = '>'
	}
	end := strings.Index(source[cursor+3:], string(closer)+"'")
	if end < 0 {
		return len(source)
	}
	return cursor + 3 + end + 2
}
