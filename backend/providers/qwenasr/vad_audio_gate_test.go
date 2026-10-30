package qwenasr

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"reflect"
	"testing"

	"simultrans/core"
)

func TestFilteredEndpointIsASROnlyAndFollowsAudio(t *testing.T) {
	segments := make(chan core.Event, 5)
	output := make(chan sourceVADPacket, 8)
	endMs := int64(500)
	segments <- core.Event{Type: "source_vad_audio", Audio: base64.StdEncoding.EncodeToString([]byte{1, 2}), SampleRate: 16000, SpeechEpoch: 1, UtteranceID: "vad-1"}
	segments <- core.Event{Type: "source_vad_state", State: "speech_endpoint", EndMs: &endMs, SpeechEpoch: 1, UtteranceID: "vad-1"}
	segments <- core.Event{Type: "source_vad_audio", Audio: base64.StdEncoding.EncodeToString([]byte{3, 4}), SampleRate: 16000, SpeechEpoch: 2, UtteranceID: "vad-1"}
	segments <- core.Event{Type: "source_vad_commit", SpeechEpoch: 2, UtteranceID: "vad-1"}
	close(segments)
	audio := make(chan []byte)
	close(audio)
	go runSourceVADAudioGate(context.Background(), audio, segments, output, 160, 320, true)
	var kinds []string
	for packet := range output {
		switch {
		case packet.reset:
			kinds = append(kinds, "commit")
		case packet.softEndpoint:
			kinds = append(kinds, "soft")
		default:
			kinds = append(kinds, "audio")
		}
		if packet.utteranceID != "vad-1" {
			t.Fatalf("utterance changed: %+v", packet)
		}
	}
	if !reflect.DeepEqual(kinds, []string{"audio", "soft", "audio", "commit"}) {
		t.Fatalf("order=%v", kinds)
	}
}

func TestRawEndpointWaitsForPostRollBeforeMarker(t *testing.T) {
	audio := make(chan []byte)
	segments := make(chan core.Event)
	output := make(chan sourceVADPacket, 8)
	go runSourceVADAudioGate(context.Background(), audio, segments, output, 160, 320, false)
	start, end := int64(0), int64(100)
	segments <- core.Event{Type: "source_vad_state", State: "speech_start", StartMs: &start, SpeechEpoch: 1, UtteranceID: "vad-1"}
	audio <- make([]byte, 128*32)
	segments <- core.Event{Type: "source_vad_state", State: "speech_endpoint", EndMs: &end, SpeechEpoch: 1, UtteranceID: "vad-1"}
	audio <- make([]byte, 292*32)
	segments <- core.Event{Type: "source_vad_commit", SpeechEpoch: 1, UtteranceID: "vad-1"}
	close(segments)
	close(audio)
	bytesBeforeMarker, markers, commits := 0, 0, 0
	for packet := range output {
		if packet.softEndpoint {
			markers++
			if bytesBeforeMarker != 420*32 {
				t.Fatalf("marker before tail: %d bytes", bytesBeforeMarker)
			}
		} else if packet.reset {
			commits++
		} else {
			if markers > 0 {
				t.Fatal("tail emitted after marker")
			}
			bytesBeforeMarker += len(packet.audio)
		}
	}
	if markers != 1 || commits != 1 {
		t.Fatalf("markers=%d commits=%d", markers, commits)
	}
}

func TestSourceVADAudioGateEmitsOnlyVADFilteredSpeech(t *testing.T) {
	pcm := make([]byte, sourceVADSampleRate*2)
	for sample := int64(0); sample < sourceVADSampleRate; sample++ {
		binary.LittleEndian.PutUint16(pcm[sample*2:], uint16(sample%30000+1))
	}
	audio := make(chan []byte, 2)
	segments := make(chan core.Event, 1)
	output := make(chan sourceVADPacket, 8)
	startMs, endMs := int64(200), int64(400)
	segments <- core.Event{Type: "source_vad_segment", StartMs: &startMs, EndMs: &endMs}
	close(segments)
	audio <- pcm[:len(pcm)/2]
	audio <- pcm[len(pcm)/2:]
	close(audio)

	go runSourceVADAudioGate(context.Background(), audio, segments, output, 0, 0, false)
	var got []byte
	firstStartMs := int64(-1)
	for packet := range output {
		if firstStartMs < 0 {
			firstStartMs = packet.startMs
		}
		got = append(got, packet.audio...)
	}
	startSample := startMs * sourceVADSampleRate / 1000
	endSample := endMs * sourceVADSampleRate / 1000
	want := pcm[startSample*2 : endSample*2]
	if len(got) != len(want) {
		t.Fatalf("output bytes = %d, want VAD bytes %d", len(got), len(want))
	}
	if firstStartMs != startMs {
		t.Fatalf("first packet start = %dms, want %dms", firstStartMs, startMs)
	}
	for index := range got {
		if got[index] != want[index] {
			t.Fatalf("output byte %d = %d, want %d", index, got[index], want[index])
		}
	}
}

