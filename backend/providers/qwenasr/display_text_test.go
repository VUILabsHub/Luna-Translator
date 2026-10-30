package qwenasr

import (
	"simultrans/core"
	"testing"
)

func TestAuthoritativeModelEpochsDoNotWaitForTTS(t *testing.T) {
	association := modelOutputTranscriptAssociation{}
	association.observeTarget(speechCursorTarget{speechEpoch: 1, utteranceID: "vad-1"})
	for _, text := range []string{"Visit West Lake", "Visit West Lake."} {
		got := association.prepare(core.Event{Type: "model_output", Text: text, ModelOutputAuthoritative: true, UtteranceID: "vad-1", SpeechEpoch: 1})
		if got.EpochText != text {
			t.Fatalf("first epoch: %#v", got)
		}
	}
	// No TTS done is necessary to establish the display boundary.
	association.prepare(core.Event{Type: "source_vad_commit", UtteranceID: "vad-1", SpeechEpoch: 1})
	association.observeTarget(speechCursorTarget{speechEpoch: 2, utteranceID: "vad-2"})
	got := association.prepare(core.Event{Type: "model_output", Text: "Visit West Lake. Take a walk", ModelOutputAuthoritative: true, UtteranceID: "vad-2", SpeechEpoch: 2})
	if got.EpochText != "Take a walk" {
		t.Fatalf("second epoch: %#v", got)
	}
	association.prepare(core.Event{Type: "translation_done", Text: "Visit West Lake\nTake a walk", UtteranceID: "vad-2", SpeechEpoch: 2})
	got = association.prepare(core.Event{Type: "model_output", Text: "Visit West Lake. Take a walk.", ModelOutputAuthoritative: true, UtteranceID: "vad-2", SpeechEpoch: 2})
	if got.EpochText != "Take a walk." {
		t.Fatalf("late punctuation: %#v", got)
	}
}
