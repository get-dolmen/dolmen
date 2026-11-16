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
func Normalize(value any) any {
	switch converted := value.(type) {
	case nil:
		return nil
	case string, bool:
		return converted
	case []byte:
		if utf8.Valid(converted) {
			return string(converted)
		}
		if len(converted) > maxBinaryPreview {
			return "0x" + hex.EncodeToString(converted[:maxBinaryPreview]) + fmt.Sprintf("… (%d bytes)", len(converted))
		}
		return "0x" + hex.EncodeToString(converted)
	case time.Time:
		return FormatTime(converted)
	case int64:
		if converted > maxSafeInt || converted < -maxSafeInt {
			return strconv.FormatInt(converted, 10)
		}
		return converted
	case uint64:
		if converted > maxSafeInt {
			return strconv.FormatUint(converted, 10)
		}
		return converted
	case int, int32, int16, int8, uint32, uint16, uint8:
		return converted
	case float64:
		if math.IsNaN(converted) || math.IsInf(converted, 0) {
			return strconv.FormatFloat(converted, 'g', -1, 64)
		}
		return converted
	case float32:
		return Normalize(float64(converted))
	case fmt.Stringer:
		return converted.String()
	default:
		return fmt.Sprint(converted)
	}
}

// FormatTime renders dates without a time part as plain dates.
func FormatTime(moment time.Time) string {
	if moment.Hour() == 0 && moment.Minute() == 0 && moment.Second() == 0 && moment.Nanosecond() == 0 {
		return moment.Format("2006-01-02")
	}
	if _, offset := moment.Zone(); offset == 0 {
		return moment.Format("2006-01-02 15:04:05.999999999")
	}
	return moment.Format("2006-01-02 15:04:05.999999999 -07:00")
}
