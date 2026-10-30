package qwenasr

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"simultrans/core"
)

type stubProvider struct {
	name string
	run  func(context.Context, core.SessionConfig, <-chan []byte, chan<- core.Event) error
}

func TestSidecarPrimaryVADGateAppliesToEveryTransport(t *testing.T) {
	provider := SidecarProvider{GateSourceWithPrimaryVAD: true}
	for _, transport := range []string{"", "websocket", "webrtc"} {
		if !provider.shouldGateSourceWithPrimaryVAD(core.SessionConfig{Transport: transport}) {
			t.Fatalf("transport %q must remain gated when the provider requires it", transport)
		}
	}
}

func TestSidecarDelaysPrimaryFinishedUntilSourceIsDone(t *testing.T) {
	primary := stubProvider{
		name: "primary",
		run: func(
			_ context.Context,
			_ core.SessionConfig,
			audio <-chan []byte,
			events chan<- core.Event,
		) error {
			for range audio {
			}
			events <- core.Event{Type: "source_delta", Text: "primary partial"}
			events <- core.Event{Type: "source_update", Text: "primary preview"}
			events <- core.Event{Type: "source_done", Text: "primary final"}
			events <- core.Event{Type: "translation_done", Text: "Hello."}
			events <- core.Event{Type: "state", State: "finished"}
			return nil
		},
	}
	source := stubProvider{
		name: "source",
		run: func(
			_ context.Context,
			_ core.SessionConfig,
			audio <-chan []byte,
			events chan<- core.Event,
		) error {
			for range audio {
			}
			time.Sleep(20 * time.Millisecond)
			events <- core.Event{Type: "source_update", Text: "你好"}
			events <- core.Event{Type: "source_done", Text: "你好。"}
			return nil
		},
	}
	audio := make(chan []byte, 1)
	audio <- []byte{1, 2}
	close(audio)
	events := make(chan core.Event, 4)

	if err := (SidecarProvider{Primary: primary, Source: source}).Run(
		context.Background(),
		core.SessionConfig{},
		audio,
		events,
	); err != nil {
		t.Fatalf("Run: %v", err)
	}
	close(events)

	var eventTypes []string
	for event := range events {
		eventTypes = append(eventTypes, event.Type)
	}
	if len(eventTypes) != 4 ||
		eventTypes[0] != "translation_done" ||
		eventTypes[1] != "source_update" ||
		eventTypes[2] != "source_done" ||
		eventTypes[3] != "state" {
		t.Fatalf("event order = %v", eventTypes)
	}
}

func TestSourceTranscriptAssociationLatchesVADTargetUntilSourceDone(t *testing.T) {
	association := sourceTranscriptAssociation{}
	first := speechCursorTarget{speechEpoch: 1, utteranceID: "vad-1"}
	second := speechCursorTarget{speechEpoch: 2, utteranceID: "vad-2"}

	update, ok := association.prepare(core.Event{
		Type: "source_update", Text: "第一句",
	}, first)
	if !ok || update.UtteranceID != "vad-1" || update.SpeechEpoch != 1 || update.EpochText != "第一句" {
		t.Fatalf("first update = %#v, associated=%v", update, ok)
	}

	// The next primary VAD may start before Qwen emits its final ASR item. The
	// final must stay on the VAD target latched by the first source preview.
	done, ok := association.prepare(core.Event{
		Type: "source_done", Text: "第一句。", SegmentText: "第一句。",
	}, second)
	if !ok || done.UtteranceID != "vad-1" || done.SpeechEpoch != 1 || done.EpochText != "第一句。" {
		t.Fatalf("late first done = %#v, associated=%v", done, ok)
	}

	secondUpdate, ok := association.prepare(core.Event{
		Type: "source_update", Text: "第一句。第二句",
	}, second)
	if !ok || secondUpdate.UtteranceID != "vad-2" || secondUpdate.SpeechEpoch != 2 ||
		secondUpdate.EpochText != "第二句" {
		t.Fatalf("second update = %#v, associated=%v", secondUpdate, ok)
	}
}

func TestAttachSourceAudioTimelineUsesOriginalVADBounds(t *testing.T) {
	firstStart, laterStart := int64(120), int64(900)
	firstEnd, laterEnd := int64(760), int64(1_420)
	timeline := mergeSourceAudioTimeline(sourceAudioTimeline{}, &laterStart, &firstEnd)
	timeline = mergeSourceAudioTimeline(timeline, &firstStart, &laterEnd)

	event := attachSourceAudioTimeline(core.Event{Type: "source_done", Text: "第一句。第二句。"}, timeline)
	if event.StartMs == nil || *event.StartMs != firstStart || event.EndMs == nil || *event.EndMs != laterEnd {
		t.Fatalf("source timeline = %#v", event)
	}
}

func TestAttachSourceAudioTimelinePreservesProviderTiming(t *testing.T) {
	providerStart, providerEnd := int64(300), int64(800)
	event := attachSourceAudioTimeline(core.Event{
		Type: "source_done", StartMs: &providerStart, EndMs: &providerEnd,
	}, sourceAudioTimeline{startMs: 100, endMs: 1_000, hasStartMs: true, hasEndMs: true})
	if event.StartMs == nil || *event.StartMs != providerStart || event.EndMs == nil || *event.EndMs != providerEnd {
		t.Fatalf("provider timeline was overwritten: %#v", event)
	}
}

func TestSourceTranscriptAssociationKeepsLateCompletedOnItsItemTarget(t *testing.T) {
	association := sourceTranscriptAssociation{}
	first := speechCursorTarget{speechEpoch: 1, utteranceID: "vad-1"}
	second := speechCursorTarget{speechEpoch: 2, utteranceID: "vad-2"}
	association.observeTarget(first)

	firstPreview, ok := association.prepare(core.Event{
		Type: "source_update", Text: "第一句", SegmentID: "item-1", SegmentText: "第一句",
	}, first)
	if !ok || firstPreview.UtteranceID != "vad-1" {
		t.Fatalf("first preview = %#v, associated=%v", firstPreview, ok)
	}

	association.observeTarget(second)
	secondPreview, ok := association.prepare(core.Event{
		Type: "source_update", Text: "第二句", SegmentID: "item-2", SegmentText: "第二句",
	}, second)
	if !ok || secondPreview.UtteranceID != "vad-2" {
		t.Fatalf("second preview = %#v, associated=%v", secondPreview, ok)
	}

	// item-1 completes after both the next speech_start and item-2 preview.
	lateDone, ok := association.prepare(core.Event{
		Type: "source_done", Text: "第一句。", SegmentID: "item-1", SegmentText: "第一句。",
	}, second)
	if !ok || lateDone.UtteranceID != "vad-1" || lateDone.SpeechEpoch != 1 ||
		lateDone.EpochText != "第一句。" {
		t.Fatalf("late completed item = %#v, associated=%v", lateDone, ok)
	}
}

func TestSourceTranscriptAssociationCompletedOnlyConsumesOldestVADTarget(t *testing.T) {
	association := sourceTranscriptAssociation{}
	first := speechCursorTarget{speechEpoch: 11, utteranceID: "vad-11"}
	second := speechCursorTarget{speechEpoch: 12, utteranceID: "vad-12"}
	association.observeTarget(first)
	association.observeTarget(second)

	// No preview was emitted for item-1. Even though vad-12 is now active, the
	// completed-only item must claim the oldest VAD target not used by an item.
	firstDone, ok := association.prepare(core.Event{
		Type: "source_done", Text: "旧句。", SegmentID: "item-old", SegmentText: "旧句。",
	}, second)
	if !ok || firstDone.UtteranceID != "vad-11" || firstDone.SpeechEpoch != 11 {
		t.Fatalf("first completed-only item = %#v, associated=%v", firstDone, ok)
	}

	secondDone, ok := association.prepare(core.Event{
		Type: "source_done", Text: "旧句。新句。", SegmentID: "item-new", SegmentText: "新句。",
	}, second)
	if !ok || secondDone.UtteranceID != "vad-12" || secondDone.SpeechEpoch != 12 ||
		secondDone.EpochText != "新句。" {
		t.Fatalf("second completed-only item = %#v, associated=%v", secondDone, ok)
	}
}

