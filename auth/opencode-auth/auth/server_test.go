package auth

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/aws-samples/sample-opencode-with-bedrock/auth/opencode-auth/config"
)

// ---------------------------------------------------------------------------
// handleCallback
// ---------------------------------------------------------------------------

func TestHandleCallback_Success(t *testing.T) {
	cfg := &config.Config{CallbackPort: 0}
	cs := &CallbackServer{
		config: cfg,
		result: make(chan CallbackResult, 1),
	}

	req := httptest.NewRequest("GET", "/callback?code=auth-code-123&state=state-abc", nil)
	w := httptest.NewRecorder()

	cs.handleCallback(w, req)

	result := <-cs.result
	if result.Code != "auth-code-123" {
		t.Errorf("Code = %q, want %q", result.Code, "auth-code-123")
	}
	if result.State != "state-abc" {
		t.Errorf("State = %q, want %q", result.State, "state-abc")
	}
	if result.Error != "" {
		t.Errorf("Error should be empty, got %q", result.Error)
	}
	// Should render success page
	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", w.Code)
	}
	if !strings.Contains(w.Body.String(), "Authentication Successful") {
		t.Error("response should contain success message")
	}
}

func TestHandleCallback_Error(t *testing.T) {
	cfg := &config.Config{CallbackPort: 0}
	cs := &CallbackServer{
		config: cfg,
		result: make(chan CallbackResult, 1),
	}

	req := httptest.NewRequest("GET", "/callback?error=access_denied&error_description=User+cancelled", nil)
	w := httptest.NewRecorder()

	cs.handleCallback(w, req)

	result := <-cs.result
	if !strings.Contains(result.Error, "access_denied") {
		t.Errorf("Error should contain 'access_denied', got %q", result.Error)
	}
	if !strings.Contains(result.Error, "User cancelled") {
		t.Errorf("Error should contain description, got %q", result.Error)
	}
	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", w.Code)
	}
}

func TestHandleCallback_MissingCode(t *testing.T) {
	cfg := &config.Config{CallbackPort: 0}
	cs := &CallbackServer{
		config: cfg,
		result: make(chan CallbackResult, 1),
	}

	req := httptest.NewRequest("GET", "/callback?state=abc", nil)
	w := httptest.NewRecorder()

	cs.handleCallback(w, req)

	result := <-cs.result
	if !strings.Contains(result.Error, "no authorization code") {
		t.Errorf("Error should mention missing code, got %q", result.Error)
	}
	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", w.Code)
	}
}

func TestHandleCallback_XSSProtection(t *testing.T) {
	cfg := &config.Config{CallbackPort: 0}
	cs := &CallbackServer{
		config: cfg,
		result: make(chan CallbackResult, 1),
	}

	req := httptest.NewRequest("GET", "/callback?error=<script>alert(1)</script>&error_description=<img+onerror=alert(1)>", nil)
	w := httptest.NewRecorder()

	cs.handleCallback(w, req)

	<-cs.result // drain
	body := w.Body.String()
	if strings.Contains(body, "<script>") {
		t.Error("response should escape script tags (XSS protection)")
	}
	if strings.Contains(body, "<img") {
		t.Error("response should escape img tags (XSS protection)")
	}
}

// ---------------------------------------------------------------------------
// ExchangeCodeForTokens
// ---------------------------------------------------------------------------

