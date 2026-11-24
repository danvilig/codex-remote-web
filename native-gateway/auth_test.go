package main

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestLocalPasswordSetupAndRestart(t *testing.T) {
	store := filepath.Join(t.TempDir(), "credential.json")
	a, err := loadLocalAuth(store, "", false)
	if err != nil {
		t.Fatal(err)
	}
	request := func(method, path, body string) *http.Request {
		r := httptest.NewRequest(method, "http://gateway.test"+path, strings.NewReader(body))
		r.Header.Set("Origin", "http://gateway.test")
		return r
	}
	w := httptest.NewRecorder()
	r := request("POST", "/api/auth/setup", `{"password":"temporary-test-password"}`)
	a.http(w, r)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var cookie *http.Cookie
	for _, c := range w.Result().Cookies() {
		if c.Name == passwordCookie {
			cookie = c
		}
	}
	if cookie == nil || !cookie.HttpOnly || cookie.SameSite != http.SameSiteStrictMode {
		t.Fatal("missing restricted session cookie")
	}
	a, err = loadLocalAuth(store, "", false)
	if err != nil {
		t.Fatal(err)
	}
	r = request("GET", "/api/health", "")
	r.AddCookie(cookie)
	if !a.authenticate(r).ok {
		t.Fatal("stored password session did not survive restart")
	}
	r.Header.Set("Origin", "https://foreign.test")
	if auth := a.authenticate(r); auth.ok || auth.status != 403 {
		t.Fatal(auth)
	}
	w = httptest.NewRecorder()
	a.http(w, request("POST", "/api/auth/setup", `{"password":"another-test-password"}`))
	if w.Code != 409 {
		t.Fatal(w.Code)
	}
	w = httptest.NewRecorder()
	a.http(w, request("POST", "/api/auth/login", `{"password":"bad password"}`))
	if w.Code != 401 {
		t.Fatal(w.Code)
	}
	w = httptest.NewRecorder()
	a.http(w, request("POST", "/api/auth/login", `{"password":"temporary-test-password"}`))
	if w.Code != 200 {
		t.Fatal(w.Code)
	}
	// Node's scryptSync uses the same RFC 7914 parameters and raw base64url.
	if key, err := passwordHash("example password", "synthetic-salt-00"); err != nil || key != "zpZXVsMb5jzgF3iwbNRpuOLiMes89VFtDFDiueSvsMI" {
		t.Fatalf("scrypt compatibility %q %v", key, err)
	}
}

func TestGatewayLocalBoundary(t *testing.T) {
	a, _ := loadLocalAuth(filepath.Join(t.TempDir(), "credentials"), "synthetic-secret", true)
	app := &gatewayApp{bridge: new(bridge), local: a, mux: http.NewServeMux()}
	app.registerCore()
	for _, tc := range []struct {
		host, origin, header string
		want                 int
	}{
		{"127.0.0.1:8899", "http://127.0.0.1:8899", "", 200},
		{"foreign.test", "", "", 401},
		{"127.0.0.1:8899", "http://foreign.test", "", 403},
		{"127.0.0.1:8899", "", "X-Forwarded-Host", 401},
		{"127.0.0.1:8899", "", "CF-Connecting-IP", 401},
	} {
		r := httptest.NewRequest("GET", "http://"+tc.host+"/api/health", nil)
		r.RemoteAddr = "127.0.0.1:51300"
		if tc.origin != "" {
			r.Header.Set("Origin", tc.origin)
		}
		if tc.header != "" {
			r.Header.Set(tc.header, "ignored")
		}
		w := httptest.NewRecorder()
		app.ServeHTTP(w, r)
		if w.Code != tc.want {
			t.Errorf("%+v: HTTP %d", tc, w.Code)
		}
	}
}

