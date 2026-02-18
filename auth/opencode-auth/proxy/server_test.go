package proxy

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/aws-samples/sample-opencode-with-bedrock/auth/opencode-auth/auth"
	"github.com/aws-samples/sample-opencode-with-bedrock/auth/opencode-auth/config"
)

func TestIsPortAvailable(t *testing.T) {
	// Use a high port that's likely available
	port := 59999

	// Test with an available port
	if !isPortAvailable(port) {
		t.Skipf("port %d not available for testing, skipping", port)
	}

	// Test with a port that's in use
	listener, err := net.Listen("tcp", fmt.Sprintf("localhost:%d", port))
	if err != nil {
		t.Fatalf("Failed to listen on port %d: %v", port, err)
	}
	defer listener.Close()

	if isPortAvailable(port) {
		t.Errorf("isPortAvailable(%d) = true, want false for occupied port", port)
	}
}

func TestProxyConfigSaveAndLoad(t *testing.T) {
	// Create temporary directory for test
	tempDir := t.TempDir()
	cfg := &config.Config{
		ConfigDir: tempDir,
	}

	// Create a test proxy config
	testConfig := &ProxyConfig{
		Port:      45273,
		PID:       12345,
		Started:   time.Now(),
		TargetURL: "https://api.example.com",
	}

	// Save the config
	err := SaveProxyConfig(cfg, testConfig)
	if err != nil {
		t.Fatalf("SaveProxyConfig() error = %v", err)
	}

	// Load the config
	loadedConfig, err := LoadProxyConfig(cfg)
	if err != nil {
		t.Fatalf("LoadProxyConfig() error = %v", err)
	}

	// Verify loaded config matches
	if loadedConfig.Port != testConfig.Port {
		t.Errorf("LoadProxyConfig() Port = %d, want %d", loadedConfig.Port, testConfig.Port)
	}
	if loadedConfig.PID != testConfig.PID {
		t.Errorf("LoadProxyConfig() PID = %d, want %d", loadedConfig.PID, testConfig.PID)
	}
	if loadedConfig.TargetURL != testConfig.TargetURL {
		t.Errorf("LoadProxyConfig() TargetURL = %s, want %s", loadedConfig.TargetURL, testConfig.TargetURL)
	}
}

func TestLoadProxyConfig_NotFound(t *testing.T) {
	tempDir := t.TempDir()
	cfg := &config.Config{
		ConfigDir: tempDir,
	}

	_, err := LoadProxyConfig(cfg)
	if err == nil {
		t.Error("LoadProxyConfig() expected error for non-existent file, got nil")
	}
}

func TestIsProcessRunning(t *testing.T) {
	// Test with current process (should be running)
	if !IsProcessRunning(os.Getpid()) {
		t.Error("IsProcessRunning(os.Getpid()) = false, want true for current process")
	}

	// Test with a non-existent process (PID 1 is init on Unix, but let's use a very high PID)
	// Using PID 99999 which is extremely unlikely to exist
	if IsProcessRunning(99999) {
		t.Error("IsProcessRunning(99999) = true, want false for non-existent process")
	}
}

func TestServerAddAuthHeader(t *testing.T) {
	// Create temporary directory and token file
	tempDir := t.TempDir()
	tokenPath := filepath.Join(tempDir, "tokens.json")

	// Create test token data
	testTokens := &auth.TokenData{
		IDToken:     "test-id-token-12345",
		AccessToken: "test-access-token",
		ExpiresAt:   time.Now().Add(1 * time.Hour),
		Email:       "test@example.com",
	}

	err := auth.SaveTokens(tokenPath, testTokens)
	if err != nil {
		t.Fatalf("Failed to save test tokens: %v", err)
	}

	// Create server
	cfg := &config.Config{
		ConfigDir: tempDir,
		TokenPath: tokenPath,
	}

	targetURL, _ := url.Parse("https://api.example.com")
	server := &Server{
		config:    cfg,
		targetURL: targetURL,
	}

	// Create test request
	req := httptest.NewRequest("GET", "http://localhost:8080/v1/chat/completions", nil)

	// Add auth header
	server.addAuthHeader(req)

	// Verify Authorization header was added
	authHeader := req.Header.Get("Authorization")
	expectedHeader := "Bearer test-id-token-12345"
	if authHeader != expectedHeader {
		t.Errorf("addAuthHeader() Authorization header = %q, want %q", authHeader, expectedHeader)
	}
}

