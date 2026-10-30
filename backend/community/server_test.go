package community

import (
	"bytes"
	"context"
	"encoding/json"
	"github.com/gorilla/websocket"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"simultrans/core"
	"strings"
	"testing"
	"time"
)

func request(t *testing.T, a *App, method, path, token string, body any) (int, map[string]any) {
	t.Helper()
	b, _ := json.Marshal(body)
	r := httptest.NewRequest(method, path, bytes.NewReader(b))
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	a.ServeHTTP(w, r)
	var result map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &result)
	return w.Code, result
}
func testApp(t *testing.T, dir string) *App {
	t.Helper()
	a, err := New(Config{DataDir: dir, Password: "a-long-deployment-test-password", Demo: true})
	if err != nil {
		t.Fatal(err)
	}
	return a
}
func TestOwnershipPersistenceAndSnapshotRevocation(t *testing.T) {
	dir := t.TempDir()
	a := testApp(t, dir)
	if status, _ := request(t, a, "GET", "/api/consumer/history", "", nil); status != 401 {
		t.Fatal("history allowed without authentication")
	}
	if status, _ := request(t, a, "GET", "/api/admin/storage-audit", a.issueToken(), nil); status != 404 {
		t.Fatal("internal admin route exposed")
	}
	if status, _ := request(t, a, "POST", "/api/community/login", "", map[string]string{"password": "wrong"}); status != 401 {
		t.Fatal("accepted wrong password")
	}
	status, login := request(t, a, "POST", "/api/community/login", "", map[string]string{"password": "a-long-deployment-test-password"})
	if status != 200 {
		t.Fatal("login failed")
	}
	token := login["accessToken"].(string)
	sid := "cs-" + strings.Repeat("a", 48)
	record := map[string]any{"sessionId": sid, "sourceLanguage": "zh", "targetLanguage": "en", "sourceText": "测试原文", "translationText": "Test translation", "units": []any{}, "devices": map[string]string{"private": "must not be shared"}}
	status, rec := request(t, a, "POST", "/api/consumer/history", token, record)
	if status != 201 {
		t.Fatal(status, rec)
	}
	id := rec["id"].(string)
	status, share := request(t, a, "POST", "/api/consumer/shares", token, map[string]any{"historyId": id, "ttlDays": 1})
	if status != 201 {
		t.Fatal(status, share)
	}
	shareToken := share["token"].(string)
	record["translationText"] = "Updated private record"
	_, _ = request(t, a, "POST", "/api/consumer/history", token, record)
	status, shared := request(t, a, "GET", "/api/shares/"+shareToken, "", nil)
	if status != 200 {
		t.Fatal(status, shared)
	}
	snapshot := shared["record"].(map[string]any)
	if snapshot["translationText"] != "Test translation" || snapshot["devices"] != nil {
		t.Fatal("share was not a private-data-filtered snapshot")
	}
	a = testApp(t, dir)
	if status, _ = request(t, a, "GET", "/api/consumer/history/"+id, token, nil); status != 200 {
		t.Fatal("record/signing key did not survive restart")
	}
	status, _ = request(t, a, "GET", "/api/shares/"+shareToken, "", nil)
	if status != 200 {
		t.Fatal("share did not persist")
	}
	_, _ = request(t, a, "DELETE", "/api/consumer/shares/"+shareToken, token, nil)
	a = testApp(t, dir)
	if status, _ = request(t, a, "GET", "/api/shares/"+shareToken, "", nil); status != 410 {
		t.Fatal("revoked share survived restart")
	}
	audioDir := filepath.Join(dir, "audio", sid)
	_ = os.MkdirAll(audioDir, 0700)
	_ = os.WriteFile(filepath.Join(audioDir, "input.wav"), wav(make([]byte, 3200), 16000), 0600)
	_, _ = request(t, a, "DELETE", "/api/consumer/history/"+id, token, nil)
	if _, err := os.Stat(audioDir); !os.IsNotExist(err) {
		t.Fatal("deleted history retained its audio")
	}
}
func TestWebSocketTicketAndDemoAudio(t *testing.T) {
	a := testApp(t, t.TempDir())
	server := httptest.NewServer(a)
	defer server.Close()
	token := a.issueToken()
	_, admitted := request(t, a, "POST", "/api/consumer/ws/session", token, map[string]string{"provider": "demo"})
	sid := admitted["sessionId"].(string)
	ticket := admitted["ticket"].(string)
	connect := func(ticket string) *websocket.Conn {
		t.Helper()
		ws, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"/ws/translate", nil)
		if err != nil {
			t.Fatal(err)
		}
		_ = ws.SetReadDeadline(time.Now().Add(5 * time.Second))
		_ = ws.WriteJSON(map[string]any{"type": "start", "sessionId": sid, "ticket": ticket, "provider": "demo", "sourceLanguage": "zh", "targetLanguages": []string{"en"}})
		return ws
	}
	ws := connect(ticket)
	defer ws.Close()
	var started map[string]any
	if ws.ReadJSON(&started) != nil || started["type"] != "session_started" {
		t.Fatal("session did not authenticate")
	}
	_ = ws.WriteMessage(websocket.BinaryMessage, make([]byte, 32000))
	_ = ws.WriteJSON(map[string]string{"type": "stop"})
	events := map[string]int{}
	for {
		var event map[string]any
		if err := ws.ReadJSON(&event); err != nil {
			t.Fatal(err)
		}
		kind := event["type"].(string)
		events[kind]++
		if event["state"] == "finished" {
			break
		}
	}
	if events["audio"] != 1 || events["source_done"] != 1 || events["translation_done"] != 1 {
		t.Fatal("demo pipeline incomplete", events)
	}
	reused := connect(ticket)
	defer reused.Close()
	var rejected map[string]any
	if reused.ReadJSON(&rejected) != nil || rejected["type"] != "error" {
		t.Fatal("ticket replay was accepted")
	}
	_, rec := request(t, a, "POST", "/api/consumer/history", token, map[string]any{"sessionId": sid, "targetLanguage": "en"})
	id := rec["id"].(string)
	// A consumer can only retrieve audio referenced by this history record.
	r := httptest.NewRequest("GET", "/api/consumer/history/"+id+"/audio/input?sessionId=../../signing-key", nil)
	r.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	a.ServeHTTP(w, r)
	if w.Code != 404 {
		t.Fatal("audio traversal accepted")
	}
	path := filepath.Join(a.cfg.DataDir, "audio", sid, "input.wav")
	for i := 0; i < 50; i++ {
		if _, err := os.Stat(path); err == nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	b, err := os.ReadFile(path)
	if err != nil || len(b) != 32044 || string(b[:4]) != "RIFF" {
		t.Fatal("input replay WAV was not persisted")
	}
}
func TestCrossOriginAndTamperedToken(t *testing.T) {
	a := testApp(t, t.TempDir())
	r := httptest.NewRequest("POST", "http://workspace.example/api/community/login", strings.NewReader(`{}`))
	r.Header.Set("Origin", "https://evil.example")
	w := httptest.NewRecorder()
	a.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("cross-origin request accepted")
	}
	if a.validToken(a.issueToken() + "x") {
		t.Fatal("tampered token accepted")
	}
}
func TestEmbeddingContractDoesNotLeakCredential(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer fake-test-key" {
			t.Error("missing credential")
		}
		b, _ := io.ReadAll(r.Body)
		if !bytes.Contains(b, []byte("text-embedding-v4")) {
			t.Error("wrong embedding model")
		}
		respond(w, 200, map[string]any{"data": []any{map[string]any{"index": 1, "embedding": []float64{1, 0}}, map[string]any{"index": 0, "embedding": []float64{1, 0}}}})
	}))
	defer server.Close()
	score, err := embeddingSimilarity(t.Context(), server.URL, "fake-test-key", "source", "target")
	if err != nil || score != 1 {
		t.Fatal(score, err)
	}
}

