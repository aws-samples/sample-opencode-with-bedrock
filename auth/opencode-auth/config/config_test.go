package config

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ---------------------------------------------------------------------------
// DefaultConfig — env var overrides
// ---------------------------------------------------------------------------

func TestDefaultConfig_EnvVars(t *testing.T) {
	t.Setenv("OPENCODE_ISSUER", "https://cognito.example.com")
	t.Setenv("OPENCODE_AUTHORIZE_ENDPOINT", "https://auth.example.com/authorize")
	t.Setenv("OPENCODE_TOKEN_ENDPOINT", "https://auth.example.com/token")
	t.Setenv("OPENCODE_CLIENT_ID", "test-client-id")
	t.Setenv("OPENAI_BASE_URL", "https://api.example.com")
	t.Setenv("OPENCODE_AUTH_DEBUG", "1")

	cfg := DefaultConfig()

	if cfg.Issuer != "https://cognito.example.com" {
		t.Errorf("Issuer = %q, want %q", cfg.Issuer, "https://cognito.example.com")
	}
	if cfg.AuthorizeEndpoint != "https://auth.example.com/authorize" {
		t.Errorf("AuthorizeEndpoint = %q", cfg.AuthorizeEndpoint)
	}
	if cfg.TokenEndpoint != "https://auth.example.com/token" {
		t.Errorf("TokenEndpoint = %q", cfg.TokenEndpoint)
	}
	if cfg.ClientID != "test-client-id" {
		t.Errorf("ClientID = %q", cfg.ClientID)
	}
	if cfg.APIEndpoint != "https://api.example.com" {
		t.Errorf("APIEndpoint = %q", cfg.APIEndpoint)
	}
	if !cfg.Debug {
		t.Error("Debug should be true when OPENCODE_AUTH_DEBUG=1")
	}
	if cfg.CallbackPort != DefaultCallbackPort {
		t.Errorf("CallbackPort = %d, want %d", cfg.CallbackPort, DefaultCallbackPort)
	}
}

func TestDefaultConfig_EmptyEnvVars(t *testing.T) {
	// Clear all relevant env vars
	t.Setenv("OPENCODE_ISSUER", "")
	t.Setenv("OPENCODE_AUTHORIZE_ENDPOINT", "")
	t.Setenv("OPENCODE_TOKEN_ENDPOINT", "")
	t.Setenv("OPENCODE_CLIENT_ID", "")
	t.Setenv("OPENAI_BASE_URL", "")
	t.Setenv("OPENCODE_AUTH_DEBUG", "")

	cfg := DefaultConfig()

	if cfg.Issuer != "" {
		t.Errorf("Issuer should be empty, got %q", cfg.Issuer)
	}
	if cfg.ClientID != "" {
		t.Errorf("ClientID should be empty, got %q", cfg.ClientID)
	}
	if cfg.Debug {
		t.Error("Debug should be false when OPENCODE_AUTH_DEBUG is empty")
	}
}

// ---------------------------------------------------------------------------
// CallbackURL
// ---------------------------------------------------------------------------

func TestCallbackURL(t *testing.T) {
	tests := []struct {
		name string
		port int
		want string
	}{
		{"default port", 19876, "http://localhost:19876/callback"},
		{"custom port", 8080, "http://localhost:8080/callback"},
		{"port 0", 0, "http://localhost:0/callback"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg := &Config{CallbackPort: tt.port}
			got := cfg.CallbackURL()
			if got != tt.want {
				t.Errorf("CallbackURL() = %q, want %q", got, tt.want)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// DiscoverEndpoints
// ---------------------------------------------------------------------------

func TestDiscoverEndpoints_Success(t *testing.T) {
	discovery := map[string]string{
		"authorization_endpoint": "https://auth.example.com/authorize",
		"token_endpoint":         "https://auth.example.com/token",
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/.well-known/openid-configuration" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(discovery)
	}))
	defer server.Close()

	cfg := &Config{Issuer: server.URL}
	if err := cfg.DiscoverEndpoints(); err != nil {
		t.Fatalf("DiscoverEndpoints failed: %v", err)
	}

	if cfg.AuthorizeEndpoint != "https://auth.example.com/authorize" {
		t.Errorf("AuthorizeEndpoint = %q", cfg.AuthorizeEndpoint)
	}
	if cfg.TokenEndpoint != "https://auth.example.com/token" {
		t.Errorf("TokenEndpoint = %q", cfg.TokenEndpoint)
	}
}

func TestDiscoverEndpoints_NoIssuer(t *testing.T) {
	cfg := &Config{Issuer: ""}
	err := cfg.DiscoverEndpoints()
	if err != nil {
		t.Errorf("DiscoverEndpoints with empty issuer should be no-op, got: %v", err)
	}
}

func TestDiscoverEndpoints_AlreadyConfigured(t *testing.T) {
	cfg := &Config{
		Issuer:            "https://auth.example.com",
		AuthorizeEndpoint: "https://already.set/authorize",
		TokenEndpoint:     "https://already.set/token",
	}
	// Should not make any HTTP calls — if it does, it'll fail since Issuer isn't a real URL
	err := cfg.DiscoverEndpoints()
	if err != nil {
		t.Errorf("DiscoverEndpoints with endpoints already set should be no-op: %v", err)
	}
	if cfg.AuthorizeEndpoint != "https://already.set/authorize" {
		t.Errorf("AuthorizeEndpoint was overwritten: %q", cfg.AuthorizeEndpoint)
	}
}

func TestDiscoverEndpoints_HTTPError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte("server error"))
	}))
	defer server.Close()

	cfg := &Config{Issuer: server.URL}
	err := cfg.DiscoverEndpoints()
	if err == nil {
		t.Error("DiscoverEndpoints should return error on HTTP 500")
	}
}

