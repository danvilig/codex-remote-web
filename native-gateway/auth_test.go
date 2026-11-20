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