type completionTestProvider struct{ asr bool }

func (p completionTestProvider) Name() string { return "completion-test" }
func (p completionTestProvider) Ready() bool  { return true }
func (p completionTestProvider) Run(ctx context.Context, cfg core.SessionConfig, input <-chan []byte, out chan<- core.Event) error {
	for range input {
	}
	if p.asr {
		time.Sleep(30 * time.Millisecond)
		out <- core.Event{Type: "source_done", Text: "the final source sentence"}
	} else {
		out <- core.Event{Type: "translation_done", Text: "final translation"}
		out <- core.Event{Type: "translation_complete"}
	}
	return nil
}
func TestComposedStreamWaitsForFinalASR(t *testing.T) {
	a := testApp(t, t.TempDir())
	a.providers["luna"] = completionTestProvider{}
	a.asr = completionTestProvider{asr: true}
	_, pre := request(t, a, "POST", "/api/consumer/ws/session", a.issueToken(), map[string]string{"provider": "luna"})
	server := httptest.NewServer(a)
	defer server.Close()
	ws, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"/ws/translate", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	ws.SetReadDeadline(time.Now().Add(3 * time.Second))
	ws.WriteJSON(map[string]any{"type": "start", "provider": "luna", "sessionId": pre["sessionId"], "ticket": pre["ticket"], "sourceLanguage": "zh", "targetLanguages": []string{"en"}})
	ws.WriteJSON(map[string]string{"type": "stop"})
	sourceSeen := false
	for {
		var e core.Event
		if err := ws.ReadJSON(&e); err != nil {
			t.Fatal(err)
		}
		if e.Type == "source_done" {
			sourceSeen = true
		}
		if e.Type == "translation_complete" {
			t.Fatal("client could close before ASR drains")
		}
		if e.State == "finished" {
			if !sourceSeen {
				t.Fatal("final source lost")
			}
			break
		}
	}
}
