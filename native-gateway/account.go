package main

import (
	"context"
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type accountIdentity struct {
	Type        string  `json:"type"`
	DisplayName string  `json:"displayName"`
	Initials    string  `json:"initials"`
	PlanType    *string `json:"planType"`
	Avatar      *string `json:"avatarUrl"`
	image       string
}

type accountCache struct {
	mu               sync.Mutex
	until            time.Time
	value            accountIdentity
	generation       atomic.Uint64
	cachedGeneration uint64
	bridge           *bridge
	privateRoot      string
	client           *http.Client
}

func (a *accountCache) invalidate() { a.generation.Add(1) }

func newAccountCache(b *bridge, privateRoot string) *accountCache {
	return &accountCache{bridge: b, privateRoot: privateRoot, client: &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}

func accountString(s string, max int) string {
	r := []rune(strings.TrimSpace(s))
	if len(r) > max {
		r = r[:max]
	}
	return string(r)
}

func accountInitials(name string) string {
	parts := strings.Fields(name)
	if len(parts) == 0 {
		return "?"
	}
	if len(parts) == 1 {
		return strings.ToUpper(accountString(parts[0], 2))
	}
	return strings.ToUpper(accountString(parts[0], 1) + accountString(parts[1], 1))
}

func allowedAvatar(value string) bool {
	u, err := url.Parse(value)
	if err != nil || u.Scheme != "https" || u.User != nil || (u.Port() != "" && u.Port() != "443") {
		return false
	}
	switch strings.ToLower(u.Hostname()) {
	case "cdn.auth0.com", "files.oaiusercontent.com":
		return true
	}
	return false
}

func (a *accountCache) load(ctx context.Context, refresh bool) (accountIdentity, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if refresh {
		a.invalidate()
	}
	generation := a.generation.Load()
	if !refresh && a.cachedGeneration == generation && time.Now().Before(a.until) {
		return a.value, nil
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	result := accountIdentity{Type: "unknown", DisplayName: "Settings", Initials: "SE"}
	params, _ := json.Marshal(map[string]bool{"refreshToken": refresh})
	data, err := a.bridge.request(ctx, "account/read", params)
	if err != nil {
		return result, err
	}
	var native struct {
		Account *struct{ Type, Email, PlanType string }
	}
	if err := json.Unmarshal(data, &native); err != nil {
		return result, err
	}
	if native.Account != nil {
		n := native.Account
		switch strings.TrimSpace(n.Type) {
		case "chatgpt":
			result.Type, result.DisplayName = "chatgpt", "Profile"
			name, image := a.profile(ctx)
			if name != "" && !strings.EqualFold(name, strings.TrimSpace(n.Email)) {
				result.DisplayName = name
			}
			if allowedAvatar(image) {
				path := "/api/account/avatar"
				result.Avatar, result.image = &path, image
			}
		case "apiKey":
			result.Type, result.DisplayName = "apiKey", "API key"
		case "amazonBedrock":
			result.Type, result.DisplayName = "amazonBedrock", "Amazon Bedrock"
		}
		if plan := accountString(n.PlanType, 64); plan != "" {
			result.PlanType = &plan
		}
	}
	result.Initials = accountInitials(result.DisplayName)
	a.until, a.value, a.cachedGeneration = time.Now().Add(5*time.Minute), result, generation
	return result, nil
}

func (a *accountCache) profile(ctx context.Context) (string, string) {
	path := getenvDefault("CODEX_AUTH_PATH", filepath.Join(a.privateRoot, "auth.json"))
	f, err := os.Open(path)
	if err != nil {
		return "", ""
	}
	defer f.Close()
	var auth struct {
		Tokens struct {
			Access  string `json:"access_token"`
			Account string `json:"account_id"`
		} `json:"tokens"`
	}
	if decodeOne(io.LimitReader(f, 1<<20), &auth) != nil {
		return "", ""
	}
	access := accountString(auth.Tokens.Access, 512)
	account := accountString(auth.Tokens.Account, 512)
	if access == "" {
		return "", ""
	}
	req, err := http.NewRequestWithContext(ctx, "GET", "https://chatgpt.com/backend-api/wham/profiles/me", nil)
	if err != nil {
		return "", ""
	}
	req.Header.Set("Authorization", "Bearer "+access)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "Codex WebUI")
	if account != "" {
		req.Header.Set("Chatgpt-Account-Id", account)
	}
	res, err := a.client.Do(req)
	if err != nil {
		return "", ""
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return "", ""
	}
	var body struct {
		Profile struct {
			Display string `json:"display_name"`
			Image   string `json:"profile_picture_url"`
		} `json:"profile"`
	}
	if decodeOne(io.LimitReader(res.Body, 1<<20), &body) != nil {
		return "", ""
	}
	return accountString(body.Profile.Display, 160), accountString(body.Profile.Image, 2048)
}

func (a *accountCache) register(mux *http.ServeMux) {
	handler := func(w http.ResponseWriter, r *http.Request) {
		site := r.Header.Get("Sec-Fetch-Site")
		if !directLoopback(r) || (site != "" && site != "same-origin" && site != "none") {
			setupError(w, 403, "Account identity is available only on localhost")
			return
		}
		value, err := a.load(r.Context(), r.URL.Query().Get("refresh") == "1")
		if r.URL.Path == "/api/account" {
			jsonReply(w, 200, value)
			return
		}
		if err != nil {
			setupError(w, 502, "Profile avatar unavailable")
			return
		}
		if !allowedAvatar(value.image) {
			setupError(w, 404, "No profile avatar")
			return
		}
		req, err := http.NewRequestWithContext(r.Context(), "GET", value.image, nil)
		if err != nil {
			setupError(w, 502, "Profile avatar unavailable")
			return
		}
		req.Header.Set("Accept", "image/avif,image/webp,image/png,image/jpeg,image/gif")
		res, err := a.client.Do(req)
		if err != nil {
			setupError(w, 502, "Profile avatar unavailable")
			return
		}
		defer res.Body.Close()
		typ, _, _ := mime.ParseMediaType(res.Header.Get("Content-Type"))
		const maxAvatar = 2 << 20
		if res.StatusCode != 200 || res.ContentLength > maxAvatar || (typ != "image/png" && typ != "image/jpeg" && typ != "image/webp" && typ != "image/gif" && typ != "image/avif") {
			setupError(w, 502, "Profile avatar unavailable")
			return
		}
		data, err := io.ReadAll(io.LimitReader(res.Body, maxAvatar+1))
		if err != nil || len(data) > maxAvatar {
			setupError(w, 502, "Profile avatar unavailable")
			return
		}
		w.Header().Set("Content-Type", typ)
		w.Header().Set("Cache-Control", "private, max-age=300")
		_, _ = w.Write(data)
	}
	mux.HandleFunc("GET /api/account", handler)
	mux.HandleFunc("GET /api/account/avatar", handler)
}