func TestExchangeCodeForTokens_Success(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			t.Errorf("method = %s, want POST", r.Method)
		}
		if r.Header.Get("Content-Type") != "application/x-www-form-urlencoded" {
			t.Errorf("Content-Type = %q", r.Header.Get("Content-Type"))
		}

		r.ParseForm()
		if r.Form.Get("grant_type") != "authorization_code" {
			t.Errorf("grant_type = %q", r.Form.Get("grant_type"))
		}
		if r.Form.Get("client_id") != "test-client" {
			t.Errorf("client_id = %q", r.Form.Get("client_id"))
		}
		if r.Form.Get("code") != "auth-code-xyz" {
			t.Errorf("code = %q", r.Form.Get("code"))
		}
		if r.Form.Get("code_verifier") == "" {
			t.Error("code_verifier should not be empty")
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(TokenResponse{
			IDToken:      "id-token-123",
			AccessToken:  "access-token-456",
			RefreshToken: "refresh-token-789",
			ExpiresIn:    3600,
			TokenType:    "Bearer",
		})
	}))
	defer server.Close()

	cfg := &config.Config{
		TokenEndpoint: server.URL,
		ClientID:      "test-client",
		CallbackPort:  19876,
	}
	pkce := &PKCE{Verifier: "test-verifier", Challenge: "test-challenge"}

	resp, err := ExchangeCodeForTokens(cfg, "auth-code-xyz", pkce)
	if err != nil {
		t.Fatalf("ExchangeCodeForTokens failed: %v", err)
	}
	if resp.IDToken != "id-token-123" {
		t.Errorf("IDToken = %q", resp.IDToken)
	}
	if resp.AccessToken != "access-token-456" {
		t.Errorf("AccessToken = %q", resp.AccessToken)
	}
	if resp.RefreshToken != "refresh-token-789" {
		t.Errorf("RefreshToken = %q", resp.RefreshToken)
	}
	if resp.ExpiresIn != 3600 {
		t.Errorf("ExpiresIn = %d", resp.ExpiresIn)
	}
}

func TestExchangeCodeForTokens_RateLimit429(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
		w.Write([]byte("Rate exceeded"))
	}))
	defer server.Close()

	cfg := &config.Config{TokenEndpoint: server.URL, ClientID: "test", CallbackPort: 19876}
	pkce := &PKCE{Verifier: "v", Challenge: "c"}

	_, err := ExchangeCodeForTokens(cfg, "code", pkce)
	if err == nil {
		t.Fatal("should return error on 429")
	}
	if !strings.Contains(err.Error(), "rate limit") {
		t.Errorf("error should mention rate limit, got: %v", err)
	}
}

func TestExchangeCodeForTokens_RateLimitInBody(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte(`{"error": "Rate exceeded"}`))
	}))
	defer server.Close()

	cfg := &config.Config{TokenEndpoint: server.URL, ClientID: "test", CallbackPort: 19876}
	pkce := &PKCE{Verifier: "v", Challenge: "c"}

	_, err := ExchangeCodeForTokens(cfg, "code", pkce)
	if err == nil {
		t.Fatal("should return error on rate limit in body")
	}
	if !strings.Contains(err.Error(), "rate limit") {
		t.Errorf("error should mention rate limit, got: %v", err)
	}
}

func TestExchangeCodeForTokens_ServerError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte("internal error"))
	}))
	defer server.Close()

	cfg := &config.Config{TokenEndpoint: server.URL, ClientID: "test", CallbackPort: 19876}
	pkce := &PKCE{Verifier: "v", Challenge: "c"}

	_, err := ExchangeCodeForTokens(cfg, "code", pkce)
	if err == nil {
		t.Fatal("should return error on 500")
	}
	if !strings.Contains(err.Error(), "500") {
		t.Errorf("error should mention status code, got: %v", err)
	}
}

func TestExchangeCodeForTokens_InvalidJSON(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("not json"))
	}))
	defer server.Close()

	cfg := &config.Config{TokenEndpoint: server.URL, ClientID: "test", CallbackPort: 19876}
	pkce := &PKCE{Verifier: "v", Challenge: "c"}

	_, err := ExchangeCodeForTokens(cfg, "code", pkce)
	if err == nil {
		t.Fatal("should return error on invalid JSON")
	}
}

func TestExchangeCodeForTokens_RedirectURI(t *testing.T) {
	var receivedRedirectURI string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		receivedRedirectURI = r.Form.Get("redirect_uri")
		json.NewEncoder(w).Encode(TokenResponse{IDToken: "tok"})
	}))
	defer server.Close()

	cfg := &config.Config{TokenEndpoint: server.URL, ClientID: "test", CallbackPort: 12345}
	pkce := &PKCE{Verifier: "v", Challenge: "c"}

	ExchangeCodeForTokens(cfg, "code", pkce)

	expected := fmt.Sprintf("http://localhost:%d/callback", 12345)
	if receivedRedirectURI != expected {
		t.Errorf("redirect_uri = %q, want %q", receivedRedirectURI, expected)
	}
}

