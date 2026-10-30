// Package lunapublic calls the documented public Luna API. It contains no model implementation.
package lunapublic

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/gorilla/websocket"
	"math"
	"net/http"
	"net/url"
	"simultrans/core"
	"strings"
	"time"
)

type Adapter struct {
	APIKey, Endpoint string
	Dialer           *websocket.Dialer
}

func (a Adapter) Name() string { return "luna" }
func (a Adapter) Ready() bool {
	return strings.TrimSpace(a.APIKey) != "" && strings.TrimSpace(a.Endpoint) != ""
}
func (a Adapter) Run(ctx context.Context, cfg core.SessionConfig, audio <-chan []byte, events chan<- core.Event) error {
	if !a.Ready() {
		return errors.New("LUNA_API_KEY is not configured")
	}
	u, err := url.Parse(a.Endpoint)
	if err != nil || u.Host == "" || (u.Scheme != "wss" && u.Scheme != "ws") {
		return errors.New("invalid Luna WebSocket URL")
	}
	dialer := a.Dialer
	if dialer == nil {
		dialer = &websocket.Dialer{Proxy: http.ProxyFromEnvironment, HandshakeTimeout: 20 * time.Second}
	}
	ws, resp, err := dialer.DialContext(ctx, a.Endpoint, http.Header{"Authorization": []string{"Bearer " + a.APIKey}})
	if err != nil {
		if resp != nil {
			return fmt.Errorf("Luna handshake rejected (HTTP %d)", resp.StatusCode)
		}
		return errors.New("Luna connection unavailable")
	}
	defer ws.Close()
	ws.SetReadLimit(8 << 20)
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() { <-ctx.Done(); _ = ws.Close() }()
	voiceMode, backend := "preset", "lunasi-tts-sc"
	voice := cfg.Voice
	if voice == "" || voice == "Tina" {
		voice = "avery"
	}
	if cfg.VoiceClone {
		voiceMode = "clone"
		backend = "lunasi-tts"
		voice = ""
	}
	start := map[string]any{"action": "start", "source_lang": cfg.SourceLanguage, "target_lang": cfg.TargetLanguage, "enable_tts": !cfg.TextOnly, "enable_vad": true, "tts_backend": backend, "voice_mode": voiceMode, "system_prompt": cfg.Qwen3SimulSystemPrompt}
	if voice != "" {
		start["voice"] = voice
	}
	if err = ws.WriteJSON(start); err != nil {
		return errors.New("could not start Luna session")
	}
	done := make(chan error, 1)
	started := make(chan struct{})
	go func() { done <- receive(ctx, ws, events, started, voiceMode) }()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case err := <-done:
		return err
	case <-time.After(60 * time.Second):
		return errors.New("Luna start timed out")
	case <-started:
	}
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case err := <-done:
			return err
		case pcm, ok := <-audio:
			_ = ws.SetWriteDeadline(time.Now().Add(20 * time.Second))
			if !ok {
				if ws.WriteJSON(map[string]string{"action": "finish"}) != nil {
					return errors.New("could not finish Luna session")
				}
				select {
				case err := <-done:
					return err
				case <-ctx.Done():
					return ctx.Err()
				case <-time.After(190 * time.Second):
					return errors.New("Luna completion timed out")
				}
			}
			if len(pcm)%2 != 0 || len(pcm) > 32000 {
				return errors.New("invalid PCM16 frame")
			}
			if ws.WriteMessage(websocket.BinaryMessage, pcm) != nil {
				return errors.New("Luna audio connection interrupted")
			}
		}
	}
}
func receive(ctx context.Context, ws *websocket.Conn, events chan<- core.Event, started chan<- struct{}, voice string) error {
	pending := 0
	rate := 0
	outputRate := 0
	startedOnce := false
	var text strings.Builder
	segmentID, segmentText := "", ""
	emit := func(e core.Event) bool {
		select {
		case events <- e:
			return true
		case <-ctx.Done():
			return false
		}
	}
	for {
		kind, data, err := ws.ReadMessage()
		if err != nil {
			return errors.New("Luna closed before completed")
		}
		if kind == websocket.BinaryMessage {
			if pending == 0 || len(data) != pending*4 {
				return errors.New("invalid Luna audio frame")
			}
			pcm, err := Float32ToPCM16(data)
			if err != nil {
				return err
			}
			pending = 0
			if !emit(core.Event{Type: "audio_config", SampleRate: rate}) || !emit(core.Event{Type: "audio", Audio: base64.StdEncoding.EncodeToString(pcm), SegmentID: segmentID, SegmentText: segmentText, UtteranceID: segmentID}) {
				return ctx.Err()
			}
			continue
		}
		if pending != 0 {
			return errors.New("missing Luna audio frame")
		}
		var event struct {
			Type, Code, Message, Text string
			Index                     int
			TextStart                 int `json:"text_start"`
			TextEnd                   int `json:"text_end"`
			Audio                     struct {
				Encoding   string
				SampleRate int `json:"sample_rate"`
				Samples    int
			}
		}
		if json.Unmarshal(data, &event) != nil {
			return errors.New("invalid Luna event")
		}
		switch event.Type {
		case "started":
			if !startedOnce {
				close(started)
				startedOnce = true
			}
			emit(core.Event{Type: "state", State: "ready", VoiceMode: voice})
		case "translation":
			text.WriteString(event.Text)
			emit(core.Event{Type: "translation_delta", Text: event.Text})
		case "translation_complete":
			emit(core.Event{Type: "translation_done", Text: text.String()})
			emit(core.Event{Type: "translation_complete"})
		case "speech", "speech_chunk":
			segmentID = fmt.Sprintf("luna-speech-%d", event.Index)
			full := []rune(text.String())
			segmentText = ""
			if event.TextStart >= 0 && event.TextEnd > event.TextStart && event.TextEnd <= len(full) {
				segmentText = string(full[event.TextStart:event.TextEnd])
			}
			rate = event.Audio.SampleRate
			pending = event.Audio.Samples
			if event.Audio.Encoding != "pcm_f32le" || (rate != 16000 && rate != 24000) || pending <= 0 || pending > 2<<20 {
				return errors.New("unsupported Luna audio format")
			}
			if outputRate != 0 && rate != outputRate {
				return errors.New("Luna output sample rate changed")
			}
			outputRate = rate
		case "speech_done":
			emit(core.Event{Type: "audio_done", SegmentID: segmentID, UtteranceID: segmentID})
		case "error":
			return fmt.Errorf("Luna API error: %s", event.Code)
		case "completed":
			return nil
		}
	}
}
func Float32ToPCM16(data []byte) ([]byte, error) {
	if len(data)%4 != 0 {
		return nil, errors.New("unaligned float32 audio")
	}
	out := make([]byte, len(data)/2)
	for i := 0; i < len(data); i += 4 {
		v := float64(math.Float32frombits(binary.LittleEndian.Uint32(data[i:])))
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return nil, errors.New("non-finite audio sample")
		}
		v = math.Max(-1, math.Min(1, v))
		binary.LittleEndian.PutUint16(out[i/2:], uint16(int16(math.Round(v*32767))))
	}
	return out, nil
}
