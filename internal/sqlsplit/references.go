package sqlsplit

import "strings"

// Reference is a schema-qualified name written explicitly in a statement,
// such as `public.orders` or `"Sales"."Orders"`.
//
// SQL resolves names with context (aliases, CTEs, functions, the session's
// search path), so this is not a complete resolver: it simply reports every
// `a.b` pair of identifiers. Callers use it to spot explicitly qualified
// schemas they must not touch.
type Reference struct {
	Schema string `json:"schema"`
	Name   string `json:"name"`
}

// References lists the schema-qualified identifiers of a statement. String
// literals and comments are ignored; column aliases such as `o.id` are
// reported too, and callers are expected to filter against known schemas.
func References(dialect Dialect, statement string) []Reference {
	tokens := lex(dialect, statement)
	var references []Reference
	for index := 0; index+2 < len(tokens); index++ {
		first, ok := nameToken(statement, tokens[index])
		if !ok {
			continue
		}
		dot := tokens[index+1]
		if dot.kind != tokenPunctuation || dot.end-dot.start != 1 || statement[dot.start] != '.' {
			continue
		}
		second, ok := nameToken(statement, tokens[index+2])
		if !ok {
			continue
		}
		references = append(references, Reference{Schema: first, Name: second})
	}
	return references
}

func nameToken(source string, item token) (string, bool) {
	if item.kind != tokenWord && item.kind != tokenQuoted {
		return "", false
	}
	return identifier(source[item.start:item.end])
}

// identifier returns the unquoted identifier a token stands for. String
// literals, dollar quotes and Oracle q-quotes are not identifiers.
func identifier(text string) (string, bool) {
	switch {
	case text == "":
		return "", false
	case text[0] == '"':
		return unquote(text, '"')
	case text[0] == '`':
		return unquote(text, '`')
	case text[0] == '\'' || text[0] == '$':
		return "", false
	}
	// Oracle q'…' literals and their Nq'…' / nq'…' forms are not identifiers.
	upper := strings.ToUpper(text)
	if strings.HasPrefix(upper, "Q'") || strings.HasPrefix(upper, "NQ'") {
		return "", false
	}
	// A bare word (possibly a prefixed literal, which the lexer keeps as one
	// token for E'…', N'…' and X'…'): only the plain form is a name.
	if strings.ContainsAny(text, "'") {
		return "", false
	}
	return text, true
}

func unquote(text string, quote byte) (string, bool) {
	if len(text) < 2 || text[0] != quote || text[len(text)-1] != quote {
		return "", false
	}
	body := text[1 : len(text)-1]
	return strings.ReplaceAll(body, string([]byte{quote, quote}), string(quote)), true
}
