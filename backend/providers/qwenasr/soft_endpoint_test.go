package qwenasr

import (
	"context"
	"reflect"
	"testing"

	"simultrans/core"
)

type endpointTestProvider struct {
	stubProvider
	runs    int
	packets []string
}

func (p *endpointTestProvider) RunWithEndpoints(ctx context.Context, config core.SessionConfig, packets <-chan core.ASRAudioPacket, events chan<- core.Event) error {
	p.runs++
	text := ""
	for packet := range packets {
		if packet.SoftEndpoint {
			p.packets = append(p.packets, "endpoint")
		} else {
			p.packets = append(p.packets, string(packet.Audio))
			text += string(packet.Audio)
		}
		events <- core.Event{Type: "source_update", Text: text}
	}
	events <- core.Event{Type: "source_done", Text: text}
	return nil
}

func TestSoftEndpointDoesNotEndBusinessUtterance(t *testing.T) {
	source := &endpointTestProvider{}
	packets := make(chan sourceVADPacket, 5)
	packets <- sourceVADPacket{audio: []byte("Hello"), speechEpoch: 1, utteranceID: "vad-1"}
	packets <- sourceVADPacket{softEndpoint: true, speechEpoch: 1, utteranceID: "vad-1"}
	packets <- sourceVADPacket{audio: []byte(" world"), speechEpoch: 2, utteranceID: "vad-1"}
	packets <- sourceVADPacket{reset: true, speechEpoch: 2, utteranceID: "vad-1"}
	packets <- sourceVADPacket{softEndpoint: true, speechEpoch: 2, utteranceID: "vad-1"}
	close(packets)
	events := make(chan core.Event, 8)
	if err := runResettableSource(context.Background(), source, core.SessionConfig{}, packets, events); err != nil {
		t.Fatal(err)
	}
	close(events)
	if source.runs != 1 || !reflect.DeepEqual(source.packets, []string{"Hello", "endpoint", " world"}) {
		t.Fatalf("runs=%d packets=%q", source.runs, source.packets)
	}
	finals := 0
	for event := range events {
		if event.Type == "source_done" {
			finals++
			if event.EpochText != "Hello world" || event.Text != "Hello world" {
				t.Fatalf("lost prefix: %+v", event)
			}
		}
		if event.UtteranceID != "vad-1" {
			t.Fatalf("changed utterance: %+v", event)
		}
	}
	if finals != 1 {
		t.Fatalf("got %d finals", finals)
	}
}
