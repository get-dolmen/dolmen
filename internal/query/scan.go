package query

import "database/sql"

// ScanRow reads one row and normalizes every value for JSON and the UI.
// The caller keeps ownership of rows and advances it with Next.
func ScanRow(rows *sql.Rows, columnCount int) ([]any, error) {
	values := make([]any, columnCount)
	scanTargets := make([]any, columnCount)
	for columnIndex := range values {
		scanTargets[columnIndex] = &values[columnIndex]
	}
	if err := rows.Scan(scanTargets...); err != nil {
		return nil, err
	}
	for columnIndex, value := range values {
		values[columnIndex] = Normalize(value)
	}
	return values, nil
}
