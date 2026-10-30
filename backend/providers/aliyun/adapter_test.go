package aliyun

import (
	"testing"

	"simultrans/core"
)

func TestSessionUpdateEnablesVoiceCloneOnce(t *testing.T) {
	payload := sessionUpdate(core.SessionConfig{
		SourceLanguage: "zh",
		TargetLanguage: "en",
		VoiceClone:     true,
	})
	session := payload["session"].(map[string]any)

	if session["voice"] != "default" {
		t.Fatalf("voice = %v, want default", session["voice"])
	}
	if session["enable_voice_clone"] != true {
		t.Fatalf("enable_voice_clone = %v, want true", session["enable_voice_clone"])
	}
	options := session["voice_clone_options"].(map[string]string)
	if options["frequency"] != "once" {
		t.Fatalf("frequency = %v, want once", options["frequency"])
	}
}

func TestSessionUpdateUsesSelectedPresetWhenCloneDisabled(t *testing.T) {
	payload := sessionUpdate(core.SessionConfig{VoiceClone: false, Voice: "Raymond"})
	session := payload["session"].(map[string]any)

	if session["voice"] != "Raymond" {
		t.Fatalf("voice = %v, want Raymond", session["voice"])
	}
	if session["enable_voice_clone"] != false {
		t.Fatalf("enable_voice_clone = %v, want false", session["enable_voice_clone"])
	}
	if _, exists := session["voice_clone_options"]; exists {
		t.Fatal("voice_clone_options should be omitted when clone is disabled")
	}
}

func TestNormalizeTranslationAndAudio(t *testing.T) {
	text, ok := normalizeEvent("response.audio_transcript.done", map[string]any{
		"transcript": "Hello",
	})
	if !ok || text.Type != "translation_done" || text.Text != "Hello" {
		t.Fatalf("unexpected text event: %#v, %v", text, ok)
	}

	audio, ok := normalizeEvent("response.audio.delta", map[string]any{"delta": "AQI="})
	if !ok || audio.Type != "audio" || audio.Audio != "AQI=" {
		t.Fatalf("unexpected audio event: %#v, %v", audio, ok)
	}
}

func TestNormalizerReplacesTentativeTextAndPreservesCompletedUtterances(t *testing.T) {
	normalizer := streamNormalizer{}
	first, ok := normalizer.normalize("response.audio_transcript.text", map[string]any{
		"text": "", "stash": "Tox",
	})
	if !ok || first.Type != "translation_update" || first.Text != "Tox" {
		t.Fatalf("unexpected first preview: %#v, %v", first, ok)
	}
	updated, ok := normalizer.normalize("response.audio_transcript.text", map[string]any{
		"text": "Toxic,", "stash": "",
	})
	if !ok || updated.Text != "Toxic," {
		t.Fatalf("preview must replace, not append: %#v, %v", updated, ok)
	}
	done, ok := normalizer.normalize("response.audio_transcript.done", map[string]any{
		"transcript": "Toxic,",
	})
	if !ok || done.Type != "translation_done" || done.Text != "Toxic," {
		t.Fatalf("unexpected completed translation: %#v, %v", done, ok)
	}
	next, ok := normalizer.normalize("response.audio_transcript.text", map[string]any{
		"text": "Hello", "stash": " world.",
	})
	if !ok || next.Text != "Toxic, Hello world." {
		t.Fatalf("completed utterance was not preserved: %#v, %v", next, ok)
	}
}

func TestNormalizerUsesConfirmedAndTentativeSourceText(t *testing.T) {
	normalizer := streamNormalizer{}
	event, ok := normalizer.normalize("conversation.item.input_audio_transcription.text", map[string]any{
		"text": "今天天气", "stash": "真好",
	})
	if !ok || event.Type != "source_update" || event.Text != "今天天气真好" {
		t.Fatalf("unexpected source preview: %#v, %v", event, ok)
	}
}

func TestNormalizerAcceptsCumulativeCompletedTranscript(t *testing.T) {
	normalizer := streamNormalizer{translationCommitted: "Hello."}
	event, ok := normalizer.normalize("response.audio_transcript.done", map[string]any{
		"item_id":    "item-2",
		"transcript": "Hello. How are you?",
	})
	if !ok || event.Text != "Hello. How are you?" {
		t.Fatalf("cumulative transcript must replace committed text: %#v, %v", event, ok)
	}
	if event.SegmentID != "item-2" || event.SegmentText != "How are you?" {
		t.Fatalf("completed item identity or committed part was lost: %#v", event)
	}
	if event.StartMs != nil || event.EndMs != nil {
		t.Fatalf("Qwen events must not pretend to contain provider timestamps: %#v", event)
	}
}

func TestNormalizerPreservesCompletedSourceItemIdentity(t *testing.T) {
	normalizer := streamNormalizer{}
	event, ok := normalizer.normalize("conversation.item.input_audio_transcription.completed", map[string]any{
		"event_id":   "event-1",
		"item_id":    "source-item-1",
		"transcript": "今天天气很好。",
	})
	if !ok || event.Text != "今天天气很好。" {
		t.Fatalf("unexpected completed source event: %#v, %v", event, ok)
	}
	if event.SegmentID != "source-item-1" || event.SegmentText != "今天天气很好。" {
		t.Fatalf("source item identity or text was lost: %#v", event)
	}
}

func TestNormalizerPreservesAudioResponseIdentity(t *testing.T) {
	event, ok := normalizeEvent("response.audio.delta", map[string]any{
		"response_id": "response-7",
		"delta":       "AQI=",
	})
	if !ok || event.Type != "audio" || event.Audio != "AQI=" || event.SegmentID != "response-7" {
		t.Fatalf("audio response identity was lost: %#v, %v", event, ok)
	}
	if event.AudioDurationMs == nil || *event.AudioDurationMs != 1000.0/aliyunOutputSampleRate {
		t.Fatalf("audio duration was not derived from documented PCM16/24kHz: %#v", event)
	}
}

func TestNormalizerDoesNotTreatEventIDAsSegmentIdentity(t *testing.T) {
	event, ok := normalizeEvent("response.audio.delta", map[string]any{
		"event_id": "event-unique-to-this-message",
		"delta":    "AQI=",
	})
	if !ok || event.SegmentID != "" {
		t.Fatalf("event_id must not be exposed as a cross-event segment identity: %#v", event)
	}

	invalid, ok := normalizeEvent("response.audio.delta", map[string]any{"delta": "not-base64"})
	if !ok || invalid.AudioDurationMs != nil {
		t.Fatalf("invalid PCM payload must keep audio duration missing: %#v", invalid)
	}
}

func TestSessionUsesDocumentedOutputSampleRate(t *testing.T) {
	if aliyunOutputSampleRate != 24000 {
		t.Fatalf("output sample rate = %d, want 24000", aliyunOutputSampleRate)
	}
}

func TestEndpointUsesWorkspaceRegionAndModel(t *testing.T) {
	adapter := Adapter{WorkspaceID: "ws-123", Region: "ap-southeast-1", Model: "test-model"}
	got, err := adapter.endpointURL()
	if err != nil {
		t.Fatal(err)
	}
	want := "wss://ws-123.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/realtime?model=test-model"
	if got != want {
		t.Fatalf("endpoint = %q, want %q", got, want)
	}
}
