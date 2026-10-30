package aliyun

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/gorilla/websocket"

	"simultrans/core"
)

const (
	defaultModel           = "qwen3.5-livetranslate-flash-realtime"
	aliyunOutputSampleRate = 24000
)

type Adapter struct {
	APIKey      string
	WorkspaceID string
	Region      string
	Endpoint    string
	Model       string
	Dialer      *websocket.Dialer
}

func (a Adapter) Name() string { return "aliyun" }

func (a Adapter) Ready() bool {
	return a.APIKey != "" && (a.Endpoint != "" || a.WorkspaceID != "")
}

func (a Adapter) Run(ctx context.Context, config core.SessionConfig, audio <-chan []byte, events chan<- core.Event) error {
	if !a.Ready() {
		return errors.New("阿里云未配置：请设置 ALIYUN_API_KEY 和 ALIYUN_WORKSPACE_ID")
	}

	endpoint, err := a.endpointURL()
	if err != nil {
		return err
	}
	header := http.Header{"Authorization": []string{"Bearer " + a.APIKey}}
	dialer := a.Dialer
	if dialer == nil {
		dialer = websocket.DefaultDialer
	}
	connection, response, err := dialer.DialContext(ctx, endpoint, header)
	if err != nil {
		if response != nil {
			return fmt.Errorf("连接阿里云失败（HTTP %d）: %w", response.StatusCode, err)
		}
		return fmt.Errorf("连接阿里云失败: %w", err)
	}
	defer connection.Close()

	if err := connection.WriteJSON(sessionUpdate(config)); err != nil {
		return fmt.Errorf("发送会话配置失败: %w", err)
	}
	events <- core.Event{Type: "state", State: "connected"}
	events <- core.Event{Type: "audio_config", SampleRate: aliyunOutputSampleRate}

	readDone := make(chan error, 1)
	go func() {
		readDone <- a.readEvents(ctx, connection, events, core.VoiceModeForClone(config.VoiceClone))
	}()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case err := <-readDone:
			return err
		case chunk, ok := <-audio:
			if !ok {
				if err := connection.WriteJSON(map[string]any{"type": "session.finish"}); err != nil {
					return fmt.Errorf("结束会话失败: %w", err)
				}
				return <-readDone
			}
			if len(chunk) == 0 {
				continue
			}
			if err := connection.WriteJSON(map[string]any{
				"type":  "input_audio_buffer.append",
				"audio": encodeBase64(chunk),
			}); err != nil {
				return fmt.Errorf("发送音频失败: %w", err)
			}
		}
	}
}

func (a Adapter) endpointURL() (string, error) {
	endpoint := a.Endpoint
	if endpoint == "" {
		region := a.Region
		if region == "" {
			region = "cn-beijing"
		}
		domainRegion := region
		if region == "singapore" || region == "ap-southeast-1" {
			domainRegion = "ap-southeast-1"
		}
		endpoint = fmt.Sprintf("wss://%s.%s.maas.aliyuncs.com/api-ws/v1/realtime", a.WorkspaceID, domainRegion)
	}
	parsed, err := url.Parse(endpoint)
	if err != nil {
		return "", fmt.Errorf("ALIYUN_REALTIME_URL 无效: %w", err)
	}
	query := parsed.Query()
	model := a.Model
	if model == "" {
		model = defaultModel
	}
	query.Set("model", model)
	parsed.RawQuery = query.Encode()
	return parsed.String(), nil
}

func sessionUpdate(config core.SessionConfig) map[string]any {
	voice := config.Voice
	if voice == "" {
		voice = "Tina"
	}
	if config.VoiceClone {
		voice = "default"
	}
	session := map[string]any{
		"modalities":          []string{"text", "audio"},
		"voice":               voice,
		"enable_voice_clone":  config.VoiceClone,
		"sample_rate":         16000,
		"input_audio_format":  "pcm",
		"output_audio_format": "pcm",
		"input_audio_transcription": map[string]string{
			"model":    "qwen3-asr-flash-realtime",
			"language": languageOr(config.SourceLanguage, "zh"),
		},
		"translation": map[string]string{
			"language": languageOr(config.TargetLanguage, "en"),
		},
	}
	if config.VoiceClone {
		frequency := config.VoiceCloneFrequency
		if frequency != "always" {
			frequency = "once"
		}
		session["voice_clone_options"] = map[string]string{"frequency": frequency}
	}
	return map[string]any{
		"type":    "session.update",
		"session": session,
	}
}

