// Change record (2026-08-05): carry the per-session Qwen3 1s/2s inference interval.
// Change record (2026-08-05): distinguish stable Qwen2.5 model snapshots from
// revisable Qwen3 previews without changing stable translation/TTS events.
package core

import (
	"context"
	"fmt"
	"strings"
)

// EventSchemaVersion identifies the realtime provider/relay event contract.
// It is independent from persisted history schemas and WebRTC control protocols.
const EventSchemaVersion = 1

type SessionConfig struct {
	AdmissionToken         string `json:"-"`
	AdmissionOwner         string `json:"-"`
	Qwen3SimulSystemPrompt string `json:"qwen3SimulSystemPrompt,omitempty"`
	ASRContext             string `json:"asrContext,omitempty"`
	ASRContextOverride     bool   `json:"asrContextOverride,omitempty"`
	SessionID              string `json:"sessionId,omitempty"`
	Transport              string `json:"transport,omitempty"`
	ASRProvider            string `json:"asrProvider,omitempty"`
	SourceLanguage         string `json:"sourceLanguage"`
	TargetLanguage         string `json:"targetLanguage"`
	VoiceClone             bool   `json:"voiceClone"`
	// TextOnly is an internal meeting policy, never a client-controlled provider option.
	TextOnly                 bool   `json:"-"`
	VoiceCloneFrequency      string `json:"voiceCloneFrequency"`
	Voice                    string `json:"voice"`
	DeepFilterNet            bool   `json:"deepFilterNet"`
	Qwen3ModelIntervalMs     int    `json:"qwen3ModelIntervalMs,omitempty"`
	VADLoudnessThresholdDBFS int    `json:"vadLoudnessThresholdDbfs,omitempty"`
	VADLoudnessMode          string `json:"vadLoudnessMode,omitempty"`
	ASRUseFilteredAudio      bool   `json:"asrUseFilteredAudio,omitempty"`
}

type Event struct {
	InputOrigin                    string   `json:"inputOrigin,omitempty"`
	Type                           string   `json:"type"`
	TargetLanguage                 string   `json:"targetLanguage,omitempty"`
	Text                           string   `json:"text,omitempty"`
	EpochText                      string   `json:"epochText,omitempty"`
	ModelOutputStable              bool     `json:"modelOutputStable,omitempty"`
	ModelOutputAuthoritative       bool     `json:"modelOutputAuthoritative,omitempty"`
	SegmentID                      string   `json:"segmentId,omitempty"`
	SegmentText                    string   `json:"segmentText,omitempty"`
	UtteranceID                    string   `json:"utteranceId,omitempty"`
	SpeechEpoch                    int      `json:"speechEpoch,omitempty"`
	ReplaceSegmentIDs              []string `json:"replaceSegmentIds,omitempty"`
	StartMs                        *int64   `json:"startMs,omitempty"`
	EndMs                          *int64   `json:"endMs,omitempty"`
	ProviderLagMs                  *float64 `json:"providerLagMs,omitempty"`
	SynthesisDurationMs            *float64 `json:"synthesisDurationMs,omitempty"`
	AudioDurationMs                *float64 `json:"audioDurationMs,omitempty"`
	EngineFirstTextMs              *float64 `json:"engineFirstTextMs,omitempty"`
	EngineFirstTTSReadyMs          *float64 `json:"engineFirstTTSReadyMs,omitempty"`
	EngineFirstModelTokenMs        *float64 `json:"engineFirstModelTokenMs,omitempty"`
	EngineAudioToModelFeedMs       *float64 `json:"engineAudioToModelFeedMs,omitempty"`
	EngineModelFeedToFirstOutputMs *float64 `json:"engineModelFeedToFirstOutputMs,omitempty"`
	EngineModelFeedToStableTextMs  *float64 `json:"engineModelFeedToStableTextMs,omitempty"`
	EngineModelFeedToTTSReadyMs    *float64 `json:"engineModelFeedToTTSReadyMs,omitempty"`
	EngineFirstModelSubmitUnixUs   *int64   `json:"engineFirstModelSubmitUnixUs,omitempty"`
	EngineFirstTTSReadyUnixUs      *int64   `json:"engineFirstTTSReadyUnixUs,omitempty"`
	TTSError                       string   `json:"ttsError,omitempty"`
	Audio                          string   `json:"audio,omitempty"`
	SampleRate                     int      `json:"sampleRate,omitempty"`
	State                          string   `json:"state,omitempty"`
	VoiceMode                      string   `json:"voiceMode,omitempty"`
	Error                          string   `json:"error,omitempty"`
	// Seq is the per-session downlink sequence number of a resumable
	// /ws/translate session (server/ws_resume.go). Only non-audio events are
	// numbered; zero (omitted) everywhere else, so other sessions and every
	// provider see the unchanged contract.
	Seq int64 `json:"seq,omitempty"`
}

// NewTimedTextEvent normalizes provider-native subtitle timestamps to the
// same contract used by Doubao: integer milliseconds from the start of the
// input audio, represented by start and end boundaries.
func NewTimedTextEvent(eventType, accumulatedText, segmentID, segmentText string, startMs, endMs int64) Event {
	normalized := Event{Type: eventType, Text: accumulatedText}
	if strings.TrimSpace(segmentText) == "" || startMs < 0 || endMs <= startMs {
		return normalized
	}
	if strings.TrimSpace(segmentID) == "" {
		segmentID = fmt.Sprintf("%d-%d", startMs, endMs)
	}
	normalized.SegmentID = segmentID
	normalized.SegmentText = segmentText
	normalized.StartMs = &startMs
	normalized.EndMs = &endMs
	return normalized
}

// VoiceModeForClone maps a session's voice cloning request onto the effective
// voice mode reported by the ready event. Providers whose TTS backend can
// refuse cloning must report the mode they actually negotiated instead.
func VoiceModeForClone(clone bool) string {
	if clone {
		return "clone"
	}
	return "default"
}

type Provider interface {
	Name() string
	Ready() bool
	Run(context.Context, SessionConfig, <-chan []byte, chan<- Event) error
}

// EventRecorder receives observability events without participating in the
// realtime delivery path. Implementations must return immediately.
type EventRecorder interface {
	Record(string, Event)
}
