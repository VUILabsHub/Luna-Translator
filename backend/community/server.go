// Package community contains the standalone, single-workspace product API.
// It has no dependency on evaluation, annotation, model inference or internal deployment code.
package community

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"simultrans/core"
	"simultrans/providers/aliyun"
	"simultrans/providers/lunapublic"
	"simultrans/providers/qwenasr"
	"sort"
	"strings"
	"sync"
	"time"
)

type Config struct {
	DataDir, Password, LunaKey, LunaURL, AliyunKey, Workspace, Region, ASRURL, EmbeddingURL, Build string
	Demo                                                                                           bool
}

func FromEnv() Config {
	return Config{DataDir: env("DATA_DIR", "/data"), Password: os.Getenv("ADMIN_PASSWORD"), LunaKey: os.Getenv("LUNA_API_KEY"), LunaURL: env("LUNA_WS_URL", "wss://simultrans.lunalabs.cn/v1/realtime/translate"), AliyunKey: os.Getenv("DASHSCOPE_API_KEY"), Workspace: os.Getenv("DASHSCOPE_WORKSPACE_ID"), Region: env("DASHSCOPE_REGION", "cn-beijing"), ASRURL: os.Getenv("DASHSCOPE_ASR_URL"), EmbeddingURL: os.Getenv("DASHSCOPE_EMBEDDING_URL"), Build: env("BUILD_SHA", "development"), Demo: os.Getenv("DEMO_MODE") == "true"}
}
func env(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

type Share struct {
	HistoryID string         `json:"historyId"`
	Record    map[string]any `json:"record"`
	ExpiresAt time.Time      `json:"expiresAt"`
}
type State struct {
	Records map[string]map[string]any `json:"records"`
	Shares  map[string]Share          `json:"shares"`
}
type ticket struct {
	Session, Provider string
	Expires           time.Time
}
type App struct {
	cfg              Config
	mu               sync.Mutex
	state            State
	tickets          map[string]ticket
	secret, password []byte
	providers        map[string]core.Provider
	asr              core.Provider
	slots            chan struct{}
	mux              *http.ServeMux
}

func randomID() string {
	var b [24]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b[:])
}
func New(cfg Config) (*App, error) {
	if cfg.DataDir == "" {
		return nil, errors.New("DATA_DIR is required")
	}
	if err := os.MkdirAll(cfg.DataDir, 0700); err != nil {
		return nil, err
	}
	secret, err := persistentSecret(filepath.Join(cfg.DataDir, "signing-key"))
	if err != nil {
		return nil, err
	}
	password := cfg.Password
	if password == "" {
		b, e := persistentSecret(filepath.Join(cfg.DataDir, "admin-password"))
		if e != nil {
			return nil, e
		}
		password = string(b)
	}
	if len(password) < 12 {
		return nil, errors.New("ADMIN_PASSWORD must contain at least 12 characters")
	}
	app := &App{cfg: cfg, secret: secret, password: []byte(password), state: State{Records: map[string]map[string]any{}, Shares: map[string]Share{}}, tickets: map[string]ticket{}, slots: make(chan struct{}, 4), providers: map[string]core.Provider{}, mux: http.NewServeMux()}
	data, err := os.ReadFile(filepath.Join(cfg.DataDir, "state.json"))
	if err == nil {
		if err = json.Unmarshal(data, &app.state); err != nil {
			return nil, fmt.Errorf("invalid persistent state: %w", err)
		}
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	if app.state.Records == nil || app.state.Shares == nil {
		return nil, errors.New("invalid persistent state maps")
	}
	app.providers["luna"] = lunapublic.Adapter{APIKey: cfg.LunaKey, Endpoint: cfg.LunaURL}
	if os.Getenv("ENABLE_BAILIAN_TRANSLATE") == "true" {
		app.providers["aliyun"] = aliyun.Adapter{APIKey: cfg.AliyunKey, WorkspaceID: cfg.Workspace, Region: cfg.Region, Model: "qwen3.5-livetranslate-flash-realtime"}
	}
	app.asr = qwenasr.Adapter{APIKey: cfg.AliyunKey, WorkspaceID: cfg.Workspace, Region: cfg.Region, Endpoint: cfg.ASRURL}
	if cfg.Demo {
		app.providers = map[string]core.Provider{"demo": demoProvider{}}
	}
	app.routes()
	return app, nil
}
func persistentSecret(path string) ([]byte, error) {
	b, err := os.ReadFile(path)
	if err == nil {
		if len(b) < 24 {
			return nil, errors.New("invalid persisted credential")
		}
		return b, nil
	}
	if !os.IsNotExist(err) {
		return nil, err
	}
	b = []byte(randomID())
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return nil, err
	}
	_, err = f.Write(b)
	closeErr := f.Close()
	if err != nil {
		return nil, err
	}
	return b, closeErr
}
func (a *App) save() error {
	b, err := json.Marshal(a.state)
	if err != nil {
		return err
	}
	tmp := filepath.Join(a.cfg.DataDir, "state.json.tmp")
	if err = os.WriteFile(tmp, b, 0600); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(a.cfg.DataDir, "state.json"))
}
func respond(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func problem(w http.ResponseWriter, status int, message string) {
	respond(w, status, map[string]string{"error": message})
}
func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 8<<20)
	if json.NewDecoder(r.Body).Decode(v) != nil {
		problem(w, 400, "Invalid JSON or request too large")
		return false
	}
	return true
}
func (a *App) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-store")
	if o := r.Header.Get("Origin"); o != "" {
		u, err := url.Parse(o)
		if err != nil || !strings.EqualFold(u.Host, r.Host) {
			problem(w, 403, "Cross-origin request denied")
			return
		}
	}
	a.mux.ServeHTTP(w, r)
}
func (a *App) issueToken() string {
	h := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	p, _ := json.Marshal(map[string]any{"sub": "owner", "exp": time.Now().Add(12 * time.Hour).Unix()})
	data := h + "." + base64.RawURLEncoding.EncodeToString(p)
	m := hmac.New(sha256.New, a.secret)
	m.Write([]byte(data))
	return data + "." + base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}
