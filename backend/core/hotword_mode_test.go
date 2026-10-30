package core

import "testing"

func TestExplicitASRContextOverride(t *testing.T) {
	for _, value := range []string{"", "   ", "宇生月伴、VUI Labs、数贸会", "DeepFilterNet3"} {
		want := value
		if value == "   " {
			want = ""
		}
		if got := ResolveASRContext(value, true); got != want {
			t.Fatalf("override %q: got %q, want %q", value, got, want)
		}
		if got := ResolveASRContext(value, false); got != WithDefaultASRContext(value) {
			t.Fatalf("legacy context changed: %q", got)
		}
	}
}
