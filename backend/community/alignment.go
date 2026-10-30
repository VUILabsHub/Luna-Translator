package community

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"net/url"
	"time"
)

// align returns conservative whole-utterance pairs. Embeddings score the pair;
// they do not manufacture sentence boundaries or replace the transcript.
func (a *App) align(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Source, Translation                   string
		TargetOffset                          int
		TranslationEmittedAtMs, SourceAudioMs float64
		Final                                 bool
		Targets                               []struct{ Text string }
	}
	if !decode(w, r, &b) {
		return
	}
	if len([]rune(b.Source))+len([]rune(b.Translation)) > 16000 || b.TargetOffset < 0 {
		problem(w, 400, "Alignment text too large")
		return
	}
	var similarity any
	method := "whole-utterance"
	if a.cfg.AliyunKey != "" && a.cfg.EmbeddingURL != "" && b.Source != "" && b.Translation != "" {
		score, err := embeddingSimilarity(r.Context(), a.cfg.EmbeddingURL, a.cfg.AliyunKey, b.Source, b.Translation)
		if err != nil {
			problem(w, 502, "Embedding service unavailable")
			return
		}
		similarity = score
		method = "embedding-scored-whole-utterance"
	}
	pairs := []any{}
	if b.Source != "" || b.Translation != "" {
		kind := "match"
		if b.Source == "" {
			kind = "target_only"
		}
		if b.Translation == "" {
			kind = "source_only"
		}
		pairs = append(pairs, map[string]any{"id": "utterance-0", "source": b.Source, "translation": b.Translation, "sourceStart": 0, "sourceEnd": len([]rune(b.Source)), "targetStart": b.TargetOffset, "targetEnd": b.TargetOffset + len([]rune(b.Translation)), "emittedAtMs": b.TranslationEmittedAtMs, "sourceAudioMs": b.SourceAudioMs, "status": "approximate", "kind": kind, "similarity": similarity, "confidence": nil})
	}
	respond(w, 200, map[string]any{"pairs": pairs, "method": method, "liveSource": ""})
}
func embeddingSimilarity(ctx context.Context, endpoint, key, source, target string) (float64, error) {
	u, err := url.Parse(endpoint)
	if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") {
		return 0, errors.New("invalid embedding endpoint")
	}
	body, _ := json.Marshal(map[string]any{"model": "text-embedding-v4", "input": []string{source, target}, "encoding_format": "float"})
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "POST", endpoint, bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := client.Do(req)
	if err != nil {
		return 0, errors.New("embedding connection failed")
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return 0, errors.New("embedding request rejected")
	}
	var result struct {
		Data []struct {
			Index     int
			Embedding []float64
		}
	}
	if json.NewDecoder(io.LimitReader(res.Body, 2<<20)).Decode(&result) != nil || len(result.Data) != 2 {
		return 0, errors.New("invalid embedding response")
	}
	vectors := make([][]float64, 2)
	for _, d := range result.Data {
		if d.Index < 0 || d.Index > 1 || vectors[d.Index] != nil {
			return 0, errors.New("invalid embedding index")
		}
		vectors[d.Index] = d.Embedding
	}
	if len(vectors[0]) == 0 || len(vectors[0]) != len(vectors[1]) {
		return 0, errors.New("invalid vector dimensions")
	}
	dot, x, y := 0., 0., 0.
	for i, v := range vectors[0] {
		other := vectors[1][i]
		if math.IsNaN(v) || math.IsNaN(other) || math.IsInf(v, 0) || math.IsInf(other, 0) {
			return 0, errors.New("invalid vector value")
		}
		dot += v * other
		x += v * v
		y += other * other
	}
	if x == 0 || y == 0 {
		return 0, errors.New("zero embedding vector")
	}
	return math.Max(-1, math.Min(1, dot/math.Sqrt(x*y))), nil
}