func (a *App) validToken(token string) bool {
	p := strings.Split(token, ".")
	if len(p) != 3 {
		return false
	}
	m := hmac.New(sha256.New, a.secret)
	m.Write([]byte(p[0] + "." + p[1]))
	sig, err := base64.RawURLEncoding.DecodeString(p[2])
	if err != nil || !hmac.Equal(sig, m.Sum(nil)) {
		return false
	}
	b, err := base64.RawURLEncoding.DecodeString(p[1])
	var claims struct {
		Sub string
		Exp int64
	}
	return err == nil && json.Unmarshal(b, &claims) == nil && claims.Sub == "owner" && claims.Exp > time.Now().Unix()
}
func (a *App) auth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") || !a.validToken(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")) {
			problem(w, 401, "Please sign in to this deployment")
			return
		}
		next(w, r)
	}
}
func (a *App) routes() {
	a.mux.HandleFunc("GET /api/downloads/ios/latest.json", func(w http.ResponseWriter, r *http.Request) {
		respond(w, 200, map[string]string{"trackViewUrl": "https://apps.apple.com/cn/app/id6806330215"})
	})
	a.mux.HandleFunc("GET /api/downloads/android/latest.json", func(w http.ResponseWriter, r *http.Request) { respond(w, 200, map[string]bool{"available": true}) })
	a.mux.HandleFunc("GET /api/downloads/android/latest", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "https://simultrans.lunalabs.cn/api/downloads/android/latest", http.StatusTemporaryRedirect)
	})
	a.mux.HandleFunc("GET /legal/{page}", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>社区版数据与许可说明</title><body><main><h1>社区版数据与许可说明</h1><p>此实例由部署者独立运营。应用源码采用 Apache-2.0；模型服务由部署者自行配置。</p><p>开始真实同传会发送所选音频到所配置的 Luna / 百炼服务。历史及输入、译音保存在本实例数据卷。生成分享链接会向链接持有者公开所选快照与音频。请只提交您有权处理的音频。</p><p>同一部署密码的使用者共享此工作区。隐私或数据删除请求请联系本实例部署者。删除历史会撤销分享并清理无其他记录引用的归档音频。</p><p>本页为软件数据流程说明；远程公开运营所需的联系信息、隐私政策及其他安排由部署者维护。</p><a href="https://github.com/VUILabsHub/Luna-Translator/blob/main/LICENSE">查看开源许可证</a> · <a href="/">返回工作区</a></main></body></html>`))
	})

	a.mux.HandleFunc("GET /api/consumer/meetings/capabilities", func(w http.ResponseWriter, r *http.Request) {
		respond(w, 200, map[string]any{"available": false, "enabled": false, "reason": "多人会议不在社区首版范围"})
	})
	a.mux.HandleFunc("GET /api/settings/catalog", func(w http.ResponseWriter, r *http.Request) {
		respond(w, 200, map[string]any{"version": "community-0.1", "defaults": map[string]string{"translationModel": "flash-v2", "ttsModel": "qwen", "noisePreset": "default", "fontSize": "medium"}, "translationModels": []any{}, "ttsModels": []any{}, "routes": []any{}, "noisePresets": []any{}, "fontSizes": []any{}, "maxSoloTargetLanguages": 3, "maxTargetLanguages": 3, "info": map[string]any{}})
	})

	a.mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		respond(w, 200, map[string]any{"status": "ok", "buildSha": a.cfg.Build})
	})
	a.mux.HandleFunc("GET /ready", func(w http.ResponseWriter, r *http.Request) { respond(w, 200, map[string]bool{"ready": true}) })
	a.mux.HandleFunc("GET /api/config", a.publicConfig)
	a.mux.HandleFunc("POST /api/community/login", func(w http.ResponseWriter, r *http.Request) {
		var body struct{ Password string }
		if !decode(w, r, &body) {
			return
		}
		got, want := sha256.Sum256([]byte(body.Password)), sha256.Sum256(a.password)
		if subtle.ConstantTimeCompare(got[:], want[:]) != 1 {
			time.Sleep(250 * time.Millisecond)
			problem(w, 401, "Incorrect deployment password")
			return
		}
		respond(w, 200, map[string]string{"accessToken": a.issueToken()})
	})
	quota := func(w http.ResponseWriter, r *http.Request) {
		respond(w, 200, map[string]any{"dailyMinutes": 0, "remainingMinutes": 0, "unlimited": true, "resetAt": time.Now().Add(24 * time.Hour).UTC().Format(time.RFC3339)})
	}
	a.mux.HandleFunc("GET /api/consumer/quota", a.auth(quota))
	a.mux.HandleFunc("POST /api/consumer/quota/consume", a.auth(quota))
	a.mux.HandleFunc("POST /api/consumer/ws/session", a.auth(a.preflight))
	a.mux.HandleFunc("GET /ws/translate", a.translate)
	a.mux.HandleFunc("GET /api/consumer/history", a.auth(a.listHistory))
	a.mux.HandleFunc("POST /api/consumer/history", a.auth(a.createHistory))
	a.mux.HandleFunc("GET /api/consumer/history/lookup", a.auth(a.lookupHistory))
	a.mux.HandleFunc("GET /api/consumer/history/{id}", a.auth(a.getHistory))
	a.mux.HandleFunc("DELETE /api/consumer/history/{id}", a.auth(a.deleteHistory))
	a.mux.HandleFunc("PATCH /api/consumer/history/{id}", a.auth(a.renameHistory))
	a.mux.HandleFunc("GET /api/consumer/history/{id}/audio/{kind}", a.auth(a.audio))
	a.mux.HandleFunc("POST /api/consumer/shares", a.auth(a.createShare))
	a.mux.HandleFunc("DELETE /api/consumer/shares/{token}", a.auth(a.revokeShare))
	a.mux.HandleFunc("GET /api/shares/{token}", a.sharedHistory)
	a.mux.HandleFunc("GET /api/shares/{token}/audio/{kind}", a.sharedAudio)
	a.mux.HandleFunc("POST /api/semantic-align/align", a.auth(a.align))
	a.mux.HandleFunc("GET /api/analytics/config", func(w http.ResponseWriter, r *http.Request) { respond(w, 200, map[string]bool{"enabled": false}) })
	a.mux.HandleFunc("GET /api/s2st-health", func(w http.ResponseWriter, r *http.Request) {
		respond(w, 200, map[string]any{"available": true, "monitored": false})
	})
}
func (a *App) publicConfig(w http.ResponseWriter, r *http.Request) {
	providers := []map[string]any{}
	defaultID := ""
	for _, id := range []string{"demo", "luna", "aliyun"} {
		if p := a.providers[id]; p != nil {
			if p.Ready() && defaultID == "" {
				defaultID = id
			}
			providers = append(providers, map[string]any{"id": id, "ready": p.Ready(), "configured": p.Ready(), "model": map[string]string{"demo": "模拟体验（非真实翻译）", "luna": "LunaLT Flash v3", "aliyun": "Qwen LiveTranslate"}[id], "voiceClone": false, "reason": "Configure provider credentials in the backend .env"})
		}
	}
	respond(w, 200, map[string]any{"defaultProvider": defaultID, "providers": providers, "configured": true, "voiceClone": false, "consumerVoiceCloneRequired": false, "historySharing": false, "annotationStorage": false, "annotationV2Storage": false, "buildSha": a.cfg.Build, "eventSchemaVersion": 1, "community": true, "demo": a.cfg.Demo, "sourceAsrConfigured": a.asr.Ready(), "consumerSourceLanguages": []string{"zh", "en"}, "consumerTargetLanguages": []string{"zh", "en", "ja", "ko", "de", "fr", "ru", "pt", "es", "it", "ar", "id", "vi", "th", "ms", "ur", "tr", "sw"}})
}
func (a *App) preflight(w http.ResponseWriter, r *http.Request) {
	var b struct{ Provider string }
	if !decode(w, r, &b) {
		return
	}
	p := a.providers[b.Provider]
	if p == nil || !p.Ready() {
		problem(w, 503, "Provider is not configured")
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	for k, t := range a.tickets {
		if time.Now().After(t.Expires) {
			delete(a.tickets, k)
		}
	}
	if len(a.tickets) >= 256 {
		problem(w, 429, "Too many pending sessions")
		return
	}
	key := randomID()
	id := "cs-" + randomID()
	a.tickets[key] = ticket{id, b.Provider, time.Now().Add(30 * time.Second)}
	respond(w, 200, map[string]any{"sessionId": id, "provider": b.Provider, "ticket": key, "eventSchemaVersion": 1})
}
func (a *App) createHistory(w http.ResponseWriter, r *http.Request) {
	var rec map[string]any
	if !decode(w, r, &rec) {
		return
	}
	sid, _ := rec["sessionId"].(string)
	if sid == "" || len(sid) > 8192 {
		problem(w, 400, "Invalid sessionId")
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	id := ""
	for k, v := range a.state.Records {
		if v["sessionId"] == sid {
			id = k
			break
		}
	}
	if id == "" {
		id = randomID()
	}
	old := a.state.Records[id]
	rec["id"] = id
	if old != nil {
		rec["createdAt"] = old["createdAt"]
	} else {
		rec["createdAt"] = time.Now().UTC().Format(time.RFC3339Nano)
	}
	rec["titleStatus"] = "fallback"
	if rec["title"] == nil {
		rec["title"] = "同传记录"
	}
	a.state.Records[id] = rec
	if err := a.save(); err != nil {
		if old == nil {
			delete(a.state.Records, id)
		} else {
			a.state.Records[id] = old
		}
		problem(w, 500, "Could not persist history")
		return
	}
	respond(w, 201, rec)
}
func (a *App) listHistory(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	defer a.mu.Unlock()
	list := []map[string]any{}
	for _, rec := range a.state.Records {
		copy := map[string]any{}
		for k, v := range rec {
			copy[k] = v
		}
		copy["share"] = a.ownerShare(fmt.Sprint(rec["id"]))
		copy["preview"] = rec["sourceText"]
		if u, ok := rec["units"].([]any); ok {
			copy["unitCount"] = len(u)
		}
		list = append(list, copy)
	}
	sort.Slice(list, func(i, j int) bool { return fmt.Sprint(list[i]["createdAt"]) > fmt.Sprint(list[j]["createdAt"]) })
	respond(w, 200, map[string]any{"records": list})
}
func (a *App) lookupHistory(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	defer a.mu.Unlock()
	for id, v := range a.state.Records {
		if v["sessionId"] == r.URL.Query().Get("sessionId") {
			respond(w, 200, map[string]string{"id": id})
			return
		}
	}
	problem(w, 404, "History not found")
}
func (a *App) getHistory(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	defer a.mu.Unlock()
	rec := a.state.Records[r.PathValue("id")]
	if rec == nil {
		problem(w, 404, "History not found")
		return
	}
	copy := map[string]any{}
	for k, v := range rec {
		copy[k] = v
	}
	copy["share"] = a.ownerShare(r.PathValue("id"))
	respond(w, 200, copy)
}
func (a *App) deleteHistory(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	defer a.mu.Unlock()
	id := r.PathValue("id")
	old := a.state.Records[id]
	if old == nil {
		problem(w, 404, "History not found")
		return
	}
	oldShares := map[string]Share{}
	for k, v := range a.state.Shares {
		if v.HistoryID == id {
			oldShares[k] = v
			delete(a.state.Shares, k)
		}
	}
	delete(a.state.Records, id)
	if a.save() != nil {
		a.state.Records[id] = old
		for k, v := range oldShares {
			a.state.Shares[k] = v
		}
		problem(w, 500, "Could not delete history")
		return
	}

	for _, sid := range strings.Split(fmt.Sprint(old["sessionId"]), ":") {
		referenced := false
		for _, rec := range a.state.Records {
			for _, other := range strings.Split(fmt.Sprint(rec["sessionId"]), ":") {
				if sid == other {
					referenced = true
				}
			}
		}
		if !referenced && safeID.MatchString(sid) {
			if err := os.RemoveAll(filepath.Join(a.cfg.DataDir, "audio", sid)); err != nil {
				problem(w, 500, "History removed, but audio cleanup failed; inspect storage permissions")
				return
			}
		}
	}
	respond(w, 200, map[string]bool{"ok": true})
}
func (a *App) renameHistory(w http.ResponseWriter, r *http.Request) {
	var b struct{ Title string }
	if !decode(w, r, &b) {
		return
	}
	if len([]rune(b.Title)) > 120 || strings.TrimSpace(b.Title) == "" {
		problem(w, 400, "Invalid title")
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	rec := a.state.Records[r.PathValue("id")]
	if rec == nil {
		problem(w, 404, "History not found")
		return
	}
	old := rec["title"]
	rec["title"] = b.Title
	if a.save() != nil {
		rec["title"] = old
		problem(w, 500, "Could not rename history")
		return
	}
	respond(w, 200, rec)
}
func (a *App) createShare(w http.ResponseWriter, r *http.Request) {
	var b struct {
		HistoryID string
		TTLDays   int
	}
	if !decode(w, r, &b) {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.state.Records[b.HistoryID] == nil {
		problem(w, 404, "History not found")
		return
	}
	if b.TTLDays < 1 || b.TTLDays > 30 {
		b.TTLDays = 30
	}
	if existing := a.ownerShare(b.HistoryID); existing != nil {
		respond(w, 200, existing)
		return
	}
	token := randomID()
	s := Share{HistoryID: b.HistoryID, Record: publicRecord(a.state.Records[b.HistoryID]), ExpiresAt: time.Now().Add(time.Duration(b.TTLDays) * 24 * time.Hour)}
	a.state.Shares[token] = s
	if a.save() != nil {
		delete(a.state.Shares, token)
		problem(w, 500, "Could not persist share")
		return
	}
	respond(w, 201, map[string]any{"token": token, "path": "/s/" + token, "expiresAt": s.ExpiresAt})
}

// Called with a.mu held; public snapshots never include owner share metadata.
func (a *App) ownerShare(id string) map[string]any {
	for token, s := range a.state.Shares {
		if s.HistoryID == id && time.Now().Before(s.ExpiresAt) {
			return map[string]any{"token": token, "path": "/s/" + token, "expiresAt": s.ExpiresAt}
		}
	}
	return nil
}
func (a *App) revokeShare(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	defer a.mu.Unlock()
	token := r.PathValue("token")
	old, ok := a.state.Shares[token]
	delete(a.state.Shares, token)
	if a.save() != nil {
		if ok {
			a.state.Shares[token] = old
		}
		problem(w, 500, "Could not revoke share")
		return
	}
	respond(w, 200, map[string]bool{"ok": true})
}
func (a *App) shareRecord(token string) (map[string]any, bool) {
	s, ok := a.state.Shares[token]
	rec := s.Record
	return rec, ok && time.Now().Before(s.ExpiresAt) && rec != nil && a.state.Records[s.HistoryID] != nil
}
func (a *App) sharedHistory(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	defer a.mu.Unlock()
	rec, ok := a.shareRecord(r.PathValue("token"))
	if !ok {
		problem(w, 410, "Share expired or revoked")
		return
	}
	copy := map[string]any{}
	for _, key := range []string{"id", "sessionId", "createdAt", "title", "sourceLanguage", "targetLanguage", "sourceText", "translationText", "durationMs", "units", "provider"} {
		copy[key] = rec[key]
	}
	respond(w, 200, map[string]any{"record": copy, "expiresAt": a.state.Shares[r.PathValue("token")].ExpiresAt})
}

func publicRecord(rec map[string]any) map[string]any {
	result := map[string]any{}
	for _, key := range []string{"id", "sessionId", "createdAt", "title", "sourceLanguage", "targetLanguage", "sourceText", "translationText", "durationMs", "units", "provider"} {
		result[key] = rec[key]
	}
	b, _ := json.Marshal(result)
	var snapshot map[string]any
	_ = json.Unmarshal(b, &snapshot)
	return snapshot
}