func TestSourceVADAudioGateUsesPrimaryFilteredPCMWithoutRawPrefix(t *testing.T) {
	raw := []byte{1, 0, 2, 0, 3, 0, 4, 0}
	filtered := []byte{9, 0, 8, 0}
	audio := make(chan []byte, 1)
	segments := make(chan core.Event, 2)
	output := make(chan sourceVADPacket, 4)
	audio <- raw
	close(audio)
	startMs := int64(400)
	segments <- core.Event{
		Type: "source_vad_audio", Audio: base64.StdEncoding.EncodeToString(filtered),
		SampleRate: 16000, SpeechEpoch: 3, UtteranceID: "vad-3", StartMs: &startMs,
	}
	close(segments)

	go runSourceVADAudioGate(context.Background(), audio, segments, output, 160, 320, true)
	packet := <-output
	if string(packet.audio) != string(filtered) || packet.startMs != startMs ||
		packet.speechEpoch != 3 || packet.utteranceID != "vad-3" {
		t.Fatalf("filtered packet = %#v", packet)
	}
	if _, ok := <-output; ok {
		t.Fatal("raw PCM must not be emitted before primary filtered PCM")
	}
}

func TestSourceVADAudioGateMatchesStreamingVADAudioAndResetsAtCommit(t *testing.T) {
	pcm := make([]byte, sourceVADSampleRate*2*2)
	for sample := int64(0); sample < sourceVADSampleRate*2; sample++ {
		binary.LittleEndian.PutUint16(pcm[sample*2:], uint16(sample%30000+1))
	}
	audio := make(chan []byte)
	segments := make(chan core.Event)
	output := make(chan sourceVADPacket, 16)
	done := make(chan struct{})
	go func() {
		runSourceVADAudioGate(context.Background(), audio, segments, output, 160, 320, false)
		close(done)
	}()

	chunkSamples := int64(160 * sourceVADSampleRate / 1000)
	sendAudio := func(startSample int64) {
		audio <- pcm[startSample*2 : (startSample+chunkSamples)*2]
	}
	sendAudio(0)
	startMs := int64(0)
	segments <- core.Event{
		Type: "source_vad_state", State: "speech_start", SpeechEpoch: 1,
		UtteranceID: "vad-1", StartMs: &startMs,
	}
	sendAudio(chunkSamples)
	sendAudio(chunkSamples * 2)
	endpointMs := int64(96)
	segments <- core.Event{
		Type: "source_vad_state", State: "speech_endpoint", SpeechEpoch: 1,
		UtteranceID: "vad-1", EndMs: &endpointMs,
	}
	commitMs := int64(1120)
	segments <- core.Event{
		Type: "source_vad_commit", State: "silence_threshold", SpeechEpoch: 1,
		UtteranceID: "vad-1", EndMs: &commitMs,
	}
	for sample := chunkSamples * 3; sample+chunkSamples <= sourceVADSampleRate*2; sample += chunkSamples {
		sendAudio(sample)
	}
	close(audio)
	close(segments)
	<-done

	var got []byte
	resetCount := 0
	for packet := range output {
		if packet.reset {
			resetCount++
			continue
		}
		got = append(got, packet.audio...)
	}
	wantSamples := (endpointMs + 320) * sourceVADSampleRate / 1000
	want := pcm[:wantSamples*2]
	if len(got) != len(want) {
		t.Fatalf("output bytes = %d, want translated VAD bytes %d", len(got), len(want))
	}
	for index := range got {
		if got[index] != want[index] {
			t.Fatalf("output byte %d = %d, want %d", index, got[index], want[index])
		}
	}
	if resetCount != 1 {
		t.Fatalf("reset packets = %d, want 1", resetCount)
	}
}
