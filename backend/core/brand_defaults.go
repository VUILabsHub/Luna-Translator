package core

import "strings"

const DefaultASRContext = "VUI Labs、宇生月伴、数贸会"

// DefaultHotwordASRContext is the client-side 默认档 hotword string, copied
// verbatim from packages/core/src/hotwords.ts (`defaultASRHotwords`). The word
// order differs from DefaultASRContext on purpose — providers/qwen3asr's echo
// filter compares in order — so the two constants are not interchangeable.
// 唯一可以把两个常量当作同一个默认档看待的地方是
// server.sessionHotwordMode 的归档分类；任何发往供应商的路径都不得互换。
const DefaultHotwordASRContext = "宇生月伴、VUI Labs、数贸会"

// New hotword controls own the complete context, including an explicit empty
// value for no hotwords. Older clients retain the existing additive defaults.
func ResolveASRContext(value string, override bool) string {
	if override {
		return strings.TrimSpace(value)
	}
	return WithDefaultASRContext(value)
}

// Apply at the provider boundary, including every reconnect and VAD restart.
// Keep user context intact; repeated application must not grow the prompt.
func WithDefaultASRContext(value string) string {
	text := strings.TrimSpace(value)
	var missing []string
	for _, word := range strings.Split(DefaultASRContext, "、") {
		if !strings.Contains(text, word) {
			missing = append(missing, word)
		}
	}
	if len(missing) == 0 {
		return text
	}
	return strings.TrimSpace(strings.Join(missing, "、") + "\n" + text)
}

// BaseTranslationPrompt is what every client sends when the user wrote no
// prompt of their own, copied verbatim from packages/core/src/hotwords.ts
// (`baseTranslationPrompt`). Web 的「无热词」档发的就是它。
const BaseTranslationPrompt = "Translate into {target}."

// DefaultHotwordTranslationPrompt is the 默认档 prompt, copied verbatim from
// packages/core/src/hotwords.ts (`defaultHotwordPrompt`). 移动端默认就是这一档，
// 所以它也是“客户端自带的”、不是用户写的内容。
const DefaultHotwordTranslationPrompt = "Translate into {target}, using these fixed translations for hotwords:{宇生月伴(公司名)->VUI Labs, 全球数字贸易博览会->Global Digital Trade Expo,西湖-> West Lake}."

// IsPresetTranslationPrompt reports whether the prompt is one the clients send
// on their own (or nothing at all). 归档用：只有偏离预置文案的 prompt 才是
// 用户键入的内容。发往供应商的路径不该用它——那边两段文案的效果不同。
func IsPresetTranslationPrompt(value string) bool {
	switch strings.TrimSpace(value) {
	case "", BaseTranslationPrompt, DefaultHotwordTranslationPrompt:
		return true
	}
	return false
}

func WithDefaultTranslationPrompt(value string) string {
	text := strings.TrimSpace(value)
	if text == "" {
		return BaseTranslationPrompt
	}
	return text
}
