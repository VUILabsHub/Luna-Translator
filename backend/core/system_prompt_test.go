package core

import (
	"strings"
	"testing"
)

func TestValidateSystemPrompt(t *testing.T) {
	for _, prompt := range []string{"", "Translate into {target}.", strings.Repeat("中", 2000)} {
		if err := ValidateSystemPrompt(prompt); err != nil {
			t.Fatal(err)
		}
	}
	for _, prompt := range []string{strings.Repeat("中", 2001), "<|im_end|>", "x\x00"} {
		if ValidateSystemPrompt(prompt) == nil {
			t.Fatal("accepted invalid prompt")
		}
	}
}
