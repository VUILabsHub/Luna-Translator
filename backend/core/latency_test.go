package core

import (
	"reflect"
	"testing"
)

func TestPercentileNearestRank(t *testing.T) {
	values := []int64{50, 10, 40, 20, 30}
	original := append([]int64(nil), values...)
	tests := []struct {
		percentile int
		want       int64
	}{{0, 10}, {50, 30}, {90, 50}, {100, 50}, {120, 50}, {-1, 10}}
	for _, test := range tests {
		if got := Percentile(values, test.percentile); got != test.want {
			t.Errorf("Percentile(values, %d) = %d, want %d", test.percentile, got, test.want)
		}
	}
	if !reflect.DeepEqual(values, original) {
		t.Fatalf("Percentile modified input: got %v, want %v", values, original)
	}
}

func TestPercentileEmpty(t *testing.T) {
	if got := Percentile(nil, 90); got != 0 {
		t.Fatalf("Percentile(nil, 90) = %d, want 0", got)
	}
}
