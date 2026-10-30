package qwenasr

import (
	"context"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"simultrans/core"
)

func TestEndpointUsesWorkspaceRegionAndModel(t *testing.T) {
	adapter := Adapter{
		WorkspaceID: "workspace-1",
		Region:      "cn-beijing",
		Model:       "qwen3-asr-flash-realtime",
	}
	got, err := adapter.endpointURL()
	if err != nil {
		t.Fatal(err)
	}
	want := "wss://workspace-1.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=qwen3-asr-flash-realtime"
	if got != want {
		t.Fatalf("endpoint = %q, want %q", got, want)
	}
}

func TestSessionUpdateUsesLowLatencyVADAndSelectedLanguage(t *testing.T) {
	payload := sessionUpdate(core.SessionConfig{SourceLanguage: "zh"}, "event-1")
	if payload["event_id"] != "event-1" || payload["type"] != "session.update" {
		t.Fatalf("unexpected envelope: %#v", payload)
	}
	session := payload["session"].(map[string]any)
	transcription := session["input_audio_transcription"].(map[string]any)
	vad := session["turn_detection"].(map[string]any)
	if session["input_audio_format"] != "pcm" ||
		session["sample_rate"] != 16000 ||
		transcription["language"] != "zh" ||
		vad["type"] != "server_vad" ||
		vad["threshold"] != 0.0 ||
		vad["silence_duration_ms"] != 400 {
		t.Fatalf("unexpected session: %#v", session)
	}
}

func TestSessionUpdateOmitsAutomaticLanguageForQwenASR(t *testing.T) {
	for _, sourceLanguage := range []string{"auto", " AUTO "} {
		t.Run(sourceLanguage, func(t *testing.T) {
			payload := sessionUpdate(core.SessionConfig{SourceLanguage: sourceLanguage}, "event-1")
			session := payload["session"].(map[string]any)
			transcription := session["input_audio_transcription"].(map[string]any)
			if _, ok := transcription["language"]; ok {
				t.Fatalf("automatic language must be omitted, got %#v", transcription)
			}
		})
	}
}

func TestSessionUpdateDefaultsBlankLanguageToChinese(t *testing.T) {
	payload := sessionUpdate(core.SessionConfig{}, "event-1")
	session := payload["session"].(map[string]any)
	transcription := session["input_audio_transcription"].(map[string]any)
	if transcription["language"] != "zh" {
		t.Fatalf("blank language = %#v, want zh", transcription["language"])
	}
}

func TestNormalizerReplacesPreviewAndCommitsUtterances(t *testing.T) {
	normalizer := sourceNormalizer{}
	first, ok := normalizer.normalize(
		"conversation.item.input_audio_transcription.text",
		map[string]any{"item_id": "item-1", "text": "今天", "stash": "天气"},
	)
	if !ok || first.Type != "source_update" || first.Text != "今天天气" ||
		first.SegmentID != "item-1" || first.SegmentText != "今天天气" {
		t.Fatalf("unexpected preview: %#v, %v", first, ok)
	}
	done, ok := normalizer.normalize(
		"conversation.item.input_audio_transcription.completed",
		map[string]any{"item_id": "item-1", "transcript": "今天天气很好。"},
	)
	if !ok ||
		done.Type != "source_done" ||
		done.Text != "今天天气很好。" ||
		done.SegmentID != "item-1" ||
		done.SegmentText != "今天天气很好。" {
		t.Fatalf("unexpected completed event: %#v, %v", done, ok)
	}
	next, ok := normalizer.normalize(
		"conversation.item.input_audio_transcription.text",
		map[string]any{"item_id": "item-2", "text": "", "stash": "我们出去吧"},
	)
	if !ok || next.Text != "今天天气很好。我们出去吧" ||
		next.SegmentID != "item-2" || next.SegmentText != "我们出去吧" {
		t.Fatalf("completed utterance was not preserved: %#v, %v", next, ok)
	}
}

