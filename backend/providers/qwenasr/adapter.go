package qwenasr

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync/atomic"
	"unicode"
	"unicode/utf8"

	"github.com/gorilla/websocket"

	"simultrans/core"
)

const defaultModel = "qwen3-asr-flash-realtime"

type Adapter struct {
	APIKey      string
	WorkspaceID string
	Region      string
	Endpoint    string
	Model       string
	Dialer      *websocket.Dialer
}

func (a Adapter) Name() string { return "qwen-asr-realtime" }

func (a Adapter) Ready() bool {
	return strings.TrimSpace(a.APIKey) != "" &&
		(strings.TrimSpace(a.Endpoint) != "" || strings.TrimSpace(a.WorkspaceID) != "")
}

func (a Adapter) Run(
	ctx context.Context,
	config core.SessionConfig,
	audio <-chan []byte,
	events chan<- core.Event,
) error {
	if !a.Ready() {
		return errors.New("Qwen ASR Realtime 未配置：请设置 API Key 和 Workspace ID")
	}
	endpoint, err := a.endpointURL()
	if err != nil {
		return err
	}
	dialer := a.Dialer
	if dialer == nil {
		dialer = websocket.DefaultDialer
	}
	headers := http.Header{}
	headers.Set("Authorization", "Bearer "+strings.TrimSpace(a.APIKey))
	connection, response, err := dialer.DialContext(ctx, endpoint, headers)
	if err != nil {
		if response != nil {
			return fmt.Errorf("连接 Qwen ASR Realtime 失败（HTTP %d）: %w", response.StatusCode, err)
		}
		return fmt.Errorf("连接 Qwen ASR Realtime 失败: %w", err)
	}
	defer connection.Close()
	go func() {
		<-ctx.Done()
		_ = connection.Close()
	}()

	ids := eventIDs{}
	if err := connection.WriteJSON(sessionUpdate(config, ids.next())); err != nil {
		return fmt.Errorf("发送 Qwen ASR 会话配置失败: %w", err)
	}

	readDone := make(chan error, 1)
	go func() {
		readDone <- readEvents(ctx, connection, events)
	}()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case err := <-readDone:
			return err
		case chunk, ok := <-audio:
			if !ok {
				if err := connection.WriteJSON(map[string]any{
					"event_id": ids.next(),
					"type":     "session.finish",
				}); err != nil {
					return fmt.Errorf("结束 Qwen ASR 会话失败: %w", err)
				}
				return <-readDone
			}
			if len(chunk) == 0 {
				continue
			}
			if len(chunk)%2 != 0 {
				return fmt.Errorf("Qwen ASR PCM16 音频长度无效: %d", len(chunk))
			}
			if err := connection.WriteJSON(map[string]any{
				"event_id": ids.next(),
				"type":     "input_audio_buffer.append",
				"audio":    base64.StdEncoding.EncodeToString(chunk),
			}); err != nil {
				return fmt.Errorf("发送 Qwen ASR 音频失败: %w", err)
			}
		}
	}
}

func (a Adapter) endpointURL() (string, error) {
	endpoint := strings.TrimSpace(a.Endpoint)
	if endpoint == "" {
		region := strings.TrimSpace(a.Region)
		if region == "" {
			region = "cn-beijing"
		}
		if region == "singapore" {
			region = "ap-southeast-1"
		}
		endpoint = fmt.Sprintf(
			"wss://%s.%s.maas.aliyuncs.com/api-ws/v1/realtime",
			strings.TrimSpace(a.WorkspaceID),
			region,
		)
	}
	parsed, err := url.Parse(endpoint)
	if err != nil {
		return "", fmt.Errorf("QWEN_ASR_REALTIME_URL 无效: %w", err)
	}
	if (parsed.Scheme != "ws" && parsed.Scheme != "wss") || parsed.Host == "" {
		return "", errors.New("QWEN_ASR_REALTIME_URL 必须是有效的 ws/wss 地址")
	}
	model := strings.TrimSpace(a.Model)
	if model == "" {
		model = defaultModel
	}
	query := parsed.Query()
	query.Set("model", model)
	parsed.RawQuery = query.Encode()
	return parsed.String(), nil
}

