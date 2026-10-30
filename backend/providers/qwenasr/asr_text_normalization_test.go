package qwenasr

import (
	"simultrans/core"
	"testing"
)

func TestNormalizedASRSnapshotsKeepRevisionsLocalAfterVADReset(t *testing.T) {
	prefix := "上一段3D。"
	for _, tc := range []struct{ raw, local string }{
		{"使用三", "使用三"}, {"使用三D", "使用3D"}, {"使用三", "使用三"},
		{"使用十二GB", "使用12GB"}, {"使用五G", "使用5G"},
	} {
		text := core.NormalizeASRAlphanumericNumbers(tc.raw)
		start, end := int64(100), int64(500)
		input := core.Event{Type: "source_update", Text: text, SegmentText: text,
			SegmentID: "provider-1", StartMs: &start, EndMs: &end}
		event, committed := rewriteSegmentedSourceEvent(input, prefix, 2000, 2, "utterance-2")
		if event.Text != prefix+tc.local || event.EpochText != tc.local ||
			event.SegmentText != tc.local || committed != "" {
			t.Fatalf("%q: %#v, committed=%q", tc.raw, event, committed)
		}
		if event.SegmentID != "utterance-2:provider-1" || event.SpeechEpoch != 2 ||
			event.UtteranceID != "utterance-2" || *event.StartMs != 2100 || *event.EndMs != 2500 {
			t.Fatalf("identity/timing changed: %#v", event)
		}
	}
	text := core.NormalizeASRAlphanumericNumbers("使用三D。")
	_, committed := rewriteSegmentedSourceEvent(core.Event{Type: "source_done", Text: text, SegmentText: text},
		prefix, 2000, 2, "utterance-2")
	if committed != prefix+"使用3D。" {
		t.Fatalf("final: %q", committed)
	}
	// Reconnect/reset starts a fresh local preview without reprocessing old text.
	local := core.NormalizeASRAlphanumericNumbers("还有五G")
	event, next := rewriteSegmentedSourceEvent(core.Event{Type: "source_update", Text: local, SegmentText: local},
		committed, 3000, 3, "utterance-3")
	if event.Text != prefix+"使用3D。还有5G" || event.EpochText != "还有5G" || next != "" {
		t.Fatalf("reset: %#v, committed=%q", event, next)
	}
}
