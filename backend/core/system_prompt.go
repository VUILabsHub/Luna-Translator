package core

import (
	"fmt"
	"strings"
	"unicode/utf8"
)

// ValidateSystemPrompt is shared by WS and RTC session creation. Token limits
// are checked by the actual model tokenizer before a model stream is allocated.
func ValidateSystemPrompt(prompt string) error {
	if utf8.RuneCountInString(prompt) > 2000 || strings.Contains(prompt, "<|") || strings.ContainsRune(prompt, 0) {
		return fmt.Errorf("system prompt must be <=2000 characters without special role tokens")
	}
	return nil
}
