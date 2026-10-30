package lunapublic

import (
	"context"
	"encoding/json"
	"os"
	"simultrans/core"
	"sync"
	"testing"
	"time"
)

// Explicit opt-in only. Never configured in ordinary CI; input must be synthetic
// or supplied with permission, and the account may incur provider charges.
func TestLivePublicAPI(t *testing.T) {
	if os.Getenv("LUNA_LIVE_TEST") != "1" {
		t.Skip("set LUNA_LIVE_TEST=1 and provide your own credential/input")
	}
	pcm, err := os.ReadFile(os.Getenv("LUNA_TEST_PCM"))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()
	audio := make(chan []byte)
	events := make(chan core.Event, 128)
	counts := map[string]int{}
	text := ""
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for e := range events {
			counts[e.Type]++
			if e.Type == "translation_delta" {
				text += e.Text
			}
		}
	}()
	go func() {
		defer close(audio)
		for i := 0; i < len(pcm); i += 3200 {
			end := i + 3200
			if end > len(pcm) {
				end = len(pcm)
			}
			select {
			case audio <- pcm[i:end]:
			case <-ctx.Done():
				return
			}
			time.Sleep(100 * time.Millisecond)
		}
	}()
	started := time.Now()
	err = (Adapter{APIKey: os.Getenv("LUNA_API_KEY"), Endpoint: os.Getenv("LUNA_WS_URL")}).Run(ctx, core.SessionConfig{SourceLanguage: "zh", TargetLanguage: "en"}, audio, events)
	close(events)
	wg.Wait()
	if err != nil {
		t.Fatal(err)
	}
	if text == "" || counts["audio"] == 0 {
		t.Fatalf("missing real output: %v", counts)
	}
	receipt := map[string]any{"durationMs": time.Since(started).Milliseconds(), "inputBytes": len(pcm), "events": counts, "translation": text}
	if path := os.Getenv("LUNA_TEST_RECEIPT"); path != "" {
		b, _ := json.MarshalIndent(receipt, "", "  ")
		if err = os.WriteFile(path, b, 0600); err != nil {
			t.Fatal(err)
		}
	}
	t.Logf("Real public API passed: input=%d bytes, translation=%d characters, audioFrames=%d", len(pcm), len([]rune(text)), counts["audio"])
}
