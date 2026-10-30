package core

import (
	"encoding/json"
	"testing"
)

func TestNewTimedTextEventUsesDoubaoMillisecondContract(t *testing.T) {
	event := NewTimedTextEvent("translation_done", "Hello", "", "Hello", 120, 860)
	if event.SegmentID != "120-860" || event.SegmentText != "Hello" ||
		event.StartMs == nil || *event.StartMs != 120 ||
		event.EndMs == nil || *event.EndMs != 860 {
		t.Fatalf("unexpected timed event: %#v", event)
	}
}

func TestNewTimedTextEventOmitsInvalidTimeline(t *testing.T) {
	event := NewTimedTextEvent("source_done", "你好", "segment", "你好", 860, 120)
	if event.Text != "你好" || event.StartMs != nil || event.EndMs != nil || event.SegmentID != "" {
		t.Fatalf("invalid timeline should fall back to plain text: %#v", event)
	}
}

func TestSessionMetricsEventJSONContract(t *testing.T) {
	firstText, firstTTS, firstToken := 1_250.0, 2_750.0, 800.0
	audioToFeed, feedToOutput, feedToText, feedToTTS := 400.0, 300.0, 700.0, 950.0
	firstModelSubmitUnixUs, firstTTSReadyUnixUs := int64(1_785_000_000_123_456), int64(1_785_000_002_345_678)
	payload, err := json.Marshal(Event{
		Type:                           "session_metrics",
		EngineFirstTextMs:              &firstText,
		EngineFirstTTSReadyMs:          &firstTTS,
		EngineFirstModelTokenMs:        &firstToken,
		EngineAudioToModelFeedMs:       &audioToFeed,
		EngineModelFeedToFirstOutputMs: &feedToOutput,
		EngineModelFeedToStableTextMs:  &feedToText,
		EngineModelFeedToTTSReadyMs:    &feedToTTS,
		EngineFirstModelSubmitUnixUs:   &firstModelSubmitUnixUs,
		EngineFirstTTSReadyUnixUs:      &firstTTSReadyUnixUs,
		TTSError:                       "cosyvoice unavailable",
	})
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(payload, &got); err != nil {
		t.Fatal(err)
	}
	if got["type"] != "session_metrics" ||
		got["engineFirstTextMs"] != firstText ||
		got["engineFirstTTSReadyMs"] != firstTTS ||
		got["engineFirstModelTokenMs"] != firstToken ||
		got["engineAudioToModelFeedMs"] != audioToFeed ||
		got["engineModelFeedToFirstOutputMs"] != feedToOutput ||
		got["engineModelFeedToStableTextMs"] != feedToText ||
		got["engineModelFeedToTTSReadyMs"] != feedToTTS ||
		got["engineFirstModelSubmitUnixUs"] != float64(firstModelSubmitUnixUs) ||
		got["engineFirstTTSReadyUnixUs"] != float64(firstTTSReadyUnixUs) ||
		got["ttsError"] != "cosyvoice unavailable" {
		t.Fatalf("unexpected websocket event JSON: %s", payload)
	}
}
