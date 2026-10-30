package core

import (
	"strings"
	"testing"
)

func TestDefaultBrandContext(t *testing.T) {
	for _, input := range []string{"", "  ", "会议主题：DeepFilterNet3", "VUI Labs", "VUI Labs、宇生月伴", "数贸会", DefaultASRContext} {
		got := WithDefaultASRContext(input)
		for _, word := range []string{"VUI Labs", "宇生月伴", "数贸会", strings.TrimSpace(input)} {
			if !strings.Contains(got, word) {
				t.Fatalf("%q missing %q", got, word)
			}
		}
		if WithDefaultASRContext(got) != got {
			t.Fatal("ASR defaults duplicated on restart")
		}
	}
}

func TestTranslationPromptDefaultAndCustomOrder(t *testing.T) {
	for _, input := range []string{"", "  \n "} {
		if got := WithDefaultTranslationPrompt(input); got != "Translate into {target}." {
			t.Fatalf("default = %q", got)
		}
	}
	for _, input := range []string{
		"Use concise terms.\nTranslate into {target}.",
		"Translate into {target}.\nUse concise terms.",
		"Use concise terms.\nTranslate into {target}.\nKeep names unchanged.",
		`Translate into {target}. Translate "宇生月伴" into "VUI labs"`,
		"Translate into {target}.\ntranslate 宇生月伴 into VUI labs",
		"Use concise terms.\ntranslate 宇生月伴 into VUI labs",
	} {
		got := WithDefaultTranslationPrompt(input)
		if got != input || WithDefaultTranslationPrompt(got) != got {
			t.Fatalf("custom prompt changed: got %q want %q", got, input)
		}
	}
	if err := ValidateSystemPrompt(WithDefaultTranslationPrompt(strings.Repeat("a", 2000))); err != nil {
		t.Fatalf("prompt at character limit rejected: %v", err)
	}
	if ValidateSystemPrompt(WithDefaultTranslationPrompt(strings.Repeat("a", 2001))) == nil {
		t.Fatal("final prompt must still obey the model length limit")
	}
}