// ---------------------------------------------------------------------------
// RefreshTokens
// ---------------------------------------------------------------------------

func TestRefreshTokens_Success(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			t.Errorf("method = %s, want POST", r.Method)
		}

		r.ParseForm()
		if r.Form.Get("grant_type") != "refresh_token" {
			t.Errorf("grant_type = %q", r.Form.Get("grant_type"))
		}
		if r.Form.Get("client_id") != "test-client" {
			t.Errorf("client_id = %q", r.Form.Get("client_id"))
		}
		if r.Form.Get("refresh_token") != "my-refresh-token" {
			t.Errorf("refresh_token = %q", r.Form.Get("refresh_token"))
		}

		json.NewEncoder(w).Encode(TokenResponse{
			IDToken:     "new-id-token",
			AccessToken: "new-access-token",
			ExpiresIn:   3600,
		})
	}))
	defer server.Close()

	cfg := &config.Config{
		TokenEndpoint: server.URL,
		ClientID:      "test-client",
	}

	resp, err := RefreshTokens(cfg, "my-refresh-token")
	if err != nil {
		t.Fatalf("RefreshTokens failed: %v", err)
	}
	if resp.IDToken != "new-id-token" {
		t.Errorf("IDToken = %q", resp.IDToken)
	}
	if resp.AccessToken != "new-access-token" {
		t.Errorf("AccessToken = %q", resp.AccessToken)
	}
}

func TestRefreshTokens_RateLimit(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
		w.Write([]byte("too many"))
	}))
	defer server.Close()

	cfg := &config.Config{TokenEndpoint: server.URL, ClientID: "test"}

	_, err := RefreshTokens(cfg, "refresh-tok")
	if err == nil {
		t.Fatal("should return error on 429")
	}
	if !strings.Contains(err.Error(), "rate limit") {
		t.Errorf("error should mention rate limit, got: %v", err)
	}
}

func TestRefreshTokens_ServerError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte("server error"))
	}))
	defer server.Close()

	cfg := &config.Config{TokenEndpoint: server.URL, ClientID: "test"}

	_, err := RefreshTokens(cfg, "refresh-tok")
	if err == nil {
		t.Fatal("should return error on 500")
	}
}

func TestRefreshTokens_InvalidJSON(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("{{invalid"))
	}))
	defer server.Close()

	cfg := &config.Config{TokenEndpoint: server.URL, ClientID: "test"}

	_, err := RefreshTokens(cfg, "refresh-tok")
	if err == nil {
		t.Fatal("should return error for invalid JSON")
	}
}

// ---------------------------------------------------------------------------
// WaitForCallback
// ---------------------------------------------------------------------------

func TestWaitForCallback_Timeout(t *testing.T) {
	cfg := &config.Config{CallbackPort: 0}
	cs := &CallbackServer{
		config: cfg,
		result: make(chan CallbackResult, 1),
	}

	_, err := cs.WaitForCallback(1) // 1 nanosecond timeout
	if err == nil {
		t.Fatal("should return timeout error")
	}
	if !strings.Contains(err.Error(), "timeout") {
		t.Errorf("error should mention timeout, got: %v", err)
	}
}

func TestWaitForCallback_Success(t *testing.T) {
	cs := &CallbackServer{
		result: make(chan CallbackResult, 1),
	}

	// Pre-fill result
	cs.result <- CallbackResult{Code: "test-code", State: "test-state"}

	result, err := cs.WaitForCallback(1e9) // 1 second
	if err != nil {
		t.Fatalf("WaitForCallback failed: %v", err)
	}
	if result.Code != "test-code" {
		t.Errorf("Code = %q", result.Code)
	}

	_ = url.Values{} // use url import
}