func TestModelOutputTranscriptAssociationStreamsUtteranceLocalEpochText(t *testing.T) {
	association := modelOutputTranscriptAssociation{}
	first := speechCursorTarget{speechEpoch: 1, utteranceID: "vad-1"}
	second := speechCursorTarget{speechEpoch: 2, utteranceID: "vad-2"}
	association.observeTarget(first)

	for _, test := range []struct {
		event core.Event
		want  string
	}{
		{core.Event{Type: "model_output", Text: "Hel", UtteranceID: "vad-1", SpeechEpoch: 1}, "Hel"},
		{core.Event{Type: "model_output", Text: "Hello.", UtteranceID: "vad-1", SpeechEpoch: 1}, "Hello."},
	} {
		if got := association.prepare(test.event); got.EpochText != test.want {
			t.Fatalf("first utterance preview = %q, want %q", got.EpochText, test.want)
		}
	}
	association.prepare(core.Event{
		Type: "translation_done", Text: "Hello.", UtteranceID: "vad-1", SpeechEpoch: 1,
	})
	association.prepare(core.Event{
		Type: "source_vad_commit", UtteranceID: "vad-1", SpeechEpoch: 1,
	})

	association.observeTarget(second)
	for _, test := range []struct {
		event core.Event
		want  string
	}{
		{core.Event{Type: "model_output", Text: "Hello. Wor", UtteranceID: "vad-2", SpeechEpoch: 2}, "Wor"},
		{core.Event{Type: "model_output", Text: "Hello. World today", UtteranceID: "vad-2", SpeechEpoch: 2}, "World today"},
		// A revision can shorten the current utterance without changing its anchor.
		{core.Event{Type: "model_output", Text: "Hello. World", UtteranceID: "vad-2", SpeechEpoch: 2}, "World"},
	} {
		if got := association.prepare(test.event); got.EpochText != test.want {
			t.Fatalf("second utterance preview = %q, want %q", got.EpochText, test.want)
		}
	}
}

func TestModelOutputTranscriptAssociationAcceptsOneFrameCursorSkew(t *testing.T) {
	association := modelOutputTranscriptAssociation{}
	modelEnd, doneEnd := int64(1_000), int64(996)
	association.observeTarget(speechCursorTarget{speechEpoch: 1, utteranceID: "vad-1"})
	association.prepare(core.Event{
		Type: "model_output", Text: "Prior. First.", UtteranceID: "vad-1", SpeechEpoch: 1, EndMs: &modelEnd,
	})
	association.prepare(core.Event{
		Type: "translation_done", Text: "Prior.\nFirst.", UtteranceID: "vad-1", SpeechEpoch: 1, EndMs: &doneEnd,
	})
	association.prepare(core.Event{
		Type: "source_vad_commit", UtteranceID: "vad-1", SpeechEpoch: 1,
	})
	association.observeTarget(speechCursorTarget{speechEpoch: 2, utteranceID: "vad-2"})

	got := association.prepare(core.Event{
		Type: "model_output", Text: "Prior. First. Second", UtteranceID: "vad-2", SpeechEpoch: 2,
	})
	if got.EpochText != "Second" {
		t.Fatalf("one-frame Gateway cursor skew should retain a safe anchor: %#v", got)
	}
}

func TestModelOutputTranscriptAssociationMatchesWhitespaceEquivalentDoneWithoutCursor(t *testing.T) {
	association := modelOutputTranscriptAssociation{}
	association.observeTarget(speechCursorTarget{speechEpoch: 1, utteranceID: "vad-1"})
	association.prepare(core.Event{
		Type: "model_output", Text: "The main expectations for this year", UtteranceID: "vad-1", SpeechEpoch: 1,
	})
	association.prepare(core.Event{
		Type: "translation_done", Text: "The main expectations\nfor this year", UtteranceID: "vad-1", SpeechEpoch: 1,
	})
	association.prepare(core.Event{
		Type: "source_vad_commit", UtteranceID: "vad-1", SpeechEpoch: 1,
	})
	association.observeTarget(speechCursorTarget{speechEpoch: 2, utteranceID: "vad-2"})

	got := association.prepare(core.Event{
		Type: "model_output", Text: "The main expectations for this year Next", UtteranceID: "vad-2", SpeechEpoch: 2,
	})
	if got.EpochText != "Next" {
		t.Fatalf("whitespace-equivalent stable snapshot should establish the next anchor: %#v", got)
	}
}

func TestModelOutputTranscriptAssociationReanchorsOnLatePreviousOutput(t *testing.T) {
	association := modelOutputTranscriptAssociation{}
	association.observeTarget(speechCursorTarget{speechEpoch: 1, utteranceID: "vad-1"})
	// The next VAD can start before forced inference for the previous VAD ends.
	association.observeTarget(speechCursorTarget{speechEpoch: 2, utteranceID: "vad-2"})
	latePrevious := association.prepare(core.Event{
		Type: "model_output", Text: "First.", UtteranceID: "vad-1", SpeechEpoch: 1,
	})
	association.prepare(core.Event{
		Type: "translation_done", Text: "First.", UtteranceID: "vad-1", SpeechEpoch: 1,
	})
	association.prepare(core.Event{
		Type: "source_vad_commit", UtteranceID: "vad-1", SpeechEpoch: 1,
	})
	current := association.prepare(core.Event{
		Type: "model_output", Text: "First. Sec", UtteranceID: "vad-2", SpeechEpoch: 2,
	})

	if latePrevious.EpochText != "First." || current.EpochText != "Sec" {
		t.Fatalf("late previous = %q, current = %q", latePrevious.EpochText, current.EpochText)
	}
}

func TestModelOutputTranscriptAssociationFailsClosedOnPrefixMismatch(t *testing.T) {
	association := modelOutputTranscriptAssociation{}
	association.observeTarget(speechCursorTarget{speechEpoch: 1, utteranceID: "vad-1"})
	association.prepare(core.Event{
		Type: "model_output", Text: "Original.", UtteranceID: "vad-1", SpeechEpoch: 1,
	})
	association.prepare(core.Event{
		Type: "translation_done", Text: "Original.", UtteranceID: "vad-1", SpeechEpoch: 1,
	})
	association.prepare(core.Event{
		Type: "source_vad_commit", UtteranceID: "vad-1", SpeechEpoch: 1,
	})
	association.observeTarget(speechCursorTarget{speechEpoch: 2, utteranceID: "vad-2"})

	got := association.prepare(core.Event{
		Type: "model_output", Text: "Revised previous. Current.", UtteranceID: "vad-2", SpeechEpoch: 2,
	})
	if got.EpochText != "" {
		t.Fatalf("mismatched cumulative snapshot must not be sliced: %#v", got)
	}
}

func TestModelOutputTranscriptAssociationFailsClosedWithoutPreviousSnapshot(t *testing.T) {
	association := modelOutputTranscriptAssociation{}
	association.observeTarget(speechCursorTarget{speechEpoch: 1, utteranceID: "vad-1"})
	// The preceding utterance produced no model_output, so the next cumulative
	// snapshot has no exact boundary anchor and must not be treated as local.
	association.observeTarget(speechCursorTarget{speechEpoch: 2, utteranceID: "vad-2"})

	got := association.prepare(core.Event{
		Type: "model_output", Text: "Previous. Current.", UtteranceID: "vad-2", SpeechEpoch: 2,
	})
	if got.EpochText != "" {
		t.Fatalf("unanchored cumulative snapshot must not be exposed: %#v", got)
	}
}

func TestModelOutputTranscriptAssociationRecoversWhenPreviousSnapshotArrivesLate(t *testing.T) {
	association := modelOutputTranscriptAssociation{}
	association.observeTarget(speechCursorTarget{speechEpoch: 1, utteranceID: "vad-1"})
	association.observeTarget(speechCursorTarget{speechEpoch: 2, utteranceID: "vad-2"})
	tooEarly := association.prepare(core.Event{
		Type: "model_output", Text: "First. Sec", UtteranceID: "vad-2", SpeechEpoch: 2,
	})
	latePrevious := association.prepare(core.Event{
		Type: "model_output", Text: "First.", UtteranceID: "vad-1", SpeechEpoch: 1,
	})
	association.prepare(core.Event{
		Type: "translation_done", Text: "First.", UtteranceID: "vad-1", SpeechEpoch: 1,
	})
	association.prepare(core.Event{
		Type: "source_vad_commit", UtteranceID: "vad-1", SpeechEpoch: 1,
	})
	recovered := association.prepare(core.Event{
		Type: "model_output", Text: "First. Second", UtteranceID: "vad-2", SpeechEpoch: 2,
	})

	if tooEarly.EpochText != "" || latePrevious.EpochText != "First." || recovered.EpochText != "Second" {
		t.Fatalf("too early = %q, late previous = %q, recovered = %q",
			tooEarly.EpochText, latePrevious.EpochText, recovered.EpochText)
	}
}

func TestModelOutputTranscriptAssociationDoesNotAnchorOnUnfinalizedPreview(t *testing.T) {
	association := modelOutputTranscriptAssociation{}
	association.observeTarget(speechCursorTarget{speechEpoch: 1, utteranceID: "vad-1"})
	association.prepare(core.Event{
		Type: "model_output", Text: "Hel", ModelOutputStable: false,
		UtteranceID: "vad-1", SpeechEpoch: 1,
	})
	association.observeTarget(speechCursorTarget{speechEpoch: 2, utteranceID: "vad-2"})

	got := association.prepare(core.Event{
		Type: "model_output", Text: "Hello world", UtteranceID: "vad-2", SpeechEpoch: 2,
	})
	if got.EpochText != "" {
		t.Fatalf("unfinished previous preview must not become a cross-VAD anchor: %#v", got)
	}
}

