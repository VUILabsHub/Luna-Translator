package community

import (
	"context"
	"os"
	"testing"
)

func TestLiveEmbedding(t *testing.T) {
	if os.Getenv("EMBEDDING_LIVE_TEST") != "1" {
		t.Skip("opt-in only; requires your own embedding account")
	}
	score, err := embeddingSimilarity(context.Background(), os.Getenv("DASHSCOPE_EMBEDDING_URL"), os.Getenv("DASHSCOPE_API_KEY"), "欢迎使用实时翻译。", "Welcome to real-time translation.")
	if err != nil {
		t.Fatal(err)
	}
	if score < .1 || score > 1 {
		t.Fatalf("unexpected multilingual similarity: %v", score)
	}
	t.Logf("Real embedding pair cosine: %.3f", score)
}