func TestServerAddAuthHeader_NoTokens(t *testing.T) {
	tempDir := t.TempDir()
	cfg := &config.Config{
		ConfigDir: tempDir,
		TokenPath: filepath.Join(tempDir, "non-existent.json"),
	}

	targetURL, _ := url.Parse("https://api.example.com")
	server := &Server{
		config:    cfg,
		targetURL: targetURL,
	}

	req := httptest.NewRequest("GET", "http://localhost:8080/v1/chat/completions", nil)
	server.addAuthHeader(req)

	// Should not set Authorization header when no tokens
	authHeader := req.Header.Get("Authorization")
	if authHeader != "" {
		t.Errorf("addAuthHeader() Authorization header = %q, want empty when no tokens", authHeader)
	}
}

func TestServerHandleHealth(t *testing.T) {
	cfg := &config.Config{
		APIEndpoint: "https://api.example.com",
	}

	server := &Server{
		config:    cfg,
		port:      45273,
		targetURL: &url.URL{Scheme: "https", Host: "api.example.com"},
	}

	req := httptest.NewRequest("GET", "/health", nil)
	rr := httptest.NewRecorder()

	server.handleHealth(rr, req)

	// Check status code
	if rr.Code != http.StatusOK {
		t.Errorf("handleHealth() status = %d, want %d", rr.Code, http.StatusOK)
	}

	// Check content type
	contentType := rr.Header().Get("Content-Type")
	if contentType != "application/json" {
		t.Errorf("handleHealth() Content-Type = %q, want %q", contentType, "application/json")
	}

	// Parse response
	var response map[string]interface{}
	if err := json.Unmarshal(rr.Body.Bytes(), &response); err != nil {
		t.Fatalf("Failed to parse health response: %v", err)
	}

	// Verify response fields
	if response["status"] != "healthy" {
		t.Errorf("handleHealth() status = %v, want healthy", response["status"])
	}
	if response["port"] != float64(45273) {
		t.Errorf("handleHealth() port = %v, want 45273", response["port"])
	}
}

func TestGetProxyURL_ProxyNotRunning(t *testing.T) {
	tempDir := t.TempDir()
	cfg := &config.Config{
		ConfigDir: tempDir,
	}

	_, err := GetProxyURL(cfg)
	if err == nil {
		t.Error("GetProxyURL() expected error when proxy not running, got nil")
	}
}

func TestNewServer(t *testing.T) {
	tempDir := t.TempDir()
	cfg := &config.Config{
		ConfigDir:   tempDir,
		APIEndpoint: "https://api.example.com",
	}

	// Use a test-specific port to avoid conflicts with running proxy
	testPort := 18081
	server, err := NewServerWithPort(cfg, testPort)
	if err != nil {
		t.Fatalf("NewServerWithPort() error = %v", err)
	}

	if server == nil {
		t.Fatal("NewServerWithPort() returned nil server")
	}

	if server.port != testPort {
		t.Errorf("NewServerWithPort() port = %d, want %d", server.port, testPort)
	}

	if server.config != cfg {
		t.Error("NewServerWithPort() config mismatch")
	}
}

func TestNewServer_InvalidAPIEndpoint(t *testing.T) {
	cfg := &config.Config{
		APIEndpoint: "://invalid-url",
	}

	_, err := NewServer(cfg)
	if err == nil {
		t.Error("NewServer() expected error for invalid API endpoint, got nil")
	}
}

func TestProxyRequestForwarding(t *testing.T) {
	// Create a mock backend server
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Verify auth header was added
		authHeader := r.Header.Get("Authorization")
		if authHeader == "" {
			t.Error("Backend received request without Authorization header")
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]string{
			"status": "ok",
			"path":   r.URL.Path,
		})
	}))
	defer backend.Close()

	// Create temporary directory and token file
	tempDir := t.TempDir()
	tokenPath := filepath.Join(tempDir, "tokens.json")

	testTokens := &auth.TokenData{
		IDToken:     "test-token-12345",
		AccessToken: "test-access",
		ExpiresAt:   time.Now().Add(1 * time.Hour),
		Email:       "test@example.com",
	}
	auth.SaveTokens(tokenPath, testTokens)

	// Create server pointing to mock backend with test-specific port
	cfg := &config.Config{
		ConfigDir:   tempDir,
		TokenPath:   tokenPath,
		APIEndpoint: backend.URL,
	}

	testPort := 18082
	server, err := NewServerWithPort(cfg, testPort)
	if err != nil {
		t.Fatalf("NewServerWithPort() error = %v", err)
	}

	// Start server
	go server.Start()
	time.Sleep(100 * time.Millisecond) // Give server time to start
	defer server.Stop()

	// Make request through proxy
	proxyURL := fmt.Sprintf("http://localhost:%d/v1/chat/completions", testPort)
	resp, err := http.Get(proxyURL)
	if err != nil {
		t.Fatalf("Failed to make request through proxy: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Errorf("Proxy request status = %d, want %d", resp.StatusCode, http.StatusOK)
	}

	body, _ := io.ReadAll(resp.Body)
	var result map[string]string
	json.Unmarshal(body, &result)

	if result["path"] != "/v1/chat/completions" {
		t.Errorf("Proxy request path = %q, want %q", result["path"], "/v1/chat/completions")
	}
}