func TestModelOutputTranscriptAssociationDoesNotFinalizePartialAfterSegmentDone(t *testing.T) {
	association := modelOutputTranscriptAssociation{}
	firstEnd, laterEnd := int64(100), int64(200)
	association.observeTarget(speechCursorTarget{speechEpoch: 1, utteranceID: "vad-1"})
	association.prepare(core.Event{
		Type: "model_output", Text: "Hello", UtteranceID: "vad-1", SpeechEpoch: 1, EndMs: &firstEnd,
	})
	association.prepare(core.Event{
		Type: "translation_done", Text: "Hello", UtteranceID: "vad-1", SpeechEpoch: 1, EndMs: &firstEnd,
	})
	association.prepare(core.Event{
		Type: "model_output", Text: "Hello wor", UtteranceID: "vad-1", SpeechEpoch: 1, EndMs: &laterEnd,
	})
	association.prepare(core.Event{
		Type: "source_vad_commit", UtteranceID: "vad-1", SpeechEpoch: 1,
	})
	association.observeTarget(speechCursorTarget{speechEpoch: 2, utteranceID: "vad-2"})

	got := association.prepare(core.Event{
		Type: "model_output", Text: "Hello world Next", UtteranceID: "vad-2", SpeechEpoch: 2,
	})
	if got.EpochText != "" {
		t.Fatalf("a done preceding a newer partial must not finalize that partial: %#v", got)
	}
}

func TestModelOutputTranscriptAssociationPropagatesFinalAnchorOnlyToImmediateSuccessor(t *testing.T) {
	association := modelOutputTranscriptAssociation{}
	association.observeTarget(speechCursorTarget{speechEpoch: 1, utteranceID: "vad-1"})
	association.observeTarget(speechCursorTarget{speechEpoch: 2, utteranceID: "vad-2"})
	association.observeTarget(speechCursorTarget{speechEpoch: 3, utteranceID: "vad-3"})
	association.prepare(core.Event{
		Type: "model_output", Text: "A", UtteranceID: "vad-1", SpeechEpoch: 1,
	})
	association.prepare(core.Event{
		Type: "translation_done", Text: "A", UtteranceID: "vad-1", SpeechEpoch: 1,
	})
	association.prepare(core.Event{
		Type: "source_vad_commit", UtteranceID: "vad-1", SpeechEpoch: 1,
	})

	thirdTooEarly := association.prepare(core.Event{
		Type: "model_output", Text: "A B C", UtteranceID: "vad-3", SpeechEpoch: 3,
	})
	second := association.prepare(core.Event{
		Type: "model_output", Text: "A B", UtteranceID: "vad-2", SpeechEpoch: 2,
	})
	if thirdTooEarly.EpochText != "" || second.EpochText != "B" {
		t.Fatalf("third too early = %q, second = %q", thirdTooEarly.EpochText, second.EpochText)
	}
}

func TestModelOutputTranscriptAssociationDoesNotMatchDoneAcrossSpeechEpochs(t *testing.T) {
	association := modelOutputTranscriptAssociation{}
	endMs := int64(100)
	association.observeTarget(speechCursorTarget{speechEpoch: 1, utteranceID: "vad-1"})
	association.observeTarget(speechCursorTarget{speechEpoch: 2, utteranceID: "vad-1"})
	association.prepare(core.Event{
		Type: "translation_done", Text: "New", UtteranceID: "vad-1", SpeechEpoch: 2, EndMs: &endMs,
	})
	association.prepare(core.Event{
		Type: "model_output", Text: "Old", UtteranceID: "vad-1", SpeechEpoch: 1, EndMs: &endMs,
	})
	association.prepare(core.Event{
		Type: "source_vad_commit", UtteranceID: "vad-1", SpeechEpoch: 2,
	})
	association.observeTarget(speechCursorTarget{speechEpoch: 3, utteranceID: "vad-3"})

	got := association.prepare(core.Event{
		Type: "model_output", Text: "Old Current", UtteranceID: "vad-3", SpeechEpoch: 3,
	})
	if got.EpochText != "" {
		t.Fatalf("a newer speech epoch done must not authorize an older snapshot: %#v", got)
	}
}

func TestModelOutputTranscriptAssociationInvalidatesLateFinalizedRevision(t *testing.T) {
	association := modelOutputTranscriptAssociation{}
	firstEnd, revisedEnd := int64(100), int64(200)
	association.observeTarget(speechCursorTarget{speechEpoch: 1, utteranceID: "vad-1"})
	association.prepare(core.Event{
		Type: "model_output", Text: "First", UtteranceID: "vad-1", SpeechEpoch: 1, EndMs: &firstEnd,
	})
	association.prepare(core.Event{
		Type: "translation_done", Text: "First", UtteranceID: "vad-1", SpeechEpoch: 1, EndMs: &firstEnd,
	})
	association.prepare(core.Event{
		Type: "source_vad_commit", UtteranceID: "vad-1", SpeechEpoch: 1,
	})
	association.observeTarget(speechCursorTarget{speechEpoch: 2, utteranceID: "vad-2"})
	association.prepare(core.Event{
		Type: "model_output", Text: "First revised", UtteranceID: "vad-1", SpeechEpoch: 1, EndMs: &revisedEnd,
	})

	tooEarly := association.prepare(core.Event{
		Type: "model_output", Text: "First revised Second", UtteranceID: "vad-2", SpeechEpoch: 2,
	})
	if tooEarly.EpochText != "" {
		t.Fatalf("successor must fail closed while its predecessor revision is unconfirmed: %#v", tooEarly)
	}
	association.prepare(core.Event{
		Type: "translation_done", Text: "First revised", UtteranceID: "vad-1", SpeechEpoch: 1, EndMs: &revisedEnd,
	})
	pending := association.drainPendingEvents()
	if len(pending) != 1 || pending[0].Type != "model_output" ||
		pending[0].UtteranceID != "vad-2" || pending[0].EpochText != "Second" {
		t.Fatalf("refreshed successor preview = %#v", pending)
	}
}

func TestModelOutputTranscriptAssociationResetsVisibleSuccessorAfterLateRevision(t *testing.T) {
	association := modelOutputTranscriptAssociation{}
	firstEnd, revisedEnd := int64(100), int64(200)
	association.observeTarget(speechCursorTarget{speechEpoch: 1, utteranceID: "vad-1"})
	association.prepare(core.Event{
		Type: "model_output", Text: "First", UtteranceID: "vad-1", SpeechEpoch: 1, EndMs: &firstEnd,
	})
	association.prepare(core.Event{
		Type: "translation_done", Text: "First", UtteranceID: "vad-1", SpeechEpoch: 1, EndMs: &firstEnd,
	})
	association.prepare(core.Event{
		Type: "source_vad_commit", UtteranceID: "vad-1", SpeechEpoch: 1,
	})
	association.observeTarget(speechCursorTarget{speechEpoch: 2, utteranceID: "vad-2"})
	visible := association.prepare(core.Event{
		Type: "model_output", Text: "First Second", UtteranceID: "vad-2", SpeechEpoch: 2,
	})
	if visible.EpochText != "Second" {
		t.Fatalf("initial successor preview = %#v", visible)
	}

	association.prepare(core.Event{
		Type: "model_output", Text: "First revised", UtteranceID: "vad-1", SpeechEpoch: 1, EndMs: &revisedEnd,
	})
	pending := association.drainPendingEvents()
	if len(pending) != 1 || pending[0].Type != "model_output_reset" || pending[0].UtteranceID != "vad-2" {
		t.Fatalf("successor reset = %#v", pending)
	}
}