func TestRunStreamsPCMAndEmitsSourceEvents(t *testing.T) {
	type received struct {
		authorization string
		update        map[string]any
		append        map[string]any
		finish        map[string]any
	}
	gotRequest := make(chan received, 1)
	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		connection, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer connection.Close()

		var update map[string]any
		if err := connection.ReadJSON(&update); err != nil {
			t.Error(err)
			return
		}
		var appendEvent map[string]any
		if err := connection.ReadJSON(&appendEvent); err != nil {
			t.Error(err)
			return
		}
		_ = connection.WriteJSON(map[string]any{
			"type":    "conversation.item.input_audio_transcription.text",
			"item_id": "item-1",
			"text":    "你好",
			"stash":   "世界",
		})
		_ = connection.WriteJSON(map[string]any{
			"type":       "conversation.item.input_audio_transcription.completed",
			"item_id":    "item-1",
			"transcript": "你好世界。",
		})
		var finish map[string]any
		if err := connection.ReadJSON(&finish); err != nil {
			t.Error(err)
			return
		}
		gotRequest <- received{
			authorization: r.Header.Get("Authorization"),
			update:        update,
			append:        appendEvent,
			finish:        finish,
		}
		_ = connection.WriteJSON(map[string]any{"type": "session.finished"})
	}))
	defer server.Close()

	input := []byte{1, 2, 3, 4}
	audio := make(chan []byte, 1)
	audio <- input
	close(audio)
	events := make(chan core.Event, 4)
	adapter := Adapter{
		APIKey:   "test-key",
		Endpoint: websocketURL(server.URL),
	}
	if err := adapter.Run(
		context.Background(),
		core.SessionConfig{SourceLanguage: "zh"},
		audio,
		events,
	); err != nil {
		t.Fatalf("Run: %v", err)
	}
	close(events)

	request := <-gotRequest
	if request.authorization != "Bearer test-key" {
		t.Fatalf("authorization = %q", request.authorization)
	}
	if request.update["type"] != "session.update" ||
		request.append["type"] != "input_audio_buffer.append" ||
		request.append["audio"] != base64.StdEncoding.EncodeToString(input) ||
		request.finish["type"] != "session.finish" {
		t.Fatalf("unexpected request sequence: %#v", request)
	}
	var gotEvents []core.Event
	for event := range events {
		gotEvents = append(gotEvents, event)
	}
	wantEvents := []core.Event{
		{Type: "source_update", Text: "你好世界", SegmentID: "item-1", SegmentText: "你好世界"},
		{
			Type: "source_done", Text: "你好世界。",
			SegmentID: "item-1", SegmentText: "你好世界。",
		},
	}
	if !reflect.DeepEqual(gotEvents, wantEvents) {
		t.Fatalf("events = %#v, want %#v", gotEvents, wantEvents)
	}
}

func TestLiveHandshakeAndTranscription(t *testing.T) {
	if os.Getenv("QWEN_ASR_LIVE_TEST") != "1" {
		t.Skip("set QWEN_ASR_LIVE_TEST=1 to run against Alibaba Cloud Model Studio")
	}
	apiKey := os.Getenv("QWEN_ASR_API_KEY")
	if apiKey == "" {
		apiKey = os.Getenv("ALIYUN_API_KEY")
	}
	workspaceID := os.Getenv("QWEN_ASR_WORKSPACE_ID")
	if workspaceID == "" {
		workspaceID = os.Getenv("ALIYUN_WORKSPACE_ID")
	}
	region := os.Getenv("QWEN_ASR_REGION")
	if region == "" {
		region = os.Getenv("ALIYUN_REGION")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	input := make([]byte, 16000*2)
	expectTranscript := false
	if path := os.Getenv("QWEN_ASR_LIVE_PCM"); path != "" {
		var err error
		input, err = os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		expectTranscript = true
	}
	audio := make(chan []byte)
	go func() {
		defer close(audio)
		const chunkBytes = 16000 * 2 / 10
		for len(input) > 0 {
			size := min(len(input), chunkBytes)
			audio <- input[:size]
			input = input[size:]
			time.Sleep(100 * time.Millisecond)
		}
	}()
	events := make(chan core.Event, 256)
	err := (Adapter{
		APIKey:      apiKey,
		WorkspaceID: workspaceID,
		Region:      region,
		Model:       defaultModel,
	}).Run(ctx, core.SessionConfig{SourceLanguage: "zh"}, audio, events)
	if err != nil {
		t.Fatalf("live Qwen ASR handshake/finish: %v", err)
	}
	if expectTranscript {
		var transcript string
		for len(events) > 0 {
			event := <-events
			if event.Type == "source_done" {
				transcript = event.Text
			}
		}
		if transcript == "" {
			t.Fatal("live Qwen ASR returned no completed source transcript")
		}
		t.Logf("live transcript: %s", transcript)
	}
}

func websocketURL(serverURL string) string {
	return "ws" + serverURL[len("http"):]
}
