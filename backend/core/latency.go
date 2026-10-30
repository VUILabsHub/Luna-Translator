package core

import (
	"math"
	"sort"
)

func FirstToken(start int64, token int64) int64 {
	return token - start
}

// Percentile returns the nearest-rank percentile without modifying the input.
// p is clamped to the inclusive range [0, 100].
func Percentile(values []int64, p int) int64 {
	if len(values) == 0 {
		return 0
	}
	sorted := append([]int64(nil), values...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
	if p <= 0 {
		return sorted[0]
	}
	if p >= 100 {
		return sorted[len(sorted)-1]
	}
	rank := int(math.Ceil(float64(p) / 100 * float64(len(sorted))))
	return sorted[rank-1]
}