func TestModelOutputTranscriptAssociationInvalidatesDependentSuccessorChain(t *testing.T) {
	association := modelOutputTranscriptAssociation{}
	firstEnd, secondEnd, revisedEnd := int64(100), int64(200), int64(300)
	association.observeTarget(speechCursorTarget{speechEpoch: 1, utteranceID: "vad-1"})
	association.prepare(core.Event{
		Type: "model_output", Text: "A", UtteranceID: "vad-1", SpeechEpoch: 1, EndMs: &firstEnd,
	})
	association.prepare(core.Event{
		Type: "translation_done", Text: "A", UtteranceID: "vad-1", SpeechEpoch: 1, EndMs: &firstEnd,
	})
	association.prepare(core.Event{
		Type: "source_vad_commit", UtteranceID: "vad-1", SpeechEpoch: 1,
	})
	association.observeTarget(speechCursorTarget{speechEpoch: 2, utteranceID: "vad-2"})
	association.prepare(core.Event{
		Type: "model_output", Text: "A B", UtteranceID: "vad-2", SpeechEpoch: 2, EndMs: &secondEnd,
	})
	association.prepare(core.Event{
		Type: "translation_done", Text: "A B", UtteranceID: "vad-2", SpeechEpoch: 2, EndMs: &secondEnd,
	})
	association.prepare(core.Event{
		Type: "source_vad_commit", UtteranceID: "vad-2", SpeechEpoch: 2,
	})
	association.observeTarget(speechCursorTarget{speechEpoch: 3, utteranceID: "vad-3"})
	association.prepare(core.Event{
		Type: "model_output", Text: "A B C", UtteranceID: "vad-3", SpeechEpoch: 3,
	})

	association.prepare(core.Event{
		Type: "model_output", Text: "A revised", UtteranceID: "vad-1", SpeechEpoch: 1, EndMs: &revisedEnd,
	})
	pending := association.drainPendingEvents()
	if len(pending) != 2 || pending[0].Type != "model_output_reset" ||
		pending[0].UtteranceID != "vad-2" || pending[1].Type != "model_output_reset" ||
		pending[1].UtteranceID != "vad-3" {
		t.Fatalf("dependent successor resets = %#v", pending)
	}
	if association.validatedAnchor("vad-2").valid || association.validatedAnchor("vad-3").valid {
		t.Fatalf("dependent successor anchors must remain invalid after predecessor revision")
	}
}

func TestModelOutputTranscriptAssociationKeepsFinalAnchorOnDuplicateSnapshot(t *testing.T) {
	association := modelOutputTranscriptAssociation{}
	firstEnd, replayEnd := int64(100), int64(120)
	association.observeTarget(speechCursorTarget{speechEpoch: 1, utteranceID: "vad-1"})
	association.prepare(core.Event{
		Type: "model_output", Text: "A", UtteranceID: "vad-1", SpeechEpoch: 1, EndMs: &firstEnd,
	})
	association.prepare(core.Event{
		Type: "translation_done", Text: "A", UtteranceID: "vad-1", SpeechEpoch: 1, EndMs: &firstEnd,
	})
	association.prepare(core.Event{
		Type: "source_vad_commit", UtteranceID: "vad-1", SpeechEpoch: 1,
	})
	association.observeTarget(speechCursorTarget{speechEpoch: 2, utteranceID: "vad-2"})
	firstPreview := association.prepare(core.Event{
		Type: "model_output", Text: "A B", UtteranceID: "vad-2", SpeechEpoch: 2,
	})
	association.prepare(core.Event{
		Type: "model_output", Text: "A", UtteranceID: "vad-1", SpeechEpoch: 1, EndMs: &replayEnd,
	})
	secondPreview := association.prepare(core.Event{
		Type: "model_output", Text: "A B more", UtteranceID: "vad-2", SpeechEpoch: 2,
	})

	if firstPreview.EpochText != "B" || secondPreview.EpochText != "B more" ||
		len(association.drainPendingEvents()) != 0 {
		t.Fatalf("duplicate predecessor must keep its final anchor: first=%q second=%q",
			firstPreview.EpochText, secondPreview.EpochText)
	}
}

func TestModelOutputTranscriptAssociationRejectsOlderEpochWithinSameUtterance(t *testing.T) {
	association := modelOutputTranscriptAssociation{}
	association.observeTarget(speechCursorTarget{speechEpoch: 1, utteranceID: "vad-1"})
	first := association.prepare(core.Event{
		Type: "model_output", Text: "First", UtteranceID: "vad-1", SpeechEpoch: 1,
	})
	association.observeTarget(speechCursorTarget{speechEpoch: 2, utteranceID: "vad-1"})
	newer := association.prepare(core.Event{
		Type: "model_output", Text: "First extended", UtteranceID: "vad-1", SpeechEpoch: 2,
	})
	lateOld := association.prepare(core.Event{
		Type: "model_output", Text: "First old", EpochText: "First old",
		UtteranceID: "vad-1", SpeechEpoch: 1,
	})

	if first.EpochText != "First" || newer.EpochText != "First extended" || lateOld.EpochText != "" {
		t.Fatalf("first = %q, newer = %q, late old = %q", first.EpochText, newer.EpochText, lateOld.EpochText)
	}
}

func TestTranslationTranscriptAssociationBuildsOrderedUtteranceLocalText(t *testing.T) {
	association := translationTranscriptAssociation{}
	firstStart, secondStart := int64(100), int64(900)

	second := association.prepare(core.Event{
		Type: "translation_done", Text: "First. Second.",
		SegmentID: "segment-2", SegmentText: "Second.", UtteranceID: "vad-4",
		StartMs: &secondStart,
	})
	if second.EpochText != "Second." {
		t.Fatalf("second-first epoch text = %q", second.EpochText)
	}
	first := association.prepare(core.Event{
		Type: "translation_done", Text: "First. Second.",
		SegmentID: "segment-1", SegmentText: "First.", UtteranceID: "vad-4",
		StartMs: &firstStart,
	})
	if first.EpochText != "First. Second." {
		t.Fatalf("ordered epoch text = %q", first.EpochText)
	}
	revised := association.prepare(core.Event{
		Type: "translation_done", Text: "First revised. Second.",
		SegmentID: "segment-1b", SegmentText: "First revised.", UtteranceID: "vad-4",
		ReplaceSegmentIDs: []string{"segment-1"}, StartMs: &firstStart,
	})
	if revised.EpochText != "First revised. Second." {
		t.Fatalf("revised epoch text = %q", revised.EpochText)
	}
	untimedRevision := association.prepare(core.Event{
		Type: "translation_done", Text: "A. Second.",
		SegmentID: "segment-1c", SegmentText: "A.", UtteranceID: "vad-4",
		ReplaceSegmentIDs: []string{"segment-1b"},
	})
	if untimedRevision.EpochText != "A. Second." {
		t.Fatalf("untimed timed-segment revision = %q", untimedRevision.EpochText)
	}
	other := association.prepare(core.Event{
		Type: "translation_done", SegmentID: "segment-3", SegmentText: "Other.",
		UtteranceID: "vad-5",
	})
	if other.EpochText != "Other." {
		t.Fatalf("other utterance epoch text = %q", other.EpochText)
	}

	untimed := translationTranscriptAssociation{}
	for _, event := range []core.Event{
		{Type: "translation_done", Text: "First.", SegmentID: "word", SegmentText: "First.", UtteranceID: "vad-6"},
		{Type: "translation_done", Text: "First. Second.", SegmentID: "word", SegmentText: "Second.", UtteranceID: "vad-6"},
		{Type: "translation_done", Text: "First. Second.", SegmentID: "word", SegmentText: "Second.", UtteranceID: "vad-6"},
	} {
		other = untimed.prepare(event)
	}
	if other.EpochText != "First. Second." {
		t.Fatalf("same-id stable increments = %q", other.EpochText)
	}
	other = untimed.prepare(core.Event{
		Type: "translation_done", SegmentID: "replacement", SegmentText: "First revised.",
		ReplaceSegmentIDs: []string{"word"}, UtteranceID: "vad-6",
	})
	if other.EpochText != "First revised." {
		t.Fatalf("untimed replacement order = %q", other.EpochText)
	}

	untimedOrder := translationTranscriptAssociation{}
	_ = untimedOrder.prepare(core.Event{
		Type: "translation_done", Text: "First.", SegmentID: "s1", SegmentText: "First.", UtteranceID: "vad-8",
	})
	_ = untimedOrder.prepare(core.Event{
		Type: "translation_done", Text: "First. Second.", SegmentID: "s2", SegmentText: "Second.", UtteranceID: "vad-8",
	})
	other = untimedOrder.prepare(core.Event{
		Type: "translation_done", Text: "First revised. Second.", SegmentID: "s1b", SegmentText: "First revised.",
		ReplaceSegmentIDs: []string{"s1"}, UtteranceID: "vad-8",
	})
	if other.EpochText != "First revised. Second." {
		t.Fatalf("untimed replacement kept position = %q", other.EpochText)
	}
	other = untimedOrder.prepare(core.Event{
		Type: "translation_done", Text: "First.", SegmentID: "s1", SegmentText: "First.", UtteranceID: "vad-8",
	})
	if other.EpochText != "First revised. Second." {
		t.Fatalf("replayed replaced segment = %q", other.EpochText)
	}

	sameID := translationTranscriptAssociation{}
	_ = sameID.prepare(core.Event{
		Type: "translation_done", Text: "Old.", SegmentID: "shared", SegmentText: "Old.", UtteranceID: "vad-10",
	})
	other = sameID.prepare(core.Event{
		Type: "translation_done", Text: "New.", SegmentID: "shared", SegmentText: "New.",
		ReplaceSegmentIDs: []string{"shared"}, UtteranceID: "vad-10",
	})
	if other.EpochText != "New." {
		t.Fatalf("same-id replacement = %q", other.EpochText)
	}
	other = sameID.prepare(core.Event{
		Type: "translation_done", Text: "New. Tail.", SegmentID: "shared", SegmentText: "Tail.", UtteranceID: "vad-10",
	})
	if other.EpochText != "New. Tail." {
		t.Fatalf("same-id increment after replacement = %q", other.EpochText)
	}
	other = sameID.prepare(core.Event{
		Type: "translation_done", Text: "Old.", SegmentID: "shared", SegmentText: "Old.", UtteranceID: "vad-10",
	})
	if other.EpochText != "New. Tail." {
		t.Fatalf("replayed old same-id segment = %q", other.EpochText)
	}

	repeatedWords := translationTranscriptAssociation{}
	_ = repeatedWords.prepare(core.Event{
		Type: "translation_done", Text: "very", SegmentID: "word-1", SegmentText: "very", UtteranceID: "vad-9",
	})
	other = repeatedWords.prepare(core.Event{
		Type: "translation_done", Text: "very very", SegmentID: "word-2", SegmentText: "very", UtteranceID: "vad-9",
	})
	if other.EpochText != "very very" {
		t.Fatalf("repeated stable words = %q", other.EpochText)
	}

	mixed := translationTranscriptAssociation{}
	explicit := mixed.prepare(core.Event{
		Type: "translation_done", SegmentID: "explicit", SegmentText: "Current.",
		EpochText: "Current.", UtteranceID: "vad-7",
	})
	if explicit.EpochText != "Current." {
		t.Fatalf("explicit epoch text = %q", explicit.EpochText)
	}
	afterExplicit := mixed.prepare(core.Event{
		Type: "translation_done", SegmentID: "next", SegmentText: "Next.", UtteranceID: "vad-7",
	})
	if afterExplicit.EpochText != "Current. Next." {
		t.Fatalf("mixed explicit and segment text = %q", afterExplicit.EpochText)
	}
}