func TestProxyTimeoutHandling(t *testing.T) {
	// Create a mock backend server that delays response
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Delay longer than the client timeout (2s) but less than response header timeout (30s)
		// This tests that the client timeout is respected
		time.Sleep(3 * time.Second)
		w.WriteHeader(http.StatusOK)
	}))
	defer backend.Close()

	// Create temporary directory and token file
	tempDir := t.TempDir()
	tokenPath := filepath.Join(tempDir, "tokens.json")

	testTokens := &auth.TokenData{
		IDToken:     "test-token-12345",
		AccessToken: "test-access",
		ExpiresAt:   time.Now().Add(1 * time.Hour),
		Email:       "test@example.com",
	}
	auth.SaveTokens(tokenPath, testTokens)

	// Create server pointing to mock backend
	cfg := &config.Config{
		ConfigDir:   tempDir,
		TokenPath:   tokenPath,
		APIEndpoint: backend.URL,
	}

	testPort := 18083
	server, err := NewServerWithPort(cfg, testPort)
	if err != nil {
		t.Fatalf("NewServerWithPort() error = %v", err)
	}

	// Start server
	go server.Start()
	time.Sleep(100 * time.Millisecond)
	defer server.Stop()

	// Make request with a shorter client timeout
	proxyURL := fmt.Sprintf("http://localhost:%d/test", testPort)
	client := &http.Client{Timeout: 2 * time.Second}
	start := time.Now()
	resp, err := client.Get(proxyURL)
	elapsed := time.Since(start)

	// Should timeout quickly (within client timeout), not wait 35 seconds
	if err == nil {
		resp.Body.Close()
		t.Error("Expected timeout error, got nil")
	}

	if elapsed > 5*time.Second {
		t.Errorf("Request took too long to timeout: %v (expected < 5s)", elapsed)
	}

	t.Logf("✓ Request timed out as expected after %v", elapsed)
}

func TestProxyTransportTimeouts(t *testing.T) {
	// Create server to check transport configuration
	tempDir := t.TempDir()
	tokenPath := filepath.Join(tempDir, "tokens.json")

	testTokens := &auth.TokenData{
		IDToken:     "test-token-12345",
		AccessToken: "test-access",
		ExpiresAt:   time.Now().Add(1 * time.Hour),
		Email:       "test@example.com",
	}
	auth.SaveTokens(tokenPath, testTokens)

	cfg := &config.Config{
		ConfigDir:   tempDir,
		TokenPath:   tokenPath,
		APIEndpoint: "https://api.example.com",
	}

	// Use a unique port to avoid conflicts
	testPort := 18084
	server, err := NewServerWithPort(cfg, testPort)
	if err != nil {
		t.Fatalf("NewServerWithPort() error = %v", err)
	}

	// Verify transport is configured
	if server.proxy.Transport == nil {
		t.Error("Expected proxy.Transport to be configured, got nil")
	}

	transport, ok := server.proxy.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("Expected *http.Transport, got %T", server.proxy.Transport)
	}

	// Verify timeout settings
	if transport.TLSHandshakeTimeout != 10*time.Second {
		t.Errorf("TLSHandshakeTimeout = %v, want 10s", transport.TLSHandshakeTimeout)
	}

	if transport.ResponseHeaderTimeout != 30*time.Second {
		t.Errorf("ResponseHeaderTimeout = %v, want 30s", transport.ResponseHeaderTimeout)
	}

	if transport.ExpectContinueTimeout != 1*time.Second {
		t.Errorf("ExpectContinueTimeout = %v, want 1s", transport.ExpectContinueTimeout)
	}

	t.Log("✓ Transport timeouts configured correctly")
}
