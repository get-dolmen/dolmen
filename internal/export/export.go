// Package export writes result sets to CSV or JSON files.
package export

import (
	"bufio"
	"bytes"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strconv"

	"dolmen/internal/query"
)

type Format string

const (
	CSV  Format = "csv"
	JSON Format = "json"
)

// Source streams a result: it calls header once, then row for each row.
type Source func(header func([]query.Column) error, row func([]any) error) error

// ToFile writes src to path and returns the number of rows written.
func ToFile(path string, f Format, src Source) (int64, error) {
	file, err := os.Create(path)
	if err != nil {
		return 0, err
	}
	n, werr := Write(file, f, src)
	if cerr := file.Close(); werr == nil {
		werr = cerr
	}
	return n, werr
}

func Write(w io.Writer, f Format, src Source) (int64, error) {
	bw := bufio.NewWriterSize(w, 64<<10)
	var n int64
	var err error
	switch f {
	case CSV:
		n, err = writeCSV(bw, src)
	case JSON:
		n, err = writeJSON(bw, src)
	default:
		return 0, fmt.Errorf("unknown export format %q", f)
	}
	if ferr := bw.Flush(); err == nil {
		err = ferr
	}
	return n, err
}

func writeCSV(w io.Writer, src Source) (int64, error) {
	cw := csv.NewWriter(w)
	var n int64
	var record []string
	err := src(func(cols []query.Column) error {
		for _, c := range cols {
			record = append(record, c.Name)
		}
		return cw.Write(record)
	}, func(row []any) error {
		record = record[:0]
		for _, v := range row {
			record = append(record, Cell(v))
		}
		n++
		return cw.Write(record)
	})
	cw.Flush()
	if err == nil {
		err = cw.Error()
	}
	return n, err
}

// writeJSON emits an array of objects, keys in column order. Duplicate
// column names get a numeric suffix so no value is lost.
func writeJSON(w io.Writer, src Source) (int64, error) {
	var n int64
	var keys [][]byte
	var buf bytes.Buffer
	io.WriteString(w, "[")
	err := src(func(cols []query.Column) error {
		seen := map[string]int{}
		for _, c := range cols {
			name := c.Name
			if k := seen[name]; k > 0 {
				name = fmt.Sprintf("%s_%d", name, k+1)
			}
			seen[c.Name]++
			b, _ := json.Marshal(name)
			keys = append(keys, b)
		}
		return nil
	}, func(row []any) error {
		buf.Reset()
		if n > 0 {
			buf.WriteByte(',')
		}
		buf.WriteString("\n  {")
		for i, v := range row {
			if i > 0 {
				buf.WriteString(", ")
			}
			buf.Write(keys[i])
			buf.WriteString(": ")
			b, err := json.Marshal(v)
			if err != nil {
				return err
			}
			buf.Write(b)
		}
		buf.WriteByte('}')
		n++
		_, err := w.Write(buf.Bytes())
		return err
	})
	io.WriteString(w, "\n]\n")
	return n, err
}

// Cell renders a normalized value as text (NULL becomes empty).
func Cell(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	default:
		return fmt.Sprint(x)
	}
}