func TestGatewayWebAssets(t *testing.T) {
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "public"), 0755); err != nil {
		t.Fatal(err)
	}
	write := func(name, contents string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, "public", name), []byte(contents), 0644); err != nil {
			t.Fatal(err)
		}
	}
	write("index.html", `<meta name="app-bundle-revision" content=""><link href="/style.css">`)
	write("style.css", "body{color:black}")
	write("codex-icons.js", "export const fixture = true")
	write("app.bundle.js", "console.log('fixture')")
	root, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	a, _ := loadLocalAuth(filepath.Join(dir, "credentials"), "synthetic-secret", true)
	app := &gatewayApp{bridge: new(bridge), root: root, local: a, mux: http.NewServeMux()}
	app.registerCore()
	get := func(path, etag string, local bool) *httptest.ResponseRecorder {
		t.Helper()
		host := "foreign.test"
		if local {
			host = "127.0.0.1:8899"
		}
		r := httptest.NewRequest(http.MethodGet, "http://"+host+path, nil)
		r.RemoteAddr = "127.0.0.1:51300"
		r.Header.Set("If-None-Match", etag)
		w := httptest.NewRecorder()
		app.ServeHTTP(w, r)
		return w
	}
	html := get("/settings/appearance", "", true)
	css := get("/style.css", "", true)
	bundle := get("/app.bundle.js", "", true)
	etag := css.Header().Get("ETag")
	versioned := "/style.css?v=" + strings.Trim(etag, `"`)
	if html.Code != 200 || html.Header().Get("Cache-Control") != "no-store" || !strings.Contains(html.Body.String(), versioned) || !strings.Contains(html.Body.String(), `content=`+bundle.Header().Get("ETag")) {
		t.Fatalf("missing asset revisions or cache policy: %d %s", html.Code, html.Body.String())
	}
	if cached := get(versioned, "W/"+etag, true); cached.Code != 304 || cached.Body.Len() != 0 || !strings.Contains(cached.Header().Get("Cache-Control"), "immutable") {
		t.Fatalf("conditional stylesheet request: %d %v", cached.Code, cached.Header())
	}
	if denied := get("/app.bundle.js?v="+strings.Trim(bundle.Header().Get("ETag"), `"`), bundle.Header().Get("ETag"), false); denied.Code != 401 || denied.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("unauthorized bundle response: %d %v", denied.Code, denied.Header())
	}
	if icons := get("/codex-icons.js", "", false); icons.Code != 200 || icons.Body.String() != "export const fixture = true" {
		t.Fatalf("missing login icon module: %d %s", icons.Code, icons.Body.String())
	}
	write("style.css", "body{color:blue}")
	if updated := get(versioned, etag, true); updated.Code != 200 || updated.Body.String() != "body{color:blue}" || updated.Header().Get("ETag") == etag || updated.Header().Get("Cache-Control") != "private, no-cache" {
		t.Fatalf("stale version incorrectly reused: %d %v", updated.Code, updated.Header())
	}
}

func TestAccessSignedClaimsAndTransportExpiry(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	const published = "https://public.example.test"
	const issuer = "https://fixture.cloudflareaccess.com"
	const email = "owner@example.test"
	a := &accessAuthenticator{host: "public.example.test", origin: published, issuer: issuer, audience: "fixture-aud", email: email, keys: map[string]*rsa.PublicKey{"fixture": &key.PublicKey}, fetched: time.Now()}
	sign := func(mail, aud string, expires time.Time) string {
		pack := func(v any) string { raw, _ := json.Marshal(v); return base64.RawURLEncoding.EncodeToString(raw) }
		body := pack(map[string]string{"alg": "RS256", "kid": "fixture"}) + "." + pack(map[string]any{"sub": "fixture-owner", "iss": issuer, "aud": []string{aud}, "email": mail, "iat": time.Now().Unix(), "exp": expires.Unix()})
		hash := sha256.Sum256([]byte(body))
		sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, hash[:])
		if err != nil {
			t.Fatal(err)
		}
		return body + "." + base64.RawURLEncoding.EncodeToString(sig)
	}
	now := time.Now()
	for _, x := range []struct {
		mail, aud string
		exp       time.Time
		status    int
		code      string
	}{
		{email, "fixture-aud", now.Add(time.Minute), 0, ""},
		{"other@example.test", "fixture-aud", now.Add(time.Minute), 403, "AUTH_FORBIDDEN"},
		{email, "wrong", now.Add(time.Minute), 401, "AUTH_REQUIRED"},
		{email, "fixture-aud", now.Add(-time.Minute), 401, "AUTH_EXPIRED"},
	} {
		got := a.verify(context.Background(), sign(x.mail, x.aud, x.exp), now)
		if got.status != x.status || got.code != x.code || got.ok != (x.status == 0) {
			t.Fatalf("%+v: %+v", x, got)
		}
	}
	app := &gatewayApp{bridge: new(bridge), access: a, mux: http.NewServeMux()}
	app.registerCore()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { r.Host = a.host; app.ServeHTTP(w, r) }))
	defer server.Close()
	ws, response, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"/ws", http.Header{"Origin": {published}, "Cf-Access-Jwt-Assertion": {sign(email, "fixture-aud", time.Now().Add(2*time.Second))}})
	if err != nil {
		t.Fatal(err, response)
	}
	defer ws.Close()
	_ = ws.SetReadDeadline(time.Now().Add(4 * time.Second))
	var out map[string]string
	if err = ws.ReadJSON(&out); err != nil || out["type"] != "bridge/status" {
		t.Fatal(err, out)
	}
	out = nil
	if err = ws.ReadJSON(&out); err != nil || out["code"] != "AUTH_EXPIRED" {
		t.Fatal(err, out)
	}
}
