package lunapublic

import (
	"context"
	"encoding/binary"
	"github.com/gorilla/websocket"
	"math"
	"net/http"
	"net/http/httptest"
	"simultrans/core"
	"strings"
	"testing"
	"time"
)

func TestPublicProtocolAndFloatAudio(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-key" {
			t.Error("missing server-side authorization")
		}
		ws, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer ws.Close()
		var start map[string]any
		if ws.ReadJSON(&start) != nil {
			return
		}
		if start["action"] != "start" || start["source_lang"] != "zh" || start["target_lang"] != "en" {
			t.Errorf("invalid public start: %v", start)
		}
		_ = ws.WriteJSON(map[string]string{"type": "started"})
		kind, b, err := ws.ReadMessage()
		if err != nil || kind != websocket.BinaryMessage || len(b) != 3200 {
			t.Error("audio was not forwarded")
		}
		_ = ws.WriteJSON(map[string]any{"type": "translation", "index": 0, "text": "Hello."})
		_ = ws.WriteJSON(map[string]any{"type": "speech_chunk", "audio": map[string]any{"encoding": "pcm_f32le", "sample_rate": 24000, "samples": 2}})
		f := make([]byte, 8)
		binary.LittleEndian.PutUint32(f, math.Float32bits(.5))
		binary.LittleEndian.PutUint32(f[4:], math.Float32bits(-.5))
		_ = ws.WriteMessage(websocket.BinaryMessage, f)
		var finish map[string]string
		_ = ws.ReadJSON(&finish)
		if finish["action"] != "finish" {
			t.Error("missing public finish")
		}
		_ = ws.WriteJSON(map[string]string{"type": "translation_complete"})
		_ = ws.WriteJSON(map[string]string{"type": "completed"})
	}))
	defer server.Close()
	input := make(chan []byte, 1)
	input <- make([]byte, 3200)
	close(input)
	events := make(chan core.Event, 16)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	err := (Adapter{APIKey: "test-key", Endpoint: "ws" + strings.TrimPrefix(server.URL, "http")}).Run(ctx, core.SessionConfig{SourceLanguage: "zh", TargetLanguage: "en"}, input, events)
	if err != nil {
		t.Fatal(err)
	}
	close(events)
	kinds := map[string]bool{}
	for e := range events {
		kinds[e.Type] = true
	}
	for _, kind := range []string{"state", "translation_delta", "translation_done", "audio", "audio_config"} {
		if !kinds[kind] {
			t.Error("missing", kind)
		}
	}
}
func TestFloatConversionRejectsMalformedAndNaN(t *testing.T) {
	if _, err := Float32ToPCM16([]byte{1}); err == nil {
		t.Fatal("accepted malformed sample")
	}
	b := make([]byte, 4)
	binary.LittleEndian.PutUint32(b, math.Float32bits(float32(math.NaN())))
	if _, err := Float32ToPCM16(b); err == nil {
		t.Fatal("accepted NaN")
	}
}