func TestDiscoverEndpoints_MissingAuthorizationEndpoint(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]string{
			"token_endpoint": "https://auth.example.com/token",
		})
	}))
	defer server.Close()

	cfg := &Config{Issuer: server.URL}
	err := cfg.DiscoverEndpoints()
	if err == nil {
		t.Error("DiscoverEndpoints should return error when authorization_endpoint is missing")
	}
	if !strings.Contains(err.Error(), "authorization_endpoint") {
		t.Errorf("error should mention authorization_endpoint, got: %v", err)
	}
}

func TestDiscoverEndpoints_OnlyFillsMissing(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]string{
			"authorization_endpoint": "https://from-discovery/authorize",
			"token_endpoint":         "https://from-discovery/token",
		})
	}))
	defer server.Close()

	cfg := &Config{
		Issuer:            server.URL,
		AuthorizeEndpoint: "https://pre-set/authorize",
		// TokenEndpoint deliberately left empty
	}
	if err := cfg.DiscoverEndpoints(); err != nil {
		t.Fatalf("DiscoverEndpoints failed: %v", err)
	}
	// Pre-set endpoint should not be overwritten
	if cfg.AuthorizeEndpoint != "https://pre-set/authorize" {
		t.Errorf("AuthorizeEndpoint was overwritten: %q", cfg.AuthorizeEndpoint)
	}
	// Missing endpoint should be filled from discovery
	if cfg.TokenEndpoint != "https://from-discovery/token" {
		t.Errorf("TokenEndpoint = %q, want from discovery", cfg.TokenEndpoint)
	}
}

// ---------------------------------------------------------------------------
// SaveOpenCodeConfig / LoadOpenCodeConfig round-trip
// ---------------------------------------------------------------------------

func TestSaveAndLoadOpenCodeConfig(t *testing.T) {
	tmpDir := t.TempDir()
	t.Setenv("HOME", tmpDir)

	original := &OpenCodeConfig{
		ClientID:    "test-client",
		APIEndpoint: "https://api.example.com",
		Issuer:      "https://issuer.example.com",
	}

	if err := SaveOpenCodeConfig(original); err != nil {
		t.Fatalf("SaveOpenCodeConfig failed: %v", err)
	}

	loaded, err := LoadOpenCodeConfig()
	if err != nil {
		t.Fatalf("LoadOpenCodeConfig failed: %v", err)
	}

	if loaded.ClientID != original.ClientID {
		t.Errorf("ClientID = %q, want %q", loaded.ClientID, original.ClientID)
	}
	if loaded.APIEndpoint != original.APIEndpoint {
		t.Errorf("APIEndpoint = %q, want %q", loaded.APIEndpoint, original.APIEndpoint)
	}
	if loaded.Issuer != original.Issuer {
		t.Errorf("Issuer = %q, want %q", loaded.Issuer, original.Issuer)
	}
}

func TestLoadOpenCodeConfig_FileNotFound(t *testing.T) {
	tmpDir := t.TempDir()
	t.Setenv("HOME", tmpDir)

	_, err := LoadOpenCodeConfig()
	if err == nil {
		t.Error("LoadOpenCodeConfig should return error when file doesn't exist")
	}
}

func TestLoadOpenCodeConfig_InvalidJSON(t *testing.T) {
	tmpDir := t.TempDir()
	t.Setenv("HOME", tmpDir)

	configDir := filepath.Join(tmpDir, ".opencode")
	os.MkdirAll(configDir, 0700)
	os.WriteFile(filepath.Join(configDir, "config.json"), []byte("not json"), 0600)

	_, err := LoadOpenCodeConfig()
	if err == nil {
		t.Error("LoadOpenCodeConfig should return error for invalid JSON")
	}
}

func TestLoadOpenCodeConfig_MissingClientID(t *testing.T) {
	tmpDir := t.TempDir()
	t.Setenv("HOME", tmpDir)

	configDir := filepath.Join(tmpDir, ".opencode")
	os.MkdirAll(configDir, 0700)
	data, _ := json.Marshal(map[string]string{"api_endpoint": "https://api.example.com"})
	os.WriteFile(filepath.Join(configDir, "config.json"), data, 0600)

	_, err := LoadOpenCodeConfig()
	if err == nil {
		t.Error("LoadOpenCodeConfig should return error when client_id is missing")
	}
	if !strings.Contains(err.Error(), "client_id") {
		t.Errorf("error should mention client_id, got: %v", err)
	}
}

// ---------------------------------------------------------------------------
// ConfigPath
// ---------------------------------------------------------------------------

func TestConfigPath(t *testing.T) {
	path := ConfigPath()
	if !strings.HasSuffix(path, filepath.Join(".opencode", "config.json")) {
		t.Errorf("ConfigPath() = %q, should end with .opencode/config.json", path)
	}
}
