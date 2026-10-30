package community

import (
	"encoding/json"
	"github.com/gorilla/websocket"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestLiveEndToEnd(t *testing.T) {
	if os.Getenv("COMMUNITY_LIVE_TEST") != "1" {
		t.Skip("explicit opt-in with your own provider credentials and permitted PCM input")
	}
	sourceLang, targetLang := os.Getenv("TEST_SOURCE_LANG"), os.Getenv("TEST_TARGET_LANG")
	if sourceLang == "" {
		sourceLang = "zh"
	}
	if targetLang == "" {
		targetLang = "en"
	}
	cfg := FromEnv()
	cfg.DataDir = t.TempDir()
	cfg.Password = "an-ephemeral-integration-password"
	cfg.Demo = false
	a, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	service := httptest.NewServer(a)
	defer service.Close()
	token := a.issueToken()
	status, pre := request(t, a, "POST", "/api/consumer/ws/session", token, map[string]string{"provider": "luna"})
	if status != 200 {
		t.Fatal(status, pre)
	}
	sid := pre["sessionId"].(string)
	ws, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(service.URL, "http")+"/ws/translate", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	_ = ws.SetReadDeadline(time.Now().Add(4 * time.Minute))
	if err = ws.WriteJSON(map[string]any{"type": "start", "provider": "luna", "sessionId": sid, "ticket": pre["ticket"], "sourceLanguage": sourceLang, "targetLanguages": []string{targetLang}}); err != nil {
		t.Fatal(err)
	}
	pcm, err := os.ReadFile(os.Getenv("LUNA_TEST_PCM"))
	if err != nil {
		t.Fatal(err)
	}
	sendError := make(chan error, 1)
	var sender sync.WaitGroup
	sender.Add(1)
	go func() {
		defer sender.Done()
		for i := 0; i < len(pcm); i += 3200 {
			end := i + 3200
			if end > len(pcm) {
				end = len(pcm)
			}
			if err := ws.WriteMessage(websocket.BinaryMessage, pcm[i:end]); err != nil {
				sendError <- err
				return
			}
			time.Sleep(100 * time.Millisecond)
		}
		sendError <- ws.WriteJSON(map[string]string{"type": "stop"})
	}()
	counts := map[string]int{}
	source, translation := "", ""
	for {
		var e struct{ Type, State, Text, Error string }
		if err = ws.ReadJSON(&e); err != nil {
			t.Fatal(err)
		}
		counts[e.Type]++
		switch e.Type {
		case "error":
			t.Fatal(e.Error)
		case "source_delta":
			source += e.Text
		case "source_done", "source_update":
			if e.Text != "" {
				source = e.Text
			}
		case "translation_delta":
			translation += e.Text
		case "translation_done":
			translation = e.Text
		}
		if e.State == "finished" {
			break
		}
	}
	sender.Wait()
	if err = <-sendError; err != nil {
		t.Fatal(err)
	}
	if source == "" || translation == "" || counts["audio"] == 0 {
		t.Fatalf("incomplete live result: source=%d translation=%d audio=%d", len(source), len(translation), counts["audio"])
	}
	status, rec := request(t, a, "POST", "/api/consumer/history", token, map[string]any{"sessionId": sid, "provider": "luna", "sourceLanguage": sourceLang, "targetLanguage": targetLang, "sourceText": source, "translationText": translation, "units": []any{map[string]any{"id": "unit-1", "source": source, "text": translation}}, "durationMs": len(pcm) * 1000 / 32000})
	if status != 201 {
		t.Fatal(status, rec)
	}
	id := rec["id"].(string)
	_, share := request(t, a, "POST", "/api/consumer/shares", token, map[string]any{"historyId": id, "ttlDays": 1})
	shareToken := share["token"].(string)
	if status, _ = request(t, a, "GET", "/api/shares/"+shareToken, "", nil); status != 200 {
		t.Fatal("share failed")
	}
	audioPath := "/api/shares/" + shareToken + "/audio/output-" + targetLang + "?sessionId=" + sid
	var replay *httptest.ResponseRecorder
	for i := 0; i < 100; i++ {
		replay = httptest.NewRecorder()
		a.ServeHTTP(replay, httptest.NewRequest("GET", audioPath, nil))
		if replay.Code == 200 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if replay.Code != 200 || replay.Body.Len() < 1000 || !strings.HasPrefix(replay.Body.String(), "RIFF") {
		t.Fatal("real translated audio was not archived/replayable")
	}
	status, aligned := request(t, a, "POST", "/api/semantic-align/align", token, map[string]any{"source": source, "translation": translation, "final": true})
	if status != 200 || aligned["method"] != "embedding-scored-whole-utterance" {
		t.Fatal("real embedding scoring failed", status)
	}
	if path := os.Getenv("COMMUNITY_TEST_RECEIPT"); path != "" {
		b, _ := json.MarshalIndent(map[string]any{"source": source, "translation": translation, "events": counts, "replayWAVBytes": replay.Body.Len(), "embeddingMethod": aligned["method"], "historySaved": true, "shareReadable": true}, "", "  ")
		if err = os.WriteFile(path, b, 0600); err != nil {
			t.Fatal(err)
		}
	}
	t.Logf("Live community chain passed: ASR=%d chars, translation=%d chars, audio=%d frames, replay=%d bytes, history/share/embedding verified", len([]rune(source)), len([]rune(translation)), counts["audio"], replay.Body.Len())
}
