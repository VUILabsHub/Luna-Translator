package community

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"github.com/gorilla/websocket"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"simultrans/core"
	"strings"
	"sync"
	"time"
)

var safeID = regexp.MustCompile(`^cs-[a-f0-9]{48}$`)
var safeKind = regexp.MustCompile(`^(input|output(?:-[a-z]{2})?)$`)
var languages = map[string]bool{"zh": true, "en": true, "ja": true, "ko": true, "de": true, "fr": true, "ru": true, "pt": true, "es": true, "it": true, "ar": true, "id": true, "vi": true, "th": true, "ms": true, "ur": true, "tr": true, "sw": true}

type startFrame struct {
	Type, SessionID, Ticket, Provider, SourceLanguage, Voice string
	TargetLanguages                                          []string
	VoiceClone                                               bool
	Qwen3SimulSystemPrompt                                   string
}
type packet struct {
	kind int
	data []byte
	err  error
}

func (a *App) translate(w http.ResponseWriter, r *http.Request) {
	select {
	case a.slots <- struct{}{}:
		defer func() { <-a.slots }()
	default:
		problem(w, 429, "This deployment is at session capacity")
		return
	}
	ws, err := (&websocket.Upgrader{HandshakeTimeout: 10 * time.Second}).Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer ws.Close()
	ws.SetReadLimit(1 << 20)
	_ = ws.SetReadDeadline(time.Now().Add(10 * time.Second))
	var frame startFrame
	if ws.ReadJSON(&frame) != nil || frame.Type != "start" {
		_ = ws.WriteJSON(core.Event{Type: "error", Error: "A start frame is required"})
		return
	}
	a.mu.Lock()
	t, ok := a.tickets[frame.Ticket]
	delete(a.tickets, frame.Ticket)
	a.mu.Unlock()
	if !ok || time.Now().After(t.Expires) || t.Session != frame.SessionID || t.Provider != frame.Provider {
		_ = ws.WriteJSON(core.Event{Type: "error", Error: "Invalid or expired session ticket"})
		return
	}
	if (frame.SourceLanguage != "zh" && frame.SourceLanguage != "en") || len(frame.TargetLanguages) == 0 || len(frame.TargetLanguages) > 3 || len([]rune(frame.Qwen3SimulSystemPrompt)) > 2000 {
		_ = ws.WriteJSON(core.Event{Type: "error", Error: "Invalid language selection or prompt"})
		return
	}
	seen := map[string]bool{}
	for _, lang := range frame.TargetLanguages {
		if !languages[lang] || seen[lang] {
			_ = ws.WriteJSON(core.Event{Type: "error", Error: "Invalid target language"})
			return
		}
		seen[lang] = true
	}
	_ = ws.SetReadDeadline(time.Now().Add(30 * time.Minute))
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Minute)
	defer cancel()
	go func() { <-ctx.Done(); _ = ws.Close() }()
	incoming := make(chan packet, 16)
	go func() {
		for {
			kind, data, e := ws.ReadMessage()
			select {
			case incoming <- packet{kind, data, e}:
			case <-ctx.Done():
				return
			}
			if e != nil {
				return
			}
		}
	}()
	events := make(chan core.Event, 128)
	done := make(chan struct{})
	var workers sync.WaitGroup
	inputs := []chan []byte{}
	provider := a.providers[frame.Provider]
	run := func(p core.Provider, language string, asr bool) {
		ch := make(chan []byte, 64)
		inputs = append(inputs, ch)
		workers.Add(1)
		go func() {
			defer workers.Done()
			local := make(chan core.Event, 64)
			ended := make(chan error, 1)
			go func() {
				ended <- p.Run(ctx, core.SessionConfig{SessionID: frame.SessionID, SourceLanguage: frame.SourceLanguage, TargetLanguage: language, Voice: frame.Voice, VoiceClone: frame.VoiceClone, Qwen3SimulSystemPrompt: frame.Qwen3SimulSystemPrompt}, ch, local)
			}()
			forward := func(e core.Event) {
				if asr && !strings.HasPrefix(e.Type, "source_") && e.Type != "error" {
					return
				}
				e.TargetLanguage = language
				select {
				case events <- e:
				case <-ctx.Done():
				}
			}
			for {
				select {
				case <-ctx.Done():
					return
				case e := <-local:
					forward(e)
				case err := <-ended:
					for {
						select {
						case e := <-local:
							forward(e)
						default:
							if err != nil && ctx.Err() == nil {
								forward(core.Event{Type: "error", Error: err.Error()})
							}
							return
						}
					}
				}
			}
		}()
	}
	for _, lang := range frame.TargetLanguages {
		run(provider, lang, false)
	}
	if frame.Provider == "luna" && a.asr.Ready() {
		run(a.asr, frame.TargetLanguages[0], true)
	}
	go func() { workers.Wait(); close(done) }()
	_ = ws.WriteJSON(map[string]any{"type": "session_started", "sessionId": frame.SessionID, "eventSchemaVersion": 1})
	buffers := map[string]*bytes.Buffer{"input": {}}
	rates := map[string]int{"input": 16000}
	outputRates := map[string]int{}
	stopped := false
	var finishDeadline <-chan time.Time
	send := func(e core.Event) bool {
		_ = ws.SetWriteDeadline(time.Now().Add(15 * time.Second))
		return ws.WriteJSON(e) == nil
	}
	handle := func(e core.Event) bool {
		// A translation provider can finish before ASR and audio drain. The Web
		// client closes on translation_complete; only the aggregate final state
		// below is authoritative for this composed community stream.
		if e.Type == "translation_complete" {
			return true
		}
		if e.Type == "audio_config" {
			outputRates[e.TargetLanguage] = e.SampleRate
		}
		if e.Type == "audio" {
			pcm, err := base64.StdEncoding.DecodeString(e.Audio)
			if err != nil {
				return false
			}
			key := "output-" + e.TargetLanguage
			if buffers[key] == nil {
				buffers[key] = &bytes.Buffer{}
			}
			if buffers[key].Len()+len(pcm) > 64<<20 {
				return false
			}
			buffers[key].Write(pcm)
			rates[key] = outputRates[e.TargetLanguage]
		}
		return send(e)
	}

	var archiveOnce sync.Once
	var archiveError error
	persistAudio := func() error {
		archiveOnce.Do(func() {
			dir := filepath.Join(a.cfg.DataDir, "audio", frame.SessionID)
			if err := os.MkdirAll(dir, 0700); err != nil {
				archiveError = err
				return
			}
			for kind, buf := range buffers {
				if buf.Len() == 0 {
					continue
				}
				if err := os.WriteFile(filepath.Join(dir, kind+".wav"), wav(buf.Bytes(), rates[kind]), 0600); err != nil {
					archiveError = err
					return
				}
			}
		})
		return archiveError
	}
	defer func() { _ = persistAudio() }()

	for {
		select {
		case <-ctx.Done():
			return
		case <-finishDeadline:
			send(core.Event{Type: "error", Error: "Provider completion timed out"})
			return
		case p := <-incoming:
			if p.err != nil {
				return
			}
			if p.kind == websocket.TextMessage {
				var action struct{ Type string }
				if json.Unmarshal(p.data, &action) != nil {
					return
				}
				if action.Type == "stop" && !stopped {
					stopped = true
					for _, ch := range inputs {
						close(ch)
					}
					finishDeadline = time.After(195 * time.Second)
				}
				continue
			}
			if stopped {
				continue
			}
			if len(p.data)%2 != 0 || len(p.data) > 32000 || buffers["input"].Len()+len(p.data) > 64<<20 {
				send(core.Event{Type: "error", Error: "Invalid or excessive audio input"})
				return
			}
			buffers["input"].Write(p.data)
			for _, ch := range inputs {
				select {
				case ch <- p.data:
				case <-ctx.Done():
					return
				case <-time.After(5 * time.Second):
					send(core.Event{Type: "error", Error: "Upstream cannot keep up"})
					return
				}
			}
		case e := <-events:
			if !handle(e) {
				return
			}
		case <-done:
			for {
				select {
				case e := <-events:
					if !handle(e) {
						return
					}
				default:
					if persistAudio() != nil {
						send(core.Event{Type: "error", Error: "Could not persist replay audio"})
						return
					}
					for _, lang := range frame.TargetLanguages {
						send(core.Event{Type: "state", State: "finished", TargetLanguage: lang})
					}
					return
				}
			}
		}
	}
}
func wav(pcm []byte, rate int) []byte {
	if rate == 0 {
		rate = 24000
	}
	var b bytes.Buffer
	b.WriteString("RIFF")
	_ = binary.Write(&b, binary.LittleEndian, uint32(36+len(pcm)))
	b.WriteString("WAVEfmt ")
	for _, v := range []any{uint32(16), uint16(1), uint16(1), uint32(rate), uint32(rate * 2), uint16(2), uint16(16)} {
		_ = binary.Write(&b, binary.LittleEndian, v)
	}
	b.WriteString("data")
	_ = binary.Write(&b, binary.LittleEndian, uint32(len(pcm)))
	b.Write(pcm)
	return b.Bytes()
}
func (a *App) audio(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	rec := publicRecord(a.state.Records[r.PathValue("id")])
	a.mu.Unlock()
	a.serveAudio(w, r, rec)
}
func (a *App) sharedAudio(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	rec, ok := a.shareRecord(r.PathValue("token"))
	a.mu.Unlock()
	if !ok {
		problem(w, 410, "Share expired or revoked")
		return
	}
	a.serveAudio(w, r, rec)
}
func (a *App) serveAudio(w http.ResponseWriter, r *http.Request, rec map[string]any) {
	if rec == nil {
		problem(w, 404, "History not found")
		return
	}
	session := r.URL.Query().Get("sessionId")
	if session == "" {
		session, _ = rec["sessionId"].(string)
	}
	owner, _ := rec["sessionId"].(string)
	allowed := false
	for _, id := range strings.Split(owner, ":") {
		if id == session {
			allowed = true
		}
	}
	kind := r.PathValue("kind")
	if !allowed || !safeID.MatchString(session) || !safeKind.MatchString(kind) {
		problem(w, 404, "Audio not found")
		return
	}
	if kind == "output" {
		kind = "output-" + fmt.Sprint(rec["targetLanguage"])
	}
	file, err := os.Open(filepath.Join(a.cfg.DataDir, "audio", session, kind+".wav"))
	if err != nil {
		problem(w, 404, "Audio not available")
		return
	}
	defer file.Close()
	st, err := file.Stat()
	if err != nil {
		problem(w, 500, "Audio unavailable")
		return
	}
	w.Header().Set("Content-Type", "audio/wav")
	http.ServeContent(w, r, kind+".wav", st.ModTime(), file)
}

