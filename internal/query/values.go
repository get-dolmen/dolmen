package query

import (
	"encoding/hex"
	"fmt"
	"math"
	"strconv"
	"time"
	"unicode/utf8"
)

const maxSafeInt = 1<<53 - 1

// maxBinaryPreview bounds how many bytes of a binary value are sent to the UI.
const maxBinaryPreview = 4096

// Normalize turns a driver value into something JSON-safe and readable.
// NULL stays nil so the grid can render it distinctly.
func Normalize(v any) any {
	switch x := v.(type) {
	case nil:
		return nil
	case string, bool:
		return x
	case []byte:
		if utf8.Valid(x) {
			return string(x)
		}
		if len(x) > maxBinaryPreview {
			return "0x" + hex.EncodeToString(x[:maxBinaryPreview]) + fmt.Sprintf("… (%d bytes)", len(x))
		}
		return "0x" + hex.EncodeToString(x)
	case time.Time:
		return FormatTime(x)
	case int64:
		if x > maxSafeInt || x < -maxSafeInt {
			return strconv.FormatInt(x, 10)
		}
		return x
	case uint64:
		if x > maxSafeInt {
			return strconv.FormatUint(x, 10)
		}
		return x
	case int, int32, int16, int8, uint32, uint16, uint8:
		return x
	case float64:
		if math.IsNaN(x) || math.IsInf(x, 0) {
			return strconv.FormatFloat(x, 'g', -1, 64)
		}
		return x
	case float32:
		return Normalize(float64(x))
	case fmt.Stringer:
		return x.String()
	default:
		return fmt.Sprint(x)
	}
}

// FormatTime renders dates without a time part as plain dates.
func FormatTime(t time.Time) string {
	if t.Hour() == 0 && t.Minute() == 0 && t.Second() == 0 && t.Nanosecond() == 0 {
		return t.Format("2006-01-02")
	}
	if _, off := t.Zone(); off == 0 {
		return t.Format("2006-01-02 15:04:05.999999999")
	}
	return t.Format("2006-01-02 15:04:05.999999999 -07:00")
}