func TestSidecarAssociatesNonGatedSourceEventsWithPrimaryVAD(t *testing.T) {
	vadReady := make(chan struct{})
	sourceEmitted := make(chan struct{})
	primary := stubProvider{
		name: "primary",
		run: func(
			_ context.Context,
			_ core.SessionConfig,
			_ <-chan []byte,
			events chan<- core.Event,
		) error {
			startMs := int64(120)
			events <- core.Event{
				Type: "source_vad_state", State: "speech_start", SpeechEpoch: 7, StartMs: &startMs,
			}
			close(vadReady)
			<-sourceEmitted
			events <- core.Event{Type: "model_output", Text: "Hello."}
			events <- core.Event{Type: "state", State: "finished"}
			return nil
		},
	}
	source := stubProvider{
		name: "source",
		run: func(
			_ context.Context,
			_ core.SessionConfig,
			_ <-chan []byte,
			events chan<- core.Event,
		) error {
			<-vadReady
			events <- core.Event{Type: "source_update", Text: "你好", SegmentID: "item-7", SegmentText: "你好"}
			events <- core.Event{Type: "source_done", Text: "你好。", SegmentID: "item-7", SegmentText: "你好。"}
			close(sourceEmitted)
			return nil
		},
	}
	audio := make(chan []byte)
	close(audio)
	events := make(chan core.Event, 8)

	if err := (SidecarProvider{Primary: primary, Source: source}).Run(
		context.Background(), core.SessionConfig{}, audio, events,
	); err != nil {
		t.Fatalf("Run: %v", err)
	}
	close(events)

	var sourceEvents []core.Event
	var modelOutput *core.Event
	for event := range events {
		if isSourceTranscriptEvent(event) {
			sourceEvents = append(sourceEvents, event)
		}
		if event.Type == "model_output" {
			copied := event
			modelOutput = &copied
		}
	}
	if len(sourceEvents) != 2 {
		t.Fatalf("source events = %#v", sourceEvents)
	}
	for _, event := range sourceEvents {
		if event.UtteranceID != "vad-7" || event.SpeechEpoch != 7 || event.EpochText == "" {
			t.Fatalf("unassociated source event = %#v", event)
		}
	}
	if modelOutput == nil || modelOutput.UtteranceID != "vad-7" || modelOutput.SpeechEpoch != 7 {
		t.Fatalf("model output = %#v", modelOutput)
	}
}

func TestSidecarCommitsNonGatedVADBoundaryBeforeNextSpeech(t *testing.T) {
	primary := stubProvider{
		name: "primary",
		run: func(
			_ context.Context,
			_ core.SessionConfig,
			_ <-chan []byte,
			events chan<- core.Event,
		) error {
			firstStartMs, firstEndMs, secondStartMs := int64(992), int64(2528), int64(4544)
			events <- core.Event{
				Type: "source_vad_state", State: "speech_start", SpeechEpoch: 1, StartMs: &firstStartMs,
			}
			events <- core.Event{
				Type: "source_vad_state", State: "speech_endpoint", SpeechEpoch: 1, EndMs: &firstEndMs,
			}
			events <- core.Event{
				Type: "source_vad_state", State: "speech_start", SpeechEpoch: 2, StartMs: &secondStartMs,
			}
			events <- core.Event{Type: "model_output", Text: "Second sentence."}
			events <- core.Event{Type: "state", State: "finished"}
			return nil
		},
	}
	source := stubProvider{
		name: "source",
		run: func(
			_ context.Context,
			_ core.SessionConfig,
			_ <-chan []byte,
			_ chan<- core.Event,
		) error {
			return nil
		},
	}
	audio := make(chan []byte)
	close(audio)
	events := make(chan core.Event, 8)

	if err := (SidecarProvider{
		Primary: primary, Source: source, SourceVADSilenceCommitMs: 2000,
	}).Run(context.Background(), core.SessionConfig{}, audio, events); err != nil {
		t.Fatalf("Run: %v", err)
	}
	close(events)

	var commit *core.Event
	var secondStart *core.Event
	var modelOutput *core.Event
	for event := range events {
		switch {
		case event.Type == "source_vad_commit":
			copied := event
			commit = &copied
		case event.Type == "source_vad_state" && event.State == "speech_start" && event.SpeechEpoch == 2:
			copied := event
			secondStart = &copied
		case event.Type == "model_output":
			copied := event
			modelOutput = &copied
		}
	}
	if commit == nil || commit.UtteranceID != "vad-1" || commit.SpeechEpoch != 1 ||
		commit.EndMs == nil || *commit.EndMs != 4528 {
		t.Fatalf("synthetic commit = %#v", commit)
	}
	if secondStart == nil || secondStart.UtteranceID != "vad-2" {
		t.Fatalf("second speech start = %#v", secondStart)
	}
	if modelOutput == nil || modelOutput.UtteranceID != "vad-2" || modelOutput.SpeechEpoch != 2 {
		t.Fatalf("second model output = %#v", modelOutput)
	}
}

func TestSidecarFallsBackToSubsequentPrimarySourceEventsAfterFailure(t *testing.T) {
	failSource := make(chan struct{})
	primaryFallbackReady := make(chan struct{})
	primary := stubProvider{
		name: "primary",
		run: func(
			_ context.Context,
			_ core.SessionConfig,
			_ <-chan []byte,
			events chan<- core.Event,
		) error {
			events <- core.Event{Type: "source_update", Text: "primary before failure"}
			events <- core.Event{Type: "translation_delta", Text: "marker"}
			<-primaryFallbackReady
			events <- core.Event{Type: "source_update", Text: "primary after failure"}
			events <- core.Event{Type: "source_done", Text: "primary final"}
			events <- core.Event{Type: "state", State: "finished"}
			return nil
		},
	}
	sourceFailure := errors.New("ASR unavailable")
	source := stubProvider{
		name: "source",
		run: func(
			_ context.Context,
			_ core.SessionConfig,
			_ <-chan []byte,
			_ chan<- core.Event,
		) error {
			<-failSource
			return sourceFailure
		},
	}
	events := make(chan core.Event, 8)
	runDone := make(chan error, 1)
	go func() {
		runDone <- (SidecarProvider{
			Primary: primary,
			Source:  source,
			OnError: func(err error) {
				if !errors.Is(err, sourceFailure) {
					t.Errorf("warning = %v, want %v", err, sourceFailure)
				}
				close(primaryFallbackReady)
			},
		}).Run(context.Background(), core.SessionConfig{}, make(chan []byte), events)
	}()

	marker := <-events
	if marker.Type != "translation_delta" || marker.Text != "marker" {
		t.Fatalf("first forwarded event = %#v, want translation marker", marker)
	}
	close(failSource)
	if err := <-runDone; err != nil {
		t.Fatalf("Run: %v", err)
	}
	close(events)

	var got []core.Event
	for event := range events {
		got = append(got, event)
	}
	var forwardedFailure bool
	var fallback []core.Event
	for _, event := range got {
		if event.Type == "asr_error" {
			forwardedFailure = event.Error == sourceFailure.Error()
			continue
		}
		fallback = append(fallback, event)
	}
	if !forwardedFailure || len(fallback) != 4 ||
		fallback[0].Type != "source_update" || fallback[0].Text != "primary before failure" ||
		fallback[1].Type != "source_update" || fallback[1].Text != "primary after failure" ||
		fallback[2].Type != "source_done" || fallback[2].Text != "primary final" ||
		fallback[3].Type != "state" || fallback[3].State != "finished" {
		t.Fatalf("fallback events = %#v", got)
	}
}

