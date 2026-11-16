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
func References(d Dialect, stmt string) []Reference {
	toks := lex(d, stmt)
	var out []Reference
	for i := 0; i+2 < len(toks); i++ {
		first, ok := nameToken(stmt, toks[i])
		if !ok {
			continue
		}
		dot := toks[i+1]
		if dot.kind != tPunct || dot.end-dot.start != 1 || stmt[dot.start] != '.' {
			continue
		}
		second, ok := nameToken(stmt, toks[i+2])
		if !ok {
			continue
		}
		out = append(out, Reference{Schema: first, Name: second})
	}
	return out
}

func nameToken(src string, t token) (string, bool) {
	if t.kind != tWord && t.kind != tQuoted {
		return "", false
	}
	return identifier(src[t.start:t.end])
}

// identifier returns the unquoted identifier a token stands for. String
// literals, dollar quotes and Oracle q-quotes are not identifiers.
func identifier(s string) (string, bool) {
	switch {
	case s == "":
		return "", false
	case s[0] == '"':
		return unquote(s, '"')
	case s[0] == '`':
		return unquote(s, '`')
	case s[0] == '\'' || s[0] == '$':
		return "", false
	}
	// Oracle q'…' literals and their Nq'…' / nq'…' forms are not identifiers.
	upper := strings.ToUpper(s)
	if strings.HasPrefix(upper, "Q'") || strings.HasPrefix(upper, "NQ'") {
		return "", false
	}
	// A bare word (possibly a prefixed literal, which the lexer keeps as one
	// token for E'…', N'…' and X'…'): only the plain form is a name.
	if strings.ContainsAny(s, "'") {
		return "", false
	}
	return s, true
}

func unquote(s string, q byte) (string, bool) {
	if len(s) < 2 || s[0] != q || s[len(s)-1] != q {
		return "", false
	}
	body := s[1 : len(s)-1]
	return strings.ReplaceAll(body, string([]byte{q, q}), string(q)), true
}
