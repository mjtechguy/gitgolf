package runner

import (
	"strings"
	"unicode/utf8"
)

// MaskExecutionOutput preserves frame lengths and coordinates while masking
// overlapping secrets across the entire bounded transcript.
func MaskExecutionOutput(chunks []string, secrets map[string]string) ([]string, error) {
	var combined []byte
	for _, text := range chunks {
		if !utf8.ValidString(text) || strings.ContainsRune(text, 0) {
			return nil, ErrExecutionValues
		}
		combined = append(combined, []byte(text)...)
		if len(combined) > 256<<10 {
			return nil, ErrExecutionValues
		}
	}
	marks := make([]int32, len(combined)+1)
	seen := map[string]bool{}
	for _, secret := range secrets {
		if !ExecutionValueBody(secret, true) {
			return nil, ErrExecutionValues
		}
		if seen[secret] {
			continue
		}
		seen[secret] = true
		// KMP retains overlapping matches without quadratic repeated-byte marking.
		pattern := []byte(secret)
		failure := make([]int, len(pattern))
		for i, j := 1, 0; i < len(pattern); i++ {
			for j > 0 && pattern[i] != pattern[j] {
				j = failure[j-1]
			}
			if pattern[i] == pattern[j] {
				j++
			}
			failure[i] = j
		}
		for i, j := 0, 0; i < len(combined); i++ {
			for j > 0 && combined[i] != pattern[j] {
				j = failure[j-1]
			}
			if combined[i] == pattern[j] {
				j++
			}
			if j == len(pattern) {
				start := i - len(pattern) + 1
				marks[start]++
				marks[i+1]--
				j = failure[j-1]
			}
		}
	}
	active := int32(0)
	for i := range combined {
		active += marks[i]
		if active > 0 {
			combined[i] = '*'
		}
	}
	result := make([]string, len(chunks))
	offset := 0
	for i, text := range chunks {
		result[i] = string(combined[offset : offset+len(text)])
		offset += len(text)
		if !utf8.ValidString(result[i]) || strings.ContainsRune(result[i], 0) {
			return nil, ErrExecutionValues
		}
	}
	return result, nil
}