func (a Adapter) readEvents(
	ctx context.Context,
	connection *websocket.Conn,
	events chan<- core.Event,
	voiceMode string,
) error {
	normalizer := streamNormalizer{readyVoiceMode: voiceMode}
	for {
		_, message, err := connection.ReadMessage()
		if err != nil {
			return err
		}
		var payload map[string]any
		if err := json.Unmarshal(message, &payload); err != nil {
			continue
		}
		typeName, _ := payload["type"].(string)
		event, emit := normalizer.normalize(typeName, payload)
		if emit {
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

func normalizeEvent(typeName string, payload map[string]any) (core.Event, bool) {
	normalizer := streamNormalizer{}
	return normalizer.normalize(typeName, payload)
}

type streamNormalizer struct {
	sourceCommitted      string
	translationCommitted string
	readyVoiceMode       string
}

func (n *streamNormalizer) normalize(typeName string, payload map[string]any) (core.Event, bool) {
	switch typeName {
	case "conversation.item.input_audio_transcription.text":
		preview := joinTranscript(firstString(payload, "text"), firstString(payload, "stash"))
		return core.Event{Type: "source_update", Text: joinTranscript(n.sourceCommitted, preview)}, preview != ""
	case "conversation.item.input_audio_transcription.completed":
		raw := firstString(payload, "transcript", "text")
		previous := n.sourceCommitted
		n.sourceCommitted = appendTranscript(previous, raw)
		return core.Event{
			Type:        "source_done",
			Text:        n.sourceCommitted,
			SegmentID:   firstString(payload, "item_id"),
			SegmentText: committedTranscriptPart(previous, n.sourceCommitted, raw),
		}, n.sourceCommitted != ""
	case "response.audio_transcript.text":
		preview := joinTranscript(firstString(payload, "text"), firstString(payload, "stash"))
		return core.Event{Type: "translation_update", Text: joinTranscript(n.translationCommitted, preview)}, preview != ""
	case "response.audio_transcript.done":
		raw := firstString(payload, "transcript", "text")
		previous := n.translationCommitted
		n.translationCommitted = appendTranscript(previous, raw)
		return core.Event{
			Type:        "translation_done",
			Text:        n.translationCommitted,
			SegmentID:   firstString(payload, "item_id", "response_id"),
			SegmentText: committedTranscriptPart(previous, n.translationCommitted, raw),
		}, n.translationCommitted != ""
	case "response.audio.delta":
		audio := firstString(payload, "delta", "audio")
		return core.Event{
			Type:            "audio",
			Audio:           audio,
			SegmentID:       firstString(payload, "item_id", "response_id"),
			AudioDurationMs: pcm16Base64DurationMs(audio, aliyunOutputSampleRate),
		}, true
	case "session.updated":
		return core.Event{Type: "state", State: "ready", VoiceMode: n.readyVoiceMode}, true
	case "session.finished":
		return core.Event{Type: "state", State: "finished"}, true
	case "error":
		return core.Event{Type: "error", Error: errorMessage(payload)}, true
	default:
		return core.Event{}, false
	}
}

func pcm16Base64DurationMs(encoded string, sampleRate int) *float64 {
	decoded, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || sampleRate <= 0 || len(decoded)%2 != 0 {
		return nil
	}
	duration := float64(len(decoded)) * 1000 / float64(sampleRate*2)
	return &duration
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
	if unicode.Is(unicode.Han, last) || unicode.Is(unicode.Han, first) || strings.ContainsRune("。！？；", last) {
		return left + right
	}
	return left + " " + right
}

func firstString(payload map[string]any, keys ...string) string {
	for _, key := range keys {
		if value, ok := payload[key].(string); ok {
			return value
		}
	}
	return ""
}

func errorMessage(payload map[string]any) string {
	if message := firstString(payload, "message", "error"); message != "" {
		return message
	}
	if nested, ok := payload["error"].(map[string]any); ok {
		if message := firstString(nested, "message", "code"); message != "" {
			return message
		}
	}
	encoded, _ := json.Marshal(payload)
	return string(encoded)
}

func languageOr(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}
