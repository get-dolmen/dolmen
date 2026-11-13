package sqlsplit

// Statement is one executable statement of a script.
type Statement struct {
	Text  string `json:"text"`
	Start int    `json:"start"` // byte offset of the first token
	End   int    `json:"end"`   // byte offset just past the terminator (or the last token)
}

type blockMode int

const (
	modeNormal  blockMode = iota
	modePLSQL             // Oracle anonymous blocks and stored code: ends at "/"
	modeTrigger           // SQLite CREATE TRIGGER: ends at "END;"
)

// Split breaks src into statements. Terminators are not part of Text, except
// that PL/SQL blocks keep their final "END;".
func Split(d Dialect, src string) []Statement {
	toks := lex(d, src)
	var out []Statement
	first, last := -1, -1 // token indexes of the current statement
	var words []string    // leading words, used to detect block statements
	mode := modeNormal

	emit := func(termEnd int) {
		if first >= 0 {
			out = append(out, Statement{
				Text:  src[toks[first].start:toks[last].end],
				Start: toks[first].start,
				End:   termEnd,
			})
		}
		first, last, words, mode = -1, -1, nil, modeNormal
	}

	for i, t := range toks {
		switch t.kind {
		case tSlashLine:
			emit(t.end)
			continue
		case tSemi:
			switch mode {
			case modeNormal:
				emit(t.end)
				continue
			case modeTrigger:
				if last >= 0 && toks[last].kind == tWord && toks[last].word == "END" {
					emit(t.end)
					continue
				}
			}
		}
		if first < 0 {
			first = i
		}
		last = i
		if t.kind == tWord && len(words) < 6 {
			words = append(words, t.word)
			mode = detectMode(d, words, mode)
		}
	}
	if first >= 0 {
		emit(toks[last].end)
	}
	return out
}

func detectMode(d Dialect, w []string, cur blockMode) blockMode {
	if cur != modeNormal {
		return cur
	}
	switch d {
	case Oracle:
		if w[0] == "DECLARE" || w[0] == "BEGIN" {
			return modePLSQL
		}
		if w[0] != "CREATE" {
			return modeNormal
		}
		for _, x := range w[1:] {
			switch x {
			case "OR", "REPLACE", "EDITIONABLE", "NONEDITIONABLE", "EDITIONING":
				continue
			case "PROCEDURE", "FUNCTION", "PACKAGE", "TRIGGER", "TYPE", "LIBRARY", "JAVA":
				return modePLSQL
			}
			return modeNormal
		}
	case SQLite:
		if w[0] != "CREATE" {
			return modeNormal
		}
		for _, x := range w[1:] {
			switch x {
			case "TEMP", "TEMPORARY":
				continue
			case "TRIGGER":
				return modeTrigger
			}
			return modeNormal
		}
	}
	return modeNormal
}

// AtCursor picks the statement containing the cursor (a byte offset), or
// else the closest one before it, or else the first one after it.
func AtCursor(stmts []Statement, cursor int) (Statement, bool) {
	var prev *Statement
	for i := range stmts {
		s := &stmts[i]
		if cursor >= s.Start && cursor <= s.End {
			return *s, true
		}
		if s.End < cursor {
			prev = s
		}
	}
	if prev != nil {
		return *prev, true
	}
	if len(stmts) > 0 {
		return stmts[0], true
	}
	return Statement{}, false
}

// UTF16ToByteOffset converts a JavaScript string offset into a byte offset.
func UTF16ToByteOffset(s string, u16 int) int {
	units := 0
	for i, r := range s {
		if units >= u16 {
			return i
		}
		if r >= 0x10000 {
			units += 2
		} else {
			units++
		}
	}
	return len(s)
}

// ByteToUTF16Offset converts a byte offset into a JavaScript string offset.
func ByteToUTF16Offset(s string, b int) int {
	units := 0
	for i, r := range s {
		if i >= b {
			break
		}
		if r >= 0x10000 {
			units += 2
		} else {
			units++
		}
	}
	return units
}
