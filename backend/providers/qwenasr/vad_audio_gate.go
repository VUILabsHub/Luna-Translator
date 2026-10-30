// Change record (2026-08-06): gate sidecar ASR audio with the primary S2ST
// engine's Qwen VAD ranges. Original positions travel in packet.startMs; VAD
// gaps are not padded into the ASR stream because they consume model context.
package qwenasr

import (
	"context"
	"encoding/base64"
	"sort"
	"time"

	"simultrans/core"
)

const (
	sourceVADSampleRate = int64(16000)
	sourceVADChunkBytes = 32000
)

type sourceVADRange struct {
	startSample int64
	endSample   int64
}

type sourceVADPacket struct {
	audio        []byte
	startMs      int64
	speechEpoch  int
	utteranceID  string
	reset        bool
	softEndpoint bool
}

func runSourceVADAudioGate(
	ctx context.Context,
	audio <-chan []byte,
	segments <-chan core.Event,
	output chan<- sourceVADPacket,
	preRollMs int64,
	postRollMs int64,
	usePrimaryFilteredAudio bool,
) {
	defer close(output)
	var pcm []byte
	var ranges []sourceVADRange
	var emittedSamples int64
	var streamingStateSeen bool
	var speechActive bool
	var speechFlushEndSample int64
	var speechEpoch int
	var utteranceID string
	primaryFilteredAudioSeen := usePrimaryFilteredAudio
	var pendingSoftEndpoint *sourceVADPacket
	audioOpen, segmentsOpen := true, true
	var finalVADTimer *time.Timer
	var finalVADDeadline <-chan time.Time

	emit := func(data []byte, startSample int64) bool {
		for len(data) > 0 {
			size := min(len(data), sourceVADChunkBytes)
			packet := sourceVADPacket{
				audio:       append([]byte(nil), data[:size]...),
				startMs:     startSample * 1000 / sourceVADSampleRate,
				speechEpoch: speechEpoch,
				utteranceID: utteranceID,
			}
			select {
			case output <- packet:
			case <-ctx.Done():
				return false
			}
			startSample += int64(size / 2)
			data = data[size:]
		}
		return true
	}
	flush := func(force bool) bool {
		totalSamples := int64(len(pcm) / 2)
		sort.SliceStable(ranges, func(i, j int) bool { return ranges[i].startSample < ranges[j].startSample })
		for len(ranges) > 0 {
			rangeItem := ranges[0]
			if !force && rangeItem.endSample > totalSamples {
				break
			}
			ranges = ranges[1:]
			start := max(emittedSamples, rangeItem.startSample)
			end := min(totalSamples, rangeItem.endSample)
			if end > start && !emit(pcm[start*2:end*2], start) {
				return false
			}
			if end > emittedSamples {
				emittedSamples = end
			}
		}
		return true
	}
	emitSoftEndpoint := func() bool {
		if pendingSoftEndpoint == nil {
			return true
		}
		select {
		case output <- *pendingSoftEndpoint:
			pendingSoftEndpoint = nil
			return true
		case <-ctx.Done():
			return false
		}
	}
	emitSpeechThrough := func(endSample int64) bool {
		totalSamples := int64(len(pcm) / 2)
		endSample = min(endSample, totalSamples)
		if endSample <= emittedSamples {
			return true
		}
		if !emit(pcm[emittedSamples*2:endSample*2], emittedSamples) {
			return false
		}
		emittedSamples = endSample
		return true
	}

	for audioOpen || segmentsOpen {
		select {
		case chunk, ok := <-audio:
			if !ok {
				audioOpen = false
				audio = nil
				// The primary provider may keep producing TTS for tens of seconds
				// after browser input ends. Give its final VAD event a short grace
				// period, then close ASR independently so cloud packet timeouts do
				// not turn a successful recognition into fallback transcription.
				finalVADTimer = time.NewTimer(2 * time.Second)
				finalVADDeadline = finalVADTimer.C
				continue
			}
			if primaryFilteredAudioSeen {
				continue
			}
			pcm = append(pcm, chunk...)
			if speechActive {
				totalSamples := int64(len(pcm) / 2)
				holdbackSamples := postRollMs * sourceVADSampleRate / 1000
				if !emitSpeechThrough(max(emittedSamples, totalSamples-holdbackSamples)) {
					return
				}
				continue
			}
			if speechFlushEndSample > emittedSamples {
				if !emitSpeechThrough(speechFlushEndSample) {
					return
				}
			}
			if pendingSoftEndpoint != nil && emittedSamples >= speechFlushEndSample && !emitSoftEndpoint() {
				return
			}
			if streamingStateSeen {
				continue
			}
			if !flush(false) {
				return
			}
		case event, ok := <-segments:
			if !ok {
				segmentsOpen = false
				segments = nil
				continue
			}
			switch event.Type {
			case "source_vad_audio":
				decoded, err := base64.StdEncoding.DecodeString(event.Audio)
				if err != nil || len(decoded)%2 != 0 || event.SampleRate != int(sourceVADSampleRate) {
					return
				}
				if !primaryFilteredAudioSeen {
					primaryFilteredAudioSeen = true
					pcm = nil
					ranges = nil
				}
				speechEpoch = event.SpeechEpoch
				utteranceID = event.UtteranceID
				startMs := int64(0)
				if event.StartMs != nil {
					startMs = *event.StartMs
				}
				if !emit(decoded, startMs*sourceVADSampleRate/1000) {
					return
				}
			case "source_vad_state":
				streamingStateSeen = true
				ranges = nil
				if event.State == "speech_start" && event.StartMs != nil {
					speechEpoch = event.SpeechEpoch
					utteranceID = event.UtteranceID
					startMs := max(int64(0), *event.StartMs-preRollMs)
					startSample := max(emittedSamples, startMs*sourceVADSampleRate/1000)
					emittedSamples = startSample
					speechFlushEndSample = 0
					speechActive = true
					totalSamples := int64(len(pcm) / 2)
					holdbackSamples := postRollMs * sourceVADSampleRate / 1000
					if !emitSpeechThrough(max(emittedSamples, totalSamples-holdbackSamples)) {
						return
					}
				} else if event.State == "speech_endpoint" {
					speechActive = false
					pendingSoftEndpoint = &sourceVADPacket{
						softEndpoint: true, speechEpoch: event.SpeechEpoch, utteranceID: event.UtteranceID,
					}
					if event.EndMs != nil {
						speechFlushEndSample = (*event.EndMs + postRollMs) * sourceVADSampleRate / 1000
						if !emitSpeechThrough(speechFlushEndSample) {
							return
						}
					}
					// Primary filtered PCM precedes its endpoint on the same event stream.
					// Raw PCM may arrive later; wait for its post-roll before the marker.
					if (primaryFilteredAudioSeen || (event.EndMs != nil && emittedSamples >= speechFlushEndSample)) && !emitSoftEndpoint() {
						return
					}
				}
			case "source_vad_segment":
				if streamingStateSeen || event.StartMs == nil || event.EndMs == nil || *event.EndMs <= *event.StartMs {
					continue
				}
				startMs := max(int64(0), *event.StartMs-preRollMs)
				endMs := *event.EndMs + postRollMs
				ranges = append(ranges, sourceVADRange{
					startSample: startMs * sourceVADSampleRate / 1000,
					endSample:   endMs * sourceVADSampleRate / 1000,
				})
				if !flush(false) {
					return
				}
			case "source_vad_commit":
				pendingSoftEndpoint = nil
				select {
				case output <- sourceVADPacket{
					reset: true, speechEpoch: event.SpeechEpoch,
					utteranceID: event.UtteranceID,
				}:
				case <-ctx.Done():
					return
				}
				speechEpoch = 0
				utteranceID = ""
				speechFlushEndSample = 0
			}
		case <-ctx.Done():
			return
		case <-finalVADDeadline:
			segmentsOpen = false
			segments = nil
		}
	}
	if finalVADTimer != nil {
		finalVADTimer.Stop()
	}
	flush(true)
}