func TestSidecarFailureAfterAudioClosesFlushesPrimarySourceTerminalState(t *testing.T) {
	primaryFinished := make(chan struct{})
	primary := stubProvider{
		name: "primary",
		run: func(
			_ context.Context,
			_ core.SessionConfig,
			audio <-chan []byte,
			events chan<- core.Event,
		) error {
			defer close(primaryFinished)
			for range audio {
			}
			events <- core.Event{Type: "source_update", Text: "你好世界"}
			events <- core.Event{Type: "source_done", Text: "你好世界。"}
			events <- core.Event{Type: "state", State: "finished"}
			return nil
		},
	}
	sourceFailure := errors.New("ASR failed while draining")
	source := stubProvider{
		name: "source",
		run: func(
			_ context.Context,
			_ core.SessionConfig,
			audio <-chan []byte,
			_ chan<- core.Event,
		) error {
			for range audio {
			}
			<-primaryFinished
			return sourceFailure
		},
	}
	var warning error
	audio := make(chan []byte)
	close(audio)
	events := make(chan core.Event, 4)

	if err := (SidecarProvider{
		Primary: primary,
		Source:  source,
		OnError: func(err error) {
			warning = err
		},
	}).Run(context.Background(), core.SessionConfig{}, audio, events); err != nil {
		t.Fatalf("Run: %v", err)
	}
	close(events)

	var got []core.Event
	for event := range events {
		got = append(got, event)
	}
	if len(got) != 4 ||
		got[0].Type != "source_update" || got[0].Text != "你好世界" ||
		got[1].Type != "source_done" || got[1].Text != "你好世界。" ||
		got[2].Type != "asr_error" || got[2].Error != sourceFailure.Error() ||
		got[3].Type != "state" || got[3].State != "finished" {
		t.Fatalf("events = %#v", got)
	}
	if !errors.Is(warning, sourceFailure) {
		t.Fatalf("warning = %v, want %v", warning, sourceFailure)
	}
}

func TestSidecarCancellationReturnsWithoutEventConsumer(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	primaryEmitted := make(chan struct{})
	primary := stubProvider{
		name: "primary",
		run: func(
			ctx context.Context,
			_ core.SessionConfig,
			_ <-chan []byte,
			events chan<- core.Event,
		) error {
			events <- core.Event{Type: "translation_delta", Text: "first"}
			events <- core.Event{Type: "translation_delta", Text: "second"}
			close(primaryEmitted)
			<-ctx.Done()
			return ctx.Err()
		},
	}
	source := stubProvider{
		name: "source",
		run: func(
			ctx context.Context,
			_ core.SessionConfig,
			_ <-chan []byte,
			_ chan<- core.Event,
		) error {
			<-ctx.Done()
			return ctx.Err()
		},
	}
	runDone := make(chan error, 1)
	go func() {
		runDone <- (SidecarProvider{Primary: primary, Source: source}).Run(
			ctx,
			core.SessionConfig{},
			make(chan []byte),
			make(chan core.Event),
		)
	}()

	<-primaryEmitted
	cancel()
	select {
	case err := <-runDone:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("Run error = %v, want context.Canceled", err)
		}
	case <-time.After(time.Second):
		t.Fatal("Run remained blocked after cancellation with no event consumer")
	}
}

func (p stubProvider) Name() string { return p.name }
func (p stubProvider) Ready() bool  { return true }
func (p stubProvider) Run(
	ctx context.Context,
	config core.SessionConfig,
	audio <-chan []byte,
	events chan<- core.Event,
) error {
	return p.run(ctx, config, audio, events)
}