func sessionUpdate(config core.SessionConfig, eventID string) map[string]any {
	language := strings.TrimSpace(config.SourceLanguage)
	if language == "" {
		language = "zh"
	}
	transcription := map[string]any{}
	// Qwen ASR enables language detection when this field is omitted. The
	// VUILabs Qwen2.5 route uses "auto" in our shared session contract, but
	// "auto" is not a valid Qwen ASR language code and must not be forwarded.
	if !strings.EqualFold(language, "auto") {
		transcription["language"] = language
	}
	return map[string]any{
		"event_id": eventID,
		"type":     "session.update",
		"session": map[string]any{
			"input_audio_format":        "pcm",
			"sample_rate":               16000,
			"input_audio_transcription": transcription,
			"turn_detection": map[string]any{
				"type":                "server_vad",
				"threshold":           0.0,
				"silence_duration_ms": 400,
			},
		},
	}
}

func readEvents(
	ctx context.Context,
	connection *websocket.Conn,
	events chan<- core.Event,
) error {
	normalizer := sourceNormalizer{}
	for {
		_, payload, err := connection.ReadMessage()
		if err != nil {
			return err
		}
		var message map[string]any
		if err := json.Unmarshal(payload, &message); err != nil {
			continue
		}
		typeName, _ := message["type"].(string)
		if typeName == "error" || typeName == "conversation.item.input_audio_transcription.failed" {
			return errors.New(asrErrorMessage(message))
		}
		if event, ok := normalizer.normalize(typeName, message); ok {
			select {
			case events <- event:
			case <-ctx.Done():
				return ctx.Err()
			}
		}
		if typeName == "session.finished" {
			return nil
		}
	}
}

type sourceNormalizer struct {
	committed string
}

func (n *sourceNormalizer) normalize(typeName string, payload map[string]any) (core.Event, bool) {
	switch typeName {
	case "conversation.item.input_audio_transcription.text":
		preview := joinTranscript(stringField(payload, "text"), stringField(payload, "stash"))
		if preview == "" {
			return core.Event{}, false
		}
		return core.Event{
			Type:        "source_update",
			Text:        joinTranscript(n.committed, preview),
			SegmentID:   firstString(payload, "item_id"),
			SegmentText: preview,
		}, true
	case "conversation.item.input_audio_transcription.completed":
		raw := strings.TrimSpace(stringField(payload, "transcript"))
		previous := n.committed
		n.committed = appendTranscript(previous, raw)
		if n.committed == "" {
			return core.Event{}, false
		}
		return core.Event{
			Type:        "source_done",
			Text:        n.committed,
			SegmentID:   firstString(payload, "item_id", "event_id"),
			SegmentText: committedTranscriptPart(previous, n.committed, raw),
		}, true
	default:
		return core.Event{}, false
	}
}

type eventIDs struct {
	value atomic.Uint64
}

func (ids *eventIDs) next() string {
	return fmt.Sprintf("event_%d", ids.value.Add(1))
}

func stringField(payload map[string]any, key string) string {
	value, _ := payload[key].(string)
	return value
}

func firstString(payload map[string]any, keys ...string) string {
	for _, key := range keys {
		if value := strings.TrimSpace(stringField(payload, key)); value != "" {
			return value
		}
	}
	return ""
}

func asrErrorMessage(payload map[string]any) string {
	if nested, ok := payload["error"].(map[string]any); ok {
		if message := firstString(nested, "message", "code"); message != "" {
			return message
		}
	}
	if message := firstString(payload, "message", "code"); message != "" {
		return message
	}
	encoded, _ := json.Marshal(payload)
	return string(encoded)
}

func appendTranscript(committed, next string) string {
	committed = strings.TrimSpace(committed)
	next = strings.TrimSpace(next)
	if next == "" || committed == next || strings.HasSuffix(committed, next) {
		return committed
	}
	if strings.HasPrefix(next, committed) {
		return next
	}
	return joinTranscript(committed, next)
}

func committedTranscriptPart(previous, accumulated, raw string) string {
	previous = strings.TrimSpace(previous)
	accumulated = strings.TrimSpace(accumulated)
	raw = strings.TrimSpace(raw)
	if previous == "" {
		return accumulated
	}
	if accumulated == previous {
		return ""
	}
	if strings.HasPrefix(accumulated, previous) {
		return strings.TrimSpace(strings.TrimPrefix(accumulated, previous))
	}
	return raw
}

func joinTranscript(left, right string) string {
	left = strings.TrimSpace(left)
	right = strings.TrimSpace(right)
	if left == "" {
		return right
	}
	if right == "" {
		return left
	}
	last, _ := utf8.DecodeLastRuneInString(left)
	first, _ := utf8.DecodeRuneInString(right)
	if unicode.Is(unicode.Han, last) ||
		unicode.Is(unicode.Han, first) ||
		strings.ContainsRune("。！？；", last) {
		return left + right
	}
	return left + " " + right
}
