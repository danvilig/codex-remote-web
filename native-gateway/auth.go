package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/scrypt"
)

const passwordCookie = "codex_webui_session"
const passwordTTL = 7 * 24 * time.Hour

type passwordRecord struct {
	Version   int    `json:"version"`
	Algorithm string `json:"algorithm"`
	Salt      string `json:"salt"`
	Hash      string `json:"hash"`
}

type localAuthenticator struct {
	mu              sync.Mutex
	loopback        bool
	store, explicit string
	credential      *passwordRecord
}

type authResult struct {
	ok                  bool
	status              int
	code, origin, email string
	expires             time.Time
}

func equalSecret(a, b string) bool {
	x, y := sha256.Sum256([]byte(a)), sha256.Sum256([]byte(b))
	return subtle.ConstantTimeCompare(x[:], y[:]) == 1
}

func randomSecret(size int) string {
	b := make([]byte, size)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func loadLocalAuth(store, secret string, loopback bool) (*localAuthenticator, error) {
	a := &localAuthenticator{loopback: loopback, store: store, explicit: secret}
	if secret == "" {
		err := a.reload()
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
	}
	return a, nil
}

func (a *localAuthenticator) reload() error {
	raw, err := os.ReadFile(a.store)
	if err != nil {
		return err
	}
	var record passwordRecord
	if json.Unmarshal(raw, &record) != nil || record.Version != 1 || record.Algorithm != "scrypt" || len(record.Salt) < 16 || len(record.Hash) < 32 {
		return errors.New("Invalid Codex WebUI password store")
	}
	a.credential = &record
	return nil
}

func (a *localAuthenticator) secret() string {
	if a.explicit != "" {
		return a.explicit
	}
	if a.credential == nil {
		return ""
	}
	hash := sha256.Sum256([]byte("codex-webui-session:" + a.credential.Salt + ":" + a.credential.Hash))
	return base64.RawURLEncoding.EncodeToString(hash[:])
}

func signature(payload, secret string) string {
	m := hmac.New(sha256.New, []byte(secret))
	_, _ = m.Write([]byte(payload))
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

func loopbackHost(host string) bool {
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	return strings.EqualFold(host, "localhost") || strings.Trim(host, "[]") == "127.0.0.1" || strings.Trim(host, "[]") == "::1"
}

func directLoopback(r *http.Request) bool {
	if !peerLoopback(r) || !loopbackHost(r.Host) {
		return false
	}
	for header := range r.Header {
		h := strings.ToLower(header)
		if h == "forwarded" || h == "x-real-ip" || strings.HasPrefix(h, "x-forwarded-") || strings.HasPrefix(h, "cf-") {
			return false
		}
	}
	return true
}

func peerLoopback(r *http.Request) bool {
	ip, _, err := net.SplitHostPort(r.RemoteAddr)
	return err == nil && net.ParseIP(ip).IsLoopback()
}

func requestOrigin(r *http.Request) string {
	scheme := "http://"
	if r.TLS != nil {
		scheme = "https://"
	}
	return scheme + strings.ToLower(r.Host)
}

func sameOrigin(r *http.Request, origin string) bool {
	return r.Header.Get("Origin") == "" || r.Header.Get("Origin") == origin
}

func (a *localAuthenticator) authenticate(r *http.Request) authResult {
	origin := requestOrigin(r)
	if r.Header.Get("Sec-Fetch-Site") == "cross-site" || !sameOrigin(r, origin) {
		return authResult{status: 403, code: "AUTH_FORBIDDEN"}
	}
	if directLoopback(r) {
		return authResult{ok: true, origin: origin}
	}
	a.mu.Lock()
	secret := a.secret()
	a.mu.Unlock()
	if secret != "" {
		bearer, isBearer := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		username, password, basic := r.BasicAuth()
		if (isBearer && equalSecret(bearer, secret)) || (basic && username == "codex" && equalSecret(password, secret)) {
			return authResult{ok: true, origin: origin}
		}
		if cookie, err := r.Cookie(passwordCookie); err == nil {
			parts := strings.Split(cookie.Value, ".")
			if len(parts) == 3 && parts[1] != "" {
				if millis, err := strconv.ParseInt(parts[0], 10, 64); err == nil && millis > time.Now().UnixMilli() && equalSecret(parts[2], signature(parts[0]+"."+parts[1], secret)) {
					return authResult{ok: true, origin: origin, expires: time.UnixMilli(millis)}
				}
			}
		}
	}
	return authResult{status: 401, code: "AUTH_REQUIRED"}
}

func passwordHash(password, salt string) (string, error) {
	key, err := scrypt.Key([]byte(password), []byte(salt), 16384, 8, 1, 32)
	return base64.RawURLEncoding.EncodeToString(key), err
}

func (a *localAuthenticator) save(password string) error {
	salt := randomSecret(16)
	hash, err := passwordHash(password, salt)
	if err != nil {
		return err
	}
	record := passwordRecord{Version: 1, Algorithm: "scrypt", Salt: salt, Hash: hash}
	if err = os.MkdirAll(filepath.Dir(a.store), 0700); err != nil {
		return err
	}
	f, err := os.OpenFile(a.store, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	err = json.NewEncoder(f).Encode(record)
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		a.credential = &record
	}
	return err
}

func (a *localAuthenticator) http(w http.ResponseWriter, r *http.Request) {
	status := a.authenticate(r)
	if r.URL.Path == "/api/auth/status" {
		a.mu.Lock()
		configured := a.secret() != ""
		a.mu.Unlock()
		jsonReply(w, 200, map[string]any{"mode": "local", "expiresAt": nil, "authenticated": status.ok, "passwordRequired": configured, "setupRequired": !configured && !a.loopback && !status.ok})
		return
	}
	if r.Method != "POST" {
		w.Header().Set("Allow", "POST")
		jsonReply(w, 405, map[string]string{"error": "Method not allowed"})
		return
	}
	if status.status == 403 {
		jsonReply(w, 403, map[string]string{"error": "Password request was rejected"})
		return
	}
	var body struct {
		Password string `json:"password"`
	}
	if decodeOne(http.MaxBytesReader(w, r.Body, 4096), &body) != nil || body.Password == "" || len(body.Password) > 1024 {
		jsonReply(w, 400, map[string]string{"error": "Invalid password request"})
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if r.URL.Path == "/api/auth/setup" {
		if len(body.Password) < 12 || len(body.Password) > 256 {
			jsonReply(w, 400, map[string]string{"error": "Password must be between 12 and 256 characters"})
			return
		}
		if a.loopback || a.secret() != "" {
			jsonReply(w, 409, map[string]string{"error": "Password setup is no longer available"})
			return
		}
		if err := a.save(body.Password); err != nil {
			if errors.Is(err, os.ErrExist) {
				_ = a.reload()
				jsonReply(w, 409, map[string]string{"error": "Password setup is no longer available"})
			} else {
				jsonReply(w, 500, map[string]string{"error": "Unable to save the password"})
			}
			return
		}
	} else {
		valid := a.explicit != "" && equalSecret(a.explicit, body.Password)
		if a.credential != nil {
			hash, err := passwordHash(body.Password, a.credential.Salt)
			valid = err == nil && equalSecret(hash, a.credential.Hash)
		}
		if !valid {
			jsonReply(w, 401, map[string]string{"error": "Incorrect password"})
			return
		}
	}
	payload := strconv.FormatInt(time.Now().Add(passwordTTL).UnixMilli(), 10) + "." + randomSecret(24)
	http.SetCookie(w, &http.Cookie{Name: passwordCookie, Value: payload + "." + signature(payload, a.secret()), Path: "/", HttpOnly: true, Secure: r.TLS != nil, SameSite: http.SameSiteStrictMode, MaxAge: int(passwordTTL / time.Second)})
	jsonReply(w, 200, map[string]bool{"ok": true})
}