func TestSidecarCopiesAudioAndDoesNotFailPrimaryWhenASRFails(t *testing.T) {
	var mu sync.Mutex
	var primaryChunks [][]byte
	primary := stubProvider{
		name: "primary",
		run: func(
			_ context.Context,
			_ core.SessionConfig,
			audio <-chan []byte,
			_ chan<- core.Event,
		) error {
			for chunk := range audio {
				mu.Lock()
				primaryChunks = append(primaryChunks, append([]byte(nil), chunk...))
				mu.Unlock()
			}
			return nil
		},
	}
	sourceFailure := errors.New("ASR unavailable")
	source := stubProvider{
		name: "source",
		run: func(
			_ context.Context,
			_ core.SessionConfig,
			audio <-chan []byte,
			_ chan<- core.Event,
		) error {
			<-audio
			return sourceFailure
		},
	}
	var warning error
	provider := SidecarProvider{
		Primary: primary,
		Source:  source,
		OnError: func(err error) {
			warning = err
		},
	}
	audio := make(chan []byte, 2)
	audio <- []byte{1, 2}
	audio <- []byte{3, 4}
	close(audio)

	if err := provider.Run(
		context.Background(),
		core.SessionConfig{},
		audio,
		make(chan core.Event, 1),
	); err != nil {
		t.Fatalf("primary result must win: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(primaryChunks) != 2 {
		t.Fatalf("primary chunks = %v, want two chunks", primaryChunks)
	}
	if !errors.Is(warning, sourceFailure) {
		t.Fatalf("warning = %v, want %v", warning, sourceFailure)
	}
}

func TestVADCommitTrackerUsesSourceTimelineInsteadOfBackendTimer(t *testing.T) {
	tracker := sourceVADCommitTracker{thresholdMs: 2000}
	endMs := int64(54_784)
	tracker.observe(core.Event{
		Type: "source_vad_state", State: "speech_endpoint", SpeechEpoch: 9,
		UtteranceID: "vad-9", EndMs: &endMs,
	})

	// This is the production bad case: the next speech started 336 ms before
	// the source timeline could reach the VAD threshold. A wall-clock timer
	// raced the delayed event and used to emit a false commit here.
	resumedBeforeThreshold := int64(56_448)
	if commit := tracker.before(core.Event{
		Type: "source_vad_state", State: "speech_start", SpeechEpoch: 10,
		StartMs: &resumedBeforeThreshold,
	}); commit != nil {
		t.Fatalf("false VAD commit = %#v", commit)
	}

	tracker.observe(core.Event{
		Type: "source_vad_state", State: "speech_endpoint", SpeechEpoch: 10,
		UtteranceID: "vad-10", EndMs: &endMs,
	})
	resumedAfterThreshold := int64(57_120)
	commit := tracker.before(core.Event{
		Type: "source_vad_state", State: "speech_start", SpeechEpoch: 11,
		StartMs: &resumedAfterThreshold,
	})
	if commit == nil || commit.Type != "source_vad_commit" || commit.State != "silence_threshold" ||
		commit.SpeechEpoch != 10 || commit.UtteranceID != "vad-10" ||
		commit.EndMs == nil || *commit.EndMs != 56_784 {
		t.Fatalf("commit = %#v", commit)
	}
}

func TestVADCommitTrackerCommitsExplicitSilenceThresholdImmediately(t *testing.T) {
	tracker := sourceVADCommitTracker{thresholdMs: 2000}
	endpointMs := int64(96)
	tracker.observe(core.Event{
		Type: "source_vad_state", State: "speech_endpoint", SpeechEpoch: 1,
		UtteranceID: "vad-1", EndMs: &endpointMs,
	})

	thresholdMs := int64(1120)
	commit := tracker.observe(core.Event{
		Type: "source_vad_state", State: "silence_threshold", SpeechEpoch: 1,
		UtteranceID: "vad-1", EndMs: &thresholdMs,
	})
	if commit == nil || commit.Type != "source_vad_commit" || commit.State != "silence_threshold" ||
		commit.SpeechEpoch != 1 || commit.UtteranceID != "vad-1" ||
		commit.EndMs == nil || *commit.EndMs != thresholdMs {
		t.Fatalf("commit = %#v", commit)
	}
}

func TestSidecarCommitsExplicitSilenceThresholdWithoutNextSpeech(t *testing.T) {
	primary := stubProvider{
		name: "primary",
		run: func(
			_ context.Context,
			_ core.SessionConfig,
			_ <-chan []byte,
			events chan<- core.Event,
		) error {
			startMs, endpointMs, thresholdMs := int64(0), int64(96), int64(1120)
			events <- core.Event{
				Type: "source_vad_state", State: "speech_start", SpeechEpoch: 1, StartMs: &startMs,
			}
			events <- core.Event{
				Type: "source_vad_state", State: "speech_endpoint", SpeechEpoch: 1, EndMs: &endpointMs,
			}
			events <- core.Event{
				Type: "source_vad_state", State: "silence_threshold", SpeechEpoch: 1, EndMs: &thresholdMs,
			}
			events <- core.Event{Type: "state", State: "finished"}
			return nil
		},
	}
	source := stubProvider{
		name: "source",
		run: func(
			ctx context.Context,
			_ core.SessionConfig,
			audio <-chan []byte,
			_ chan<- core.Event,
		) error {
			for {
				select {
				case <-ctx.Done():
					return ctx.Err()
				case _, ok := <-audio:
					if !ok {
						return nil
					}
				}
			}
		},
	}
	audio := make(chan []byte)
	close(audio)
	events := make(chan core.Event, 8)

	if err := (SidecarProvider{
		Primary: primary, Source: source, SourceVADSilenceCommitMs: 2000,
	}).Run(context.Background(), core.SessionConfig{}, audio, events); err != nil {
		t.Fatalf("Run: %v", err)
	}
	close(events)

	var commit *core.Event
	for event := range events {
		if event.Type == "source_vad_commit" {
			copied := event
			commit = &copied
		}
	}
	if commit == nil || commit.SpeechEpoch != 1 || commit.UtteranceID != "vad-1" ||
		commit.EndMs == nil || *commit.EndMs != 1120 {
		t.Fatalf("commit = %#v", commit)
	}
}

func TestRewriteSegmentedSourceEventKeepsLegacyCumulativeTextAndEpochText(t *testing.T) {
	startMs, endMs := int64(20), int64(180)
	event, committed := rewriteSegmentedSourceEvent(core.Event{
		Type: "source_done", Text: "第二句。", SegmentText: "第二句。",
		StartMs: &startMs, EndMs: &endMs,
	}, "第一句。", 1000, 4, "vad-4")

	if event.Text != "第一句。第二句。" || event.EpochText != "第二句。" ||
		event.SpeechEpoch != 4 || event.UtteranceID != "vad-4" ||
		event.StartMs == nil || *event.StartMs != 1020 ||
		event.EndMs == nil || *event.EndMs != 1180 || committed != event.Text {
		t.Fatalf("rewritten = %#v, committed = %q", event, committed)
	}
}

func TestSidecarDoesNotRouteNextUtteranceFirstModelOutputToCommittedPair(t *testing.T) {
	primary := stubProvider{
		name: "primary",
		run: func(
			_ context.Context,
			_ core.SessionConfig,
			_ <-chan []byte,
			events chan<- core.Event,
		) error {
			events <- core.Event{Type: "source_vad_state", State: "speech_start", SpeechEpoch: 4}
			events <- core.Event{Type: "source_vad_commit", State: "silence_threshold", SpeechEpoch: 4, UtteranceID: "vad-4"}
			// The forced generation for epoch 4 produced no model_output.
			events <- core.Event{Type: "source_vad_state", State: "speech_start", SpeechEpoch: 5}
			events <- core.Event{Type: "model_output", Text: "Previous sentence. First,"}
			events <- core.Event{Type: "state", State: "finished"}
			return nil
		},
	}
	source := stubProvider{
		name: "source",
		run: func(
			ctx context.Context,
			_ core.SessionConfig,
			audio <-chan []byte,
			_ chan<- core.Event,
		) error {
			for {
				select {
				case <-ctx.Done():
					return ctx.Err()
				case _, ok := <-audio:
					if !ok {
						return nil
					}
				}
			}
		},
	}
	audio := make(chan []byte)
	close(audio)
	events := make(chan core.Event, 8)

	if err := (SidecarProvider{Primary: primary, Source: source}).Run(
		context.Background(), core.SessionConfig{}, audio, events,
	); err != nil {
		t.Fatalf("Run: %v", err)
	}
	close(events)

	var modelOutput *core.Event
	for event := range events {
		if event.Type == "model_output" {
			copied := event
			modelOutput = &copied
		}
	}
	if modelOutput == nil {
		t.Fatal("model_output was not forwarded")
	}
	if modelOutput.UtteranceID != "vad-5" || modelOutput.SpeechEpoch != 5 {
		t.Fatalf("model_output = %#v, want utterance vad-5 in epoch 5", *modelOutput)
	}
}

func TestSidecarKeepsPostCommitModelOutputOnCommittedPairBeforeNextSpeech(t *testing.T) {
	primary := stubProvider{
		name: "primary",
		run: func(
			_ context.Context,
			_ core.SessionConfig,
			_ <-chan []byte,
			events chan<- core.Event,
		) error {
			events <- core.Event{Type: "source_vad_state", State: "speech_start", SpeechEpoch: 4}
			events <- core.Event{Type: "source_vad_commit", State: "silence_threshold", SpeechEpoch: 4, UtteranceID: "vad-4"}
			events <- core.Event{Type: "model_output", Text: "Previous sentence."}
			events <- core.Event{Type: "state", State: "finished"}
			return nil
		},
	}
	source := stubProvider{
		name: "source",
		run: func(
			ctx context.Context,
			_ core.SessionConfig,
			audio <-chan []byte,
			_ chan<- core.Event,
		) error {
			for {
				select {
				case <-ctx.Done():
					return ctx.Err()
				case _, ok := <-audio:
					if !ok {
						return nil
					}
				}
			}
		},
	}
	audio := make(chan []byte)
	close(audio)
	events := make(chan core.Event, 8)

	if err := (SidecarProvider{Primary: primary, Source: source}).Run(
		context.Background(), core.SessionConfig{}, audio, events,
	); err != nil {
		t.Fatalf("Run: %v", err)
	}
	close(events)

	for event := range events {
		if event.Type != "model_output" {
			continue
		}
		if event.UtteranceID != "vad-4" || event.SpeechEpoch != 4 {
			t.Fatalf("model_output = %#v, want committed utterance vad-4 in epoch 4", event)
		}
		return
	}
	t.Fatal("model_output was not forwarded")
}

func TestSidecarRoutesLateModelOutputBackBySourceCursorAfterNextSpeechStarts(t *testing.T) {
	oldStartMs, oldCursorMs := int64(38_592), int64(41_376)
	newStartMs, newEndMs := int64(44_160), int64(46_016)
	primary := stubProvider{
		name: "primary",
		run: func(
			_ context.Context,
			_ core.SessionConfig,
			_ <-chan []byte,
			events chan<- core.Event,
		) error {
			events <- core.Event{
				Type: "source_vad_state", State: "speech_start", SpeechEpoch: 8,
				StartMs: &oldStartMs,
			}
			events <- core.Event{
				Type: "source_vad_state", State: "speech_endpoint", SpeechEpoch: 8,
				EndMs: &oldCursorMs,
			}
			events <- core.Event{
				Type: "source_vad_state", State: "speech_start", SpeechEpoch: 9,
				StartMs: &newStartMs,
			}
			// The epoch-8 forced inference completes after epoch 9 has already started.
			events <- core.Event{
				Type: "translation_done", Text: "Previous sentence tail.", SegmentID: "old-segment",
				EndMs: &oldCursorMs,
			}
			events <- core.Event{Type: "model_output", Text: "Previous sentence tail.", EndMs: &oldCursorMs}
			events <- core.Event{Type: "audio", SegmentID: "old-segment"}
			events <- core.Event{
				Type: "translation_done", Text: "New sentence.", SegmentID: "new-segment",
				EndMs: &newEndMs,
			}
			events <- core.Event{Type: "model_output", Text: "Previous sentence tail. New sentence.", EndMs: &newEndMs}
			events <- core.Event{Type: "audio_done", SegmentID: "new-segment"}
			events <- core.Event{Type: "state", State: "finished"}
			return nil
		},
	}
	source := stubProvider{
		name: "source",
		run: func(
			ctx context.Context,
			_ core.SessionConfig,
			audio <-chan []byte,
			_ chan<- core.Event,
		) error {
			for {
				select {
				case <-ctx.Done():
					return ctx.Err()
				case _, ok := <-audio:
					if !ok {
						return nil
					}
				}
			}
		},
	}
	audio := make(chan []byte)
	close(audio)
	events := make(chan core.Event, 18)

	if err := (SidecarProvider{
		Primary: primary, Source: source, GateSourceWithPrimaryVAD: true,
		SourceVADSilenceCommitMs: 2000,
	}).Run(
		context.Background(), core.SessionConfig{}, audio, events,
	); err != nil {
		t.Fatalf("Run: %v", err)
	}
	close(events)

	var modelOutputs []core.Event
	var translations []core.Event
	var audioEvents []core.Event
	var commit *core.Event
	for event := range events {
		if event.Type == "model_output" {
			modelOutputs = append(modelOutputs, event)
		}
		if event.Type == "translation_done" {
			translations = append(translations, event)
		}
		if event.Type == "audio" || event.Type == "audio_done" {
			audioEvents = append(audioEvents, event)
		}
		if event.Type == "source_vad_commit" {
			copied := event
			commit = &copied
		}
	}
	if commit == nil || commit.SpeechEpoch != 8 || commit.UtteranceID != "vad-8" ||
		commit.EndMs == nil || *commit.EndMs != 43_376 {
		t.Fatalf("source timeline commit = %#v", commit)
	}
	if len(modelOutputs) != 2 {
		t.Fatalf("model outputs = %#v, want two", modelOutputs)
	}
	if modelOutputs[0].UtteranceID != "vad-8" || modelOutputs[0].SpeechEpoch != 8 {
		t.Fatalf("late old output = %#v, want utterance vad-8 in epoch 8", modelOutputs[0])
	}
	if modelOutputs[0].EpochText != "Previous sentence tail." {
		t.Fatalf("late old preview = %q", modelOutputs[0].EpochText)
	}
	if modelOutputs[1].UtteranceID != "vad-9" || modelOutputs[1].SpeechEpoch != 9 ||
		modelOutputs[1].EpochText != "New sentence." {
		t.Fatalf("new output = %#v, want utterance vad-9 in epoch 9", modelOutputs[1])
	}
	if len(translations) != 2 || translations[0].UtteranceID != "vad-8" || translations[0].SpeechEpoch != 8 ||
		translations[1].UtteranceID != "vad-9" || translations[1].SpeechEpoch != 9 {
		t.Fatalf("delayed translations = %#v", translations)
	}
	if len(audioEvents) != 2 || audioEvents[0].UtteranceID != "vad-8" || audioEvents[0].SpeechEpoch != 8 ||
		audioEvents[1].UtteranceID != "vad-9" || audioEvents[1].SpeechEpoch != 9 {
		t.Fatalf("segment-routed audio = %#v", audioEvents)
	}
}

func TestSidecarRoutesCursorlessModelOutputByMatchingLateTranslationDone(t *testing.T) {
	oldStartMs, oldEndMs := int64(0), int64(1_000)
	newStartMs, newEndMs := int64(3_000), int64(3_500)
	primary := stubProvider{
		name: "primary",
		run: func(
			_ context.Context,
			_ core.SessionConfig,
			_ <-chan []byte,
			events chan<- core.Event,
		) error {
			events <- core.Event{Type: "source_vad_state", State: "speech_start", SpeechEpoch: 1, StartMs: &oldStartMs}
			events <- core.Event{Type: "model_output", Text: "Hello"}
			events <- core.Event{
				Type: "translation_done", Text: "Hello", SegmentID: "old-1", SegmentText: "Hello", EndMs: &oldEndMs,
			}
			events <- core.Event{Type: "source_vad_state", State: "speech_endpoint", SpeechEpoch: 1, EndMs: &oldEndMs}
			events <- core.Event{Type: "source_vad_state", State: "speech_start", SpeechEpoch: 2, StartMs: &newStartMs}
			// A late old-utterance done retains its cursor, while the matching model
			// snapshot can arrive immediately afterwards without one.
			events <- core.Event{
				Type: "translation_done", Text: "Hello\nworld", SegmentID: "old-2", SegmentText: "world", EndMs: &oldEndMs,
			}
			events <- core.Event{Type: "model_output", Text: "Hello world"}
			events <- core.Event{Type: "model_output", Text: "Hello world Next", EndMs: &newEndMs}
			events <- core.Event{Type: "state", State: "finished"}
			return nil
		},
	}
	source := stubProvider{
		name: "source",
		run: func(
			ctx context.Context,
			_ core.SessionConfig,
			audio <-chan []byte,
			_ chan<- core.Event,
		) error {
			for {
				select {
				case <-ctx.Done():
					return ctx.Err()
				case _, ok := <-audio:
					if !ok {
						return nil
					}
				}
			}
		},
	}
	audio := make(chan []byte)
	close(audio)
	events := make(chan core.Event, 20)
	if err := (SidecarProvider{
		Primary: primary, Source: source, SourceVADSilenceCommitMs: 1_000,
	}).Run(context.Background(), core.SessionConfig{}, audio, events); err != nil {
		t.Fatalf("Run: %v", err)
	}
	close(events)

	var modelOutputs []core.Event
	for event := range events {
		if event.Type == "model_output" {
			modelOutputs = append(modelOutputs, event)
		}
	}
	if len(modelOutputs) != 3 {
		t.Fatalf("model outputs = %#v, want three", modelOutputs)
	}
	if modelOutputs[1].UtteranceID != "vad-1" || modelOutputs[1].SpeechEpoch != 1 ||
		modelOutputs[2].UtteranceID != "vad-2" || modelOutputs[2].SpeechEpoch != 2 ||
		modelOutputs[2].EpochText != "Next" {
		t.Fatalf("cursorless late routing = %#v", modelOutputs)
	}
}

func TestResettableSourceStartsANewProviderSessionAtEachVADCommit(t *testing.T) {
	runs := 0
	source := stubProvider{
		name: "segmented-source",
		run: func(
			_ context.Context,
			_ core.SessionConfig,
			audio <-chan []byte,
			events chan<- core.Event,
		) error {
			runs++
			currentRun := runs
			for range audio {
			}
			text := fmt.Sprintf("第%d句。", currentRun)
			startMs, endMs := int64(10), int64(90)
			events <- core.Event{
				Type: "source_done", Text: text, SegmentText: text,
				StartMs: &startMs, EndMs: &endMs,
			}
			return nil
		},
	}
	packets := make(chan sourceVADPacket, 4)
	packets <- sourceVADPacket{audio: []byte{1, 2}, startMs: 100, speechEpoch: 1, utteranceID: "vad-1"}
	packets <- sourceVADPacket{reset: true, speechEpoch: 1, utteranceID: "vad-1"}
	packets <- sourceVADPacket{audio: []byte{3, 4}, startMs: 1200, speechEpoch: 2, utteranceID: "vad-2"}
	close(packets)
	events := make(chan core.Event, 4)

	if err := runResettableSource(context.Background(), source, core.SessionConfig{}, packets, events); err != nil {
		t.Fatalf("runResettableSource: %v", err)
	}
	close(events)
	var got []core.Event
	for event := range events {
		got = append(got, event)
	}
	if runs != 2 || len(got) != 2 {
		t.Fatalf("runs = %d, events = %#v", runs, got)
	}
	if got[0].Text != "第1句。" || got[0].EpochText != "第1句。" ||
		got[0].UtteranceID != "vad-1" || got[0].SpeechEpoch != 1 ||
		got[0].StartMs == nil || *got[0].StartMs != 110 {
		t.Fatalf("first event = %#v", got[0])
	}
	if got[1].Text != "第1句。第2句。" || got[1].EpochText != "第2句。" ||
		got[1].UtteranceID != "vad-2" || got[1].SpeechEpoch != 2 ||
		got[1].StartMs == nil || *got[1].StartMs != 1210 {
		t.Fatalf("second event = %#v", got[1])
	}
}

func TestResettableSourceReconnectsAfterProviderFailure(t *testing.T) {
	runs := 0
	firstFailure := make(chan struct{})
	receivedAfterReconnect := make(chan []byte, 1)
	source := stubProvider{
		name: "reconnecting-source",
		run: func(
			_ context.Context,
			_ core.SessionConfig,
			audio <-chan []byte,
			events chan<- core.Event,
		) error {
			runs++
			if runs == 1 {
				// Fail after consuming the first packet. Otherwise the reconnect
				// may correctly replay it, filling this test's observation channel.
				<-audio
				close(firstFailure)
				return errors.New("temporary ASR failure")
			}
			for chunk := range audio {
				receivedAfterReconnect <- append([]byte(nil), chunk...)
			}
			events <- core.Event{Type: "source_done", Text: "恢复成功。"}
			return nil
		},
	}
	packets := make(chan sourceVADPacket)
	events := make(chan core.Event, 4)
	done := make(chan error, 1)
	go func() {
		done <- runResettableSource(context.Background(), source, core.SessionConfig{}, packets, events)
	}()
	packets <- sourceVADPacket{audio: []byte{1, 2}, startMs: 100, speechEpoch: 1, utteranceID: "vad-1"}
	<-firstFailure
	packets <- sourceVADPacket{audio: []byte{3, 4}, startMs: 120, speechEpoch: 1, utteranceID: "vad-1"}
	close(packets)

	if err := <-done; err != nil {
		t.Fatalf("runResettableSource: %v", err)
	}
	if runs != 2 {
		t.Fatalf("runs = %d, want 2", runs)
	}
	select {
	case got := <-receivedAfterReconnect:
		if !bytes.Equal(got, []byte{3, 4}) {
			t.Fatalf("reconnected audio = %v, want [3 4]", got)
		}
	default:
		t.Fatal("reconnected provider received no audio")
	}
	close(events)
	var got []core.Event
	for event := range events {
		got = append(got, event)
	}
	if len(got) != 2 || got[0].Type != "asr_error" || got[1].Type != "source_done" || got[1].Text != "恢复成功。" {
		t.Fatalf("events = %#v", got)
	}
}
