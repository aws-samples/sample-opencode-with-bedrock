// Package auth provides authentication functionality for the OpenCode credential helper.
package auth

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/aws-samples/sample-opencode-with-bedrock/auth/opencode-auth/config"
)

// CallbackResult represents the result of the OAuth callback.
type CallbackResult struct {
	Code  string
	State string
	Error string
}

// CallbackServer handles the OAuth callback from the browser.
type CallbackServer struct {
	config   *config.Config
	server   *http.Server
	listener net.Listener
	result   chan CallbackResult
}

// NewCallbackServer creates a new callback server.
func NewCallbackServer(cfg *config.Config) (*CallbackServer, error) {
	listener, err := net.Listen("tcp", fmt.Sprintf(":%d", cfg.CallbackPort))
	if err != nil {
		return nil, fmt.Errorf("failed to start callback server: %w", err)
	}

	cs := &CallbackServer{
		config:   cfg,
		listener: listener,
		result:   make(chan CallbackResult, 1),
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/callback", cs.handleCallback)

	cs.server = &http.Server{
		Handler:      mux,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 10 * time.Second,
	}

	return cs, nil
}

// Start starts the callback server in a goroutine.
func (cs *CallbackServer) Start() {
	go func() {
		if err := cs.server.Serve(cs.listener); err != http.ErrServerClosed {
			cs.result <- CallbackResult{Error: err.Error()}
		}
	}()
}

// WaitForCallback waits for the OAuth callback with a timeout.
func (cs *CallbackServer) WaitForCallback(timeout time.Duration) (CallbackResult, error) {
	select {
	case result := <-cs.result:
		return result, nil
	case <-time.After(timeout):
		return CallbackResult{}, fmt.Errorf("timeout waiting for callback")
	}
}

// Shutdown gracefully shuts down the callback server.
func (cs *CallbackServer) Shutdown(ctx context.Context) error {
	return cs.server.Shutdown(ctx)
}

// handleCallback handles the OAuth callback request.
func (cs *CallbackServer) handleCallback(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()

	// Check for errors
	if errMsg := query.Get("error"); errMsg != "" {
		errDesc := query.Get("error_description")
		cs.result <- CallbackResult{Error: fmt.Sprintf("%s: %s", errMsg, errDesc)}
		cs.renderError(w, errMsg, errDesc)
		return
	}

	// Extract authorization code
	code := query.Get("code")
	state := query.Get("state")

	if code == "" {
		cs.result <- CallbackResult{Error: "no authorization code received"}
		cs.renderError(w, "No Code", "No authorization code was received")
		return
	}

	cs.result <- CallbackResult{Code: code, State: state}
	cs.renderSuccess(w)
}

// renderSuccess renders a success page to the browser.
func (cs *CallbackServer) renderSuccess(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprint(w, `<!DOCTYPE html>
<html>
<head>
    <title>Authentication Successful</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #0a0a0a;
            color: #e0e0e0;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            margin: 0;
        }
        .container {
            text-align: center;
            padding: 2rem;
        }
        .success {
            color: #4caf50;
            font-size: 4rem;
            margin-bottom: 1rem;
        }
        h1 { margin-bottom: 0.5rem; }
        p { color: #888; }
    </style>
</head>
<body>
    <div class="container">
        <div class="success">✓</div>
        <h1>Authentication Successful</h1>
        <p>You can close this window and return to your terminal.</p>
    </div>
</body>
</html>`)
}

// renderError renders an error page to the browser.
func (cs *CallbackServer) renderError(w http.ResponseWriter, errType, errDesc string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusBadRequest)
	fmt.Fprintf(w, `<!DOCTYPE html>
<html>
<head>
    <title>Authentication Failed</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #0a0a0a;
            color: #e0e0e0;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            margin: 0;
        }
        .container {
            text-align: center;
            padding: 2rem;
        }
        .error {
            color: #f44336;
            font-size: 4rem;
            margin-bottom: 1rem;
        }
        h1 { margin-bottom: 0.5rem; }
        p { color: #888; }
        .details {
            background: #1a1a1a;
            padding: 1rem;
            border-radius: 4px;
            margin-top: 1rem;
            font-family: monospace;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="error">✗</div>
        <h1>Authentication Failed</h1>
        <p>%s</p>
        <div class="details">%s</div>
    </div>
</body>
</html>`, errType, errDesc)
}

// ExchangeCodeForTokens exchanges an authorization code for tokens.
func ExchangeCodeForTokens(cfg *config.Config, code string, pkce *PKCE) (*TokenResponse, error) {
	data := url.Values{
		"grant_type":    {"authorization_code"},
		"client_id":     {cfg.ClientID},
		"code":          {code},
		"redirect_uri":  {cfg.CallbackURL()},
		"code_verifier": {pkce.Verifier},
	}

	req, err := http.NewRequest("POST", cfg.TokenEndpoint, strings.NewReader(data.Encode()))
	if err != nil {
		return nil, fmt.Errorf("failed to create token request: %w", err)
	}

	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("token request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read token response: %w", err)
	}

	if resp.StatusCode == http.StatusTooManyRequests {
		return nil, fmt.Errorf("rate limit exceeded: identity provider is rate limiting requests. Please wait 1-2 minutes and try again")
	}

	if resp.StatusCode != http.StatusOK {
		if strings.Contains(string(body), "Rate exceeded") {
			return nil, fmt.Errorf("rate limit exceeded: identity provider is rate limiting requests. Please wait 1-2 minutes and try again")
		}
		return nil, fmt.Errorf("token request failed with status %d: %s", resp.StatusCode, string(body))
	}

	var tokenResp TokenResponse
	if err := json.Unmarshal(body, &tokenResp); err != nil {
		return nil, fmt.Errorf("failed to parse token response: %w", err)
	}

	return &tokenResp, nil
}

// RefreshTokens uses a refresh token to get new access and ID tokens.
func RefreshTokens(cfg *config.Config, refreshToken string) (*TokenResponse, error) {
	data := url.Values{
		"grant_type":    {"refresh_token"},
		"client_id":     {cfg.ClientID},
		"refresh_token": {refreshToken},
	}

	req, err := http.NewRequest("POST", cfg.TokenEndpoint, strings.NewReader(data.Encode()))
	if err != nil {
		return nil, fmt.Errorf("failed to create refresh request: %w", err)
	}

	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("refresh request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read refresh response: %w", err)
	}

	if resp.StatusCode == http.StatusTooManyRequests {
		return nil, fmt.Errorf("rate limit exceeded: identity provider is rate limiting requests. Please wait 1-2 minutes and try again")
	}

	if resp.StatusCode != http.StatusOK {
		if strings.Contains(string(body), "Rate exceeded") {
			return nil, fmt.Errorf("rate limit exceeded: identity provider is rate limiting requests. Please wait 1-2 minutes and try again")
		}
		return nil, fmt.Errorf("refresh request failed with status %d: %s", resp.StatusCode, string(body))
	}

	var tokenResp TokenResponse
	if err := json.Unmarshal(body, &tokenResp); err != nil {
		return nil, fmt.Errorf("failed to parse refresh response: %w", err)
	}

	return &tokenResp, nil
}
