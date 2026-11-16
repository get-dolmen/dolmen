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

// Split breaks source into statements. Terminators are not part of Text, except
// that PL/SQL blocks keep their final "END;".
func Split(dialect Dialect, source string) []Statement {
	tokens := lex(dialect, source)
	var statements []Statement
	first, last := -1, -1     // token indexes of the current statement
	var leadingWords []string // leading words, used to detect block statements
	mode := modeNormal

	emit := func(terminatorEnd int) {
		if first >= 0 {
			statements = append(statements, Statement{
				Text:  source[tokens[first].start:tokens[last].end],
				Start: tokens[first].start,
				End:   terminatorEnd,
			})
		}
		first, last, leadingWords, mode = -1, -1, nil, modeNormal
	}

	for index, token := range tokens {
		switch token.kind {
		case tokenSlashLine:
			emit(token.end)
			continue
		case tokenSemicolon:
			switch mode {
			case modeNormal:
				emit(token.end)
				continue
			case modeTrigger:
				if last >= 0 && tokens[last].kind == tokenWord && tokens[last].word == "END" {
					emit(token.end)
					continue
				}
			}
		}
		if first < 0 {
			first = index
		}
		last = index
		if token.kind == tokenWord && len(leadingWords) < 6 {
			leadingWords = append(leadingWords, token.word)
			mode = detectMode(dialect, leadingWords, mode)
		}
	}
	if first >= 0 {
		emit(tokens[last].end)
	}
	return statements
}

func detectMode(dialect Dialect, leadingWords []string, current blockMode) blockMode {
	if current != modeNormal {
		return current
	}
	switch dialect {
	case Oracle:
		if leadingWords[0] == "DECLARE" || leadingWords[0] == "BEGIN" {
			return modePLSQL
		}
		if leadingWords[0] != "CREATE" {
			return modeNormal
		}
		for _, word := range leadingWords[1:] {
			switch word {
			case "OR", "REPLACE", "EDITIONABLE", "NONEDITIONABLE", "EDITIONING":
				continue
			case "PROCEDURE", "FUNCTION", "PACKAGE", "TRIGGER", "TYPE", "LIBRARY", "JAVA":
				return modePLSQL
			}
			return modeNormal
		}
	case SQLite:
		if leadingWords[0] != "CREATE" {
			return modeNormal
		}
		for _, word := range leadingWords[1:] {
			switch word {
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
func AtCursor(statements []Statement, cursor int) (Statement, bool) {
	var previous *Statement
	for index := range statements {
		statement := &statements[index]
		if cursor >= statement.Start && cursor <= statement.End {
			return *statement, true
		}
		if statement.End < cursor {
			previous = statement
		}
	}
	if previous != nil {
		return *previous, true
	}
	if len(statements) > 0 {
		return statements[0], true
	}
	return Statement{}, false
}

// UTF16ToByteOffset converts a JavaScript string offset into a byte offset.
func UTF16ToByteOffset(source string, offset int) int {
	units := 0
	for index, character := range source {
		if units >= offset {
			return index
		}
		if character >= 0x10000 {
			units += 2
		} else {
			units++
		}
	}
	return len(source)
}

// ByteToUTF16Offset converts a byte offset into a JavaScript string offset.
func ByteToUTF16Offset(source string, byteOffset int) int {
	units := 0
	for index, character := range source {
		if index >= byteOffset {
			break
		}
		if character >= 0x10000 {
			units += 2
		} else {
			units++
		}
	}
	return units
}
