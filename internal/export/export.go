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

// ToFile writes source to path and returns the number of rows written.
func ToFile(path string, format Format, source Source) (int64, error) {
	file, err := os.Create(path)
	if err != nil {
		return 0, err
	}
	rowCount, writeErr := Write(file, format, source)
	if closeErr := file.Close(); writeErr == nil {
		writeErr = closeErr
	}
	return rowCount, writeErr
}

func Write(writer io.Writer, format Format, source Source) (int64, error) {
	buffered := bufio.NewWriterSize(writer, 64<<10)
	var rowCount int64
	var err error
	switch format {
	case CSV:
		rowCount, err = writeCSV(buffered, source)
	case JSON:
		rowCount, err = writeJSON(buffered, source)
	default:
		return 0, fmt.Errorf("unknown export format %q", format)
	}
	if flushErr := buffered.Flush(); err == nil {
		err = flushErr
	}
	return rowCount, err
}

func writeCSV(writer io.Writer, source Source) (int64, error) {
	csvWriter := csv.NewWriter(writer)
	var rowCount int64
	var record []string
	err := source(func(columns []query.Column) error {
		for _, column := range columns {
			record = append(record, column.Name)
		}
		return csvWriter.Write(record)
	}, func(row []any) error {
		record = record[:0]
		for _, value := range row {
			record = append(record, Cell(value))
		}
		rowCount++
		return csvWriter.Write(record)
	})
	csvWriter.Flush()
	if err == nil {
		err = csvWriter.Error()
	}
	return rowCount, err
}

// writeJSON emits an array of objects, keys in column order. Duplicate
// column names get a numeric suffix so no value is lost.
func writeJSON(writer io.Writer, source Source) (int64, error) {
	var rowCount int64
	var encodedKeys [][]byte
	var buffer bytes.Buffer
	io.WriteString(writer, "[")
	err := source(func(columns []query.Column) error {
		seen := map[string]int{}
		for _, column := range columns {
			name := column.Name
			if duplicateCount := seen[name]; duplicateCount > 0 {
				name = fmt.Sprintf("%s_%d", name, duplicateCount+1)
			}
			seen[column.Name]++
			encodedName, _ := json.Marshal(name)
			encodedKeys = append(encodedKeys, encodedName)
		}
		return nil
	}, func(row []any) error {
		buffer.Reset()
		if rowCount > 0 {
			buffer.WriteByte(',')
		}
		buffer.WriteString("\n  {")
		for index, value := range row {
			if index > 0 {
				buffer.WriteString(", ")
			}
			buffer.Write(encodedKeys[index])
			buffer.WriteString(": ")
			encodedValue, err := json.Marshal(value)
			if err != nil {
				return err
			}
			buffer.Write(encodedValue)
		}
		buffer.WriteByte('}')
		rowCount++
		_, err := writer.Write(buffer.Bytes())
		return err
	})
	io.WriteString(writer, "\n]\n")
	return rowCount, err
}

// Cell renders a normalized value as text (NULL becomes empty).
func Cell(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return typed
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64)
	default:
		return fmt.Sprint(typed)
	}
}
