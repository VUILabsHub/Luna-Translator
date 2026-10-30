package qwenasr

import (
	"context"
	"os"
	"simultrans/core"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestLiveCommunityASR(t *testing.T) {
	if os.Getenv("ASR_LIVE_TEST") != "1" {
		t.Skip("opt-in only; requires your own ASR account and synthetic PCM")
	}
	pcm, err := os.ReadFile(os.Getenv("LUNA_TEST_PCM"))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	audio := make(chan []byte)
	events := make(chan core.Event, 128)
	var wg sync.WaitGroup
	wg.Add(1)
	var transcript strings.Builder
	go func() {
		defer wg.Done()
		for e := range events {
			if strings.HasPrefix(e.Type, "source_") && e.Text != "" {
				if e.Type != "source_delta" {
					transcript.Reset()
				}
				transcript.WriteString(e.Text)
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
	err = (Adapter{APIKey: os.Getenv("DASHSCOPE_API_KEY"), WorkspaceID: os.Getenv("DASHSCOPE_WORKSPACE_ID"), Region: os.Getenv("DASHSCOPE_REGION")}).Run(ctx, core.SessionConfig{SourceLanguage: "zh"}, audio, events)
	close(events)
	wg.Wait()
	if err != nil {
		t.Fatal(err)
	}
	if transcript.Len() == 0 {
		t.Fatal("no source transcript")
	}
	t.Logf("Real ASR returned %d characters", len([]rune(transcript.String())))
}
