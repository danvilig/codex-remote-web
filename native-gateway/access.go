package main

import (
	"context"
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"
)

type accessAuthenticator struct {
	origin, host, issuer, audience, email string
	local                                 bool
	client                                *http.Client
	mu                                    sync.Mutex
	keys                                  map[string]*rsa.PublicKey
	fetched, attempted                    time.Time
}

var teamDomain = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$`)
var accessEmail = regexp.MustCompile(`^[^\s@]+@[^\s@]+\.[^\s@]+$`)
var settingsPage = regexp.MustCompile(`^/settings(?:/[^/]+)?/?$`)

func exactHTTPSOrigin(value string) (*url.URL, bool) {
	u, err := url.Parse(value)
	return u, err == nil && u.Scheme == "https" && u.Hostname() != "" && u.User == nil && value == "https://"+strings.ToLower(u.Host)
}

func loadAccessAuth(host string) (*accessAuthenticator, error) {
	switch os.Getenv("CODEX_WEBUI_AUTH_MODE") {
	case "", "local":
		return nil, nil
	case "cloudflare-access":
	default:
		return nil, errors.New("Invalid CODEX_WEBUI_AUTH_MODE")
	}
	origin := strings.TrimSpace(os.Getenv("CODEX_WEBUI_PUBLIC_ORIGIN"))
	public, valid := exactHTTPSOrigin(origin)
	team := strings.ToLower(strings.TrimSpace(os.Getenv("CODEX_WEBUI_CF_ACCESS_TEAM_DOMAIN")))
	aud := strings.TrimSpace(os.Getenv("CODEX_WEBUI_CF_ACCESS_AUD"))
	email := strings.ToLower(strings.TrimSpace(os.Getenv("CODEX_WEBUI_CF_ACCESS_ALLOWED_EMAIL")))
	if !loopbackHost(host) || !valid || len(origin) > 1024 || !teamDomain.MatchString(team) || len(team) > 253 || aud == "" || len(aud) > 1024 || len(email) > 1024 || !accessEmail.MatchString(email) {
		return nil, errors.New("Invalid Cloudflare Access configuration")
	}
	return &accessAuthenticator{origin: origin, host: public.Host, issuer: "https://" + team, audience: aud, email: email,
		local:  strings.EqualFold(os.Getenv("CODEX_WEBUI_ALLOW_LOCAL_LOOPBACK"), "true"),
		client: &http.Client{Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}

func remoteOriginAllowed(r *http.Request, host, origin string) bool {
	if !strings.EqualFold(r.Host, host) || !sameOrigin(r, origin) {
		return false
	}
	if r.Header.Get("Sec-Fetch-Site") != "cross-site" {
		return true
	}
	return r.Method == "GET" && r.Header.Get("Upgrade") == "" && r.Header.Get("Sec-Fetch-Mode") == "navigate" &&
		r.Header.Get("Sec-Fetch-Dest") == "document" && (r.URL.Path == "/" || r.URL.Path == "/index.html" || settingsPage.MatchString(r.URL.Path))
}

func (a *accessAuthenticator) authenticate(r *http.Request) authResult {
	if s := r.Header.Get("Sec-Fetch-Site"); a.local && (s == "" || s == "same-origin" || s == "none") && directLoopback(r) && sameOrigin(r, requestOrigin(r)) {
		return authResult{ok: true, origin: requestOrigin(r)}
	}
	if !remoteOriginAllowed(r, a.host, a.origin) {
		return authResult{status: 403, code: "AUTH_FORBIDDEN"}
	}
	return a.verify(r.Context(), r.Header.Get("Cf-Access-Jwt-Assertion"), time.Now())
}

func (a *accessAuthenticator) verify(ctx context.Context, token string, now time.Time) authResult {
	denied := authResult{status: 401, code: "AUTH_REQUIRED"}
	if len(token) > 16384 {
		return denied
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return denied
	}
	var head struct {
		Algorithm string          `json:"alg"`
		Kid       string          `json:"kid"`
		Critical  json.RawMessage `json:"crit"`
	}
	var claims struct {
		Issuer    string          `json:"iss"`
		Audience  json.RawMessage `json:"aud"`
		Subject   string          `json:"sub"`
		Email     string          `json:"email"`
		Issued    *int64          `json:"iat"`
		Expires   *int64          `json:"exp"`
		NotBefore *int64          `json:"nbf"`
	}
	decode := func(segment string, out any) bool {
		raw, err := base64.RawURLEncoding.DecodeString(segment)
		return err == nil && json.Unmarshal(raw, out) == nil
	}
	if !decode(parts[0], &head) || head.Algorithm != "RS256" || head.Kid == "" || len(head.Kid) > 256 || head.Critical != nil ||
		!decode(parts[1], &claims) || claims.Issuer != a.issuer || claims.Issued == nil || claims.Expires == nil || claims.Subject == "" || !audienceContains(claims.Audience, a.audience) {
		return denied
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return denied
	}
	hash := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	key := a.key(ctx, head.Kid, now)
	if key == nil || rsa.VerifyPKCS1v15(key, crypto.SHA256, hash[:], sig) != nil {
		return denied
	}
	if *claims.Expires <= now.Unix() {
		return authResult{status: 401, code: "AUTH_EXPIRED"}
	}
	if claims.NotBefore != nil && *claims.NotBefore > now.Unix() {
		return denied
	}
	if !strings.EqualFold(claims.Email, a.email) || claims.Email == "" {
		return authResult{status: 403, code: "AUTH_FORBIDDEN"}
	}
	return authResult{ok: true, origin: a.origin, email: claims.Email, expires: time.Unix(*claims.Expires, 0)}
}

func audienceContains(raw json.RawMessage, expected string) bool {
	var single string
	if json.Unmarshal(raw, &single) == nil {
		return single == expected
	}
	var list []string
	if json.Unmarshal(raw, &list) != nil {
		return false
	}
	for _, aud := range list {
		if aud == expected {
			return true
		}
	}
	return false
}

func (a *accessAuthenticator) key(ctx context.Context, kid string, now time.Time) *rsa.PublicKey {
	a.mu.Lock()
	defer a.mu.Unlock()
	fresh := now.Sub(a.fetched) < 10*time.Minute
	if fresh && a.keys[kid] != nil {
		return a.keys[kid]
	}
	if now.Sub(a.attempted) < time.Second {
		return nil
	}
	a.attempted = now
	req, err := http.NewRequestWithContext(ctx, "GET", a.issuer+"/cdn-cgi/access/certs", nil)
	if err != nil {
		return nil
	}
	res, err := a.client.Do(req)
	if err != nil {
		return nil
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return nil
	}
	var body struct {
		Keys []struct{ Kty, Kid, Alg, Use, N, E string } `json:"keys"`
	}
	if decodeOne(io.LimitReader(res.Body, 128<<10), &body) != nil {
		return nil
	}
	keys := make(map[string]*rsa.PublicKey)
	for _, entry := range body.Keys {
		if entry.Kty != "RSA" || entry.Kid == "" || (entry.Alg != "" && entry.Alg != "RS256") || (entry.Use != "" && entry.Use != "sig") {
			continue
		}
		n, nerr := base64.RawURLEncoding.DecodeString(entry.N)
		e, eerr := base64.RawURLEncoding.DecodeString(entry.E)
		if nerr != nil || eerr != nil || len(n) < 256 || len(n) > 1024 || len(e) == 0 || len(e) > 4 {
			continue
		}
		modulus, exponent := new(big.Int).SetBytes(n), new(big.Int).SetBytes(e).Int64()
		if modulus.BitLen() < 2048 || exponent < 3 || exponent > 2147483647 || exponent%2 != 1 {
			continue
		}
		if keys[entry.Kid] != nil {
			return nil
		}
		keys[entry.Kid] = &rsa.PublicKey{N: modulus, E: int(exponent)}
	}
	a.keys, a.fetched = keys, now
	return keys[kid]
}
