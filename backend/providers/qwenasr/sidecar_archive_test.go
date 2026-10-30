package qwenasr

import (
	"context"
	"encoding/base64"
	"testing"

	"simultrans/core"
)

func TestSidecarPreservesFilteredAudioForServerArchive(t *testing.T) {
	for _, transport := range []string{"websocket", "webrtc"} {
		t.Run(transport, func(t *testing.T) {
			pcm := base64.StdEncoding.EncodeToString([]byte{7, 0, 8, 0})
			start := int64(32)
			primary := stubProvider{name: "primary", run: func(_ context.Context, _ core.SessionConfig, audio <-chan []byte, events chan<- core.Event) error {
				for range audio {
				}
				events <- core.Event{Type: "source_vad_audio", Audio: pcm, SampleRate: 16000, StartMs: &start}
				events <- core.Event{Type: "state", State: "finished"}
				return nil
			}}
			source := stubProvider{name: "source", run: func(_ context.Context, _ core.SessionConfig, audio <-chan []byte, events chan<- core.Event) error {
				for range audio {
				}
				return nil
			}}
			audio := make(chan []byte)
			close(audio)
			events := make(chan core.Event, 8)
			if err := (SidecarProvider{Primary: primary, Source: source}).Run(context.Background(), core.SessionConfig{Transport: transport}, audio, events); err != nil {
				t.Fatal(err)
			}
			close(events)
			found := 0
			for event := range events {
				if event.Type == "source_vad_audio" {
					found++
					if event.Audio != pcm || event.SampleRate != 16000 || event.StartMs == nil || *event.StartMs != start {
						t.Fatalf("modified model input: %#v", event)
					}
				}
			}
			if found != 1 {
				t.Fatalf("filtered audio events=%d", found)
			}
		})
	}
}