type demoProvider struct{}

func (demoProvider) Name() string { return "demo" }
func (demoProvider) Ready() bool  { return true }
func (demoProvider) Run(ctx context.Context, cfg core.SessionConfig, audio <-chan []byte, events chan<- core.Event) error {
	send := func(e core.Event) bool {
		select {
		case events <- e:
			return true
		case <-ctx.Done():
			return false
		}
	}
	send(core.Event{Type: "state", State: "ready", VoiceMode: "default"})
	n := 0
	emitted := false
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case b, ok := <-audio:
			if !ok {
				return nil
			}
			n += len(b)
			if n >= 32000 && !emitted {
				emitted = true
				send(core.Event{Type: "source_done", Text: "这是模拟会话，不识别实际语音。"})
				send(core.Event{Type: "translation_done", Text: "This is a simulated session, not a translation of your speech."})
				pcm := make([]byte, 4800)
				for i := 0; i < len(pcm)/2; i++ {
					binary.LittleEndian.PutUint16(pcm[i*2:], uint16(int16(math.Sin(float64(i)*440*2*math.Pi/24000)*1500)))
				}
				send(core.Event{Type: "audio_config", SampleRate: 24000})
				send(core.Event{Type: "audio", Audio: base64.StdEncoding.EncodeToString(pcm)})
				send(core.Event{Type: "audio_done"})
			}
		}
	}
}
