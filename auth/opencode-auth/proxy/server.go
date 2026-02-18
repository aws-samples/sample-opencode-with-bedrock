// Package proxy provides a local HTTP proxy server that adds authentication headers
// to OpenAI API requests, enabling seamless token refresh without restarting opencode.
package proxy

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/aws-samples/sample-opencode-with-bedrock/auth/opencode-auth/auth"
	"github.com/aws-samples/sample-opencode-with-bedrock/auth/opencode-auth/config"
)

// FileLock represents a file-based lock for proxy startup coordination
type FileLock struct {
	path string
	file *os.File
}

// acquireFileLock and releaseFileLock are implemented in lock_unix.go and lock_windows.go

const (
	proxyConfigFile  = "proxy.json"
	defaultPort      = 18080 // Static port for proxy - hardcode in opencode.json
	portCheckTimeout = 2 * time.Second
)

// ProxyConfig stores the proxy runtime configuration
type ProxyConfig struct {
	Port      int       `json:"port"`
	PID       int       `json:"pid"`
	Started   time.Time `json:"started"`
	TargetURL string    `json:"target_url"`
}

// Server represents the local proxy server
type Server struct {
	config    *config.Config
	proxy     *httputil.ReverseProxy
	targetURL *url.URL
	port      int
	server    *http.Server
	refresher *Refresher
	stopChan  chan struct{}
}

// NewServerWithPort creates a new proxy server instance with a specific port
func NewServerWithPort(cfg *config.Config, port int) (*Server, error) {
	return newServerInternal(cfg, port, true)
}

// NewServer creates a new proxy server instance
func NewServer(cfg *config.Config) (*Server, error) {
	return newServerInternal(cfg, defaultPort, true)
}

// newServerInternal is the internal implementation for creating a server
func newServerInternal(cfg *config.Config, port int, checkPort bool) (*Server, error) {
	// Check if port is available (only if checkPort is true)
	if checkPort && !isPortAvailable(port) {
		return nil, fmt.Errorf("port %d is not available - another proxy may be running", port)
	}

	// Parse target URL from config
	// Strip /v1 suffix if present since it's part of the API path
	apiEndpoint := cfg.APIEndpoint
	if strings.HasSuffix(apiEndpoint, "/v1") {
		apiEndpoint = strings.TrimSuffix(apiEndpoint, "/v1")
	}
	targetURL, err := url.Parse(apiEndpoint)
	if err != nil {
		return nil, fmt.Errorf("invalid API endpoint: %w", err)
	}

	server := &Server{
		config:    cfg,
		targetURL: targetURL,
		port:      port,
		stopChan:  make(chan struct{}),
	}

	// Create reverse proxy with timeout configuration
	reverseProxy := httputil.NewSingleHostReverseProxy(targetURL)

	// Set up transport with timeouts
	reverseProxy.Transport = &http.Transport{
		DialContext: (&net.Dialer{
			Timeout:   10 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: 30 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
		IdleConnTimeout:       90 * time.Second,
		MaxIdleConns:          100,
		MaxIdleConnsPerHost:   10,
	}

	// Customize the director to add auth headers
	originalDirector := reverseProxy.Director
	reverseProxy.Director = func(req *http.Request) {
		originalDirector(req)
		server.addAuthHeader(req)
	}
	server.proxy = reverseProxy

	// Create HTTP server
	mux := http.NewServeMux()
	mux.HandleFunc("/", server.handleRequest)
	mux.HandleFunc("/health", server.handleHealth)
	mux.HandleFunc("/api/token", server.handleGetToken)
	mux.HandleFunc("/api/token/status", server.handleTokenStatus)
	mux.HandleFunc("/api/auth/ensure", server.handleEnsure)

	server.server = &http.Server{
		Addr:    fmt.Sprintf("localhost:%d", port),
		Handler: mux,
	}

	return server, nil
}

// Start starts the proxy server and background refresher
func (s *Server) Start() error {
	// Check if already running
	if existing, err := LoadProxyConfig(s.config); err == nil && IsProcessRunning(existing.PID) {
		return fmt.Errorf("proxy already running on port %d (PID %d)", existing.Port, existing.PID)
	}

	// Create and start the token refresher
	refresher, err := NewRefresher(s.config)
	if err != nil {
		return fmt.Errorf("failed to create token refresher: %w", err)
	}
	s.refresher = refresher
	go s.refresher.Start()

	// Save proxy configuration
	proxyConfig := &ProxyConfig{
		Port:      s.port,
		PID:       os.Getpid(),
		Started:   time.Now(),
		TargetURL: s.targetURL.String(),
	}
	if err := SaveProxyConfig(s.config, proxyConfig); err != nil {
		return fmt.Errorf("failed to save proxy config: %w", err)
	}

	// Start the HTTP server in a goroutine
	go func() {
		if err := s.server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			fmt.Fprintf(os.Stderr, "Proxy server error: %v\n", err)
		}
	}()

	return nil
}

// Stop gracefully stops the proxy server
func (s *Server) Stop() error {
	close(s.stopChan)

	// Stop the refresher
	if s.refresher != nil {
		s.refresher.Stop()
	}

	// Remove proxy config
	configPath := filepath.Join(s.config.ConfigDir, proxyConfigFile)
	os.Remove(configPath)

	// Shutdown the HTTP server
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	return s.server.Shutdown(ctx)
}

// Port returns the port the server is listening on
func (s *Server) Port() int {
	return s.port
}

// handleRequest proxies requests to the target API with auth headers
func (s *Server) handleRequest(w http.ResponseWriter, r *http.Request) {
	s.proxy.ServeHTTP(w, r)
}

// handleHealth returns the proxy health status
func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	health := map[string]interface{}{
		"status":    "healthy",
		"port":      s.port,
		"target":    s.targetURL.String(),
		"timestamp": time.Now().UTC(),
	}

	if s.refresher != nil {
		refresherStatus := map[string]interface{}{
			"running":            true,
			"last_refresh":       s.refresher.GetLastRefresh(),
			"retry_count":        s.refresher.GetRetryCount(),
			"needs_reauth":       s.refresher.GetNeedsReauth(),
			"reauth_in_progress": s.refresher.GetReauthInProgress(),
		}

		// Load current token info
		if tokens, err := auth.LoadTokens(s.config.TokenPath); err == nil {
			refresherStatus["token"] = map[string]interface{}{
				"email":       tokens.Email,
				"expires_at":  tokens.ExpiresAt,
				"expires_in":  time.Until(tokens.ExpiresAt).String(),
				"is_expired":  tokens.IsExpired(),
				"is_expiring": tokens.IsExpiringSoon(5 * time.Minute),
			}
		} else {
			refresherStatus["token_error"] = err.Error()
		}

		health["refresher"] = refresherStatus
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(health)
}

// TokenResponse is the response for /api/token endpoint
type TokenAPIResponse struct {
	Token     string    `json:"token,omitempty"`
	ExpiresAt time.Time `json:"expires_at,omitempty"`
	Error     string    `json:"error,omitempty"`
}

// TokenStatusResponse is the response for /api/token/status endpoint
type TokenStatusResponse struct {
	Valid            bool      `json:"valid"`
	ExpiresIn        string    `json:"expires_in,omitempty"`
	Email            string    `json:"email,omitempty"`
	NeedsReauth      bool      `json:"needs_reauth"`
	ReauthInProgress bool      `json:"reauth_in_progress"`
	ExpiresAt        time.Time `json:"expires_at,omitempty"`
}

// EnsureResponse is the response for /api/auth/ensure endpoint
type EnsureResponse struct {
	Status           string `json:"status"` // "ok", "reauth_required", "reauth_in_progress"
	ReauthInProgress bool   `json:"reauth_in_progress,omitempty"`
	Message          string `json:"message,omitempty"`
}

// handleGetToken returns the current valid token for use
func (s *Server) handleGetToken(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	// Check if reauth is needed
	if s.refresher != nil && s.refresher.GetNeedsReauth() {
		w.WriteHeader(http.StatusUnauthorized)
		json.NewEncoder(w).Encode(TokenAPIResponse{
			Error: "reauth_required",
		})
		return
	}

	// Load current token
	tokens, err := auth.LoadTokens(s.config.TokenPath)
	if err != nil {
		w.WriteHeader(http.StatusUnauthorized)
		json.NewEncoder(w).Encode(TokenAPIResponse{
			Error: "no_token",
		})
		return
	}

	// Check if expired
	if tokens.IsExpired() {
		w.WriteHeader(http.StatusUnauthorized)
		json.NewEncoder(w).Encode(TokenAPIResponse{
			Error: "token_expired",
		})
		return
	}

	// Return valid token
	json.NewEncoder(w).Encode(TokenAPIResponse{
		Token:     tokens.IDToken,
		ExpiresAt: tokens.ExpiresAt,
	})
}

// handleTokenStatus returns detailed token health information
func (s *Server) handleTokenStatus(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	response := TokenStatusResponse{
		Valid: false,
	}

	// Get refresher status
	if s.refresher != nil {
		response.NeedsReauth = s.refresher.GetNeedsReauth()
		response.ReauthInProgress = s.refresher.GetReauthInProgress()
	}

	// Load current token
	tokens, err := auth.LoadTokens(s.config.TokenPath)
	if err != nil {
		json.NewEncoder(w).Encode(response)
		return
	}

	// Fill in token info
	response.Email = tokens.Email
	response.ExpiresAt = tokens.ExpiresAt

	if !tokens.IsExpired() && !response.NeedsReauth {
		response.Valid = true
		response.ExpiresIn = time.Until(tokens.ExpiresAt).Round(time.Second).String()
	}

	json.NewEncoder(w).Encode(response)
}

// handleEnsure ensures a valid token exists, triggering refresh or reauth if needed
func (s *Server) handleEnsure(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	// Only allow POST
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		json.NewEncoder(w).Encode(EnsureResponse{
			Status:  "error",
			Message: "method not allowed",
		})
		return
	}

	// Check if reauth is already in progress
	if s.refresher != nil && s.refresher.GetReauthInProgress() {
		json.NewEncoder(w).Encode(EnsureResponse{
			Status:           "reauth_in_progress",
			ReauthInProgress: true,
			Message:          "re-authentication is in progress, please wait",
		})
		return
	}

	// Check if reauth is needed (refresh token expired)
	if s.refresher != nil && s.refresher.GetNeedsReauth() {
		// Check if tokens were refreshed externally (e.g., opencode-auth login)
		if tokens, err := auth.LoadTokens(s.config.TokenPath); err == nil && !tokens.IsExpiringSoon(5*time.Minute) {
			s.refresher.ClearNeedsReauth()
			json.NewEncoder(w).Encode(EnsureResponse{
				Status:  "ok",
				Message: "token refreshed externally",
			})
			return
		}

		// Still needs reauth — trigger it
		go s.refresher.TriggerReauth()
		json.NewEncoder(w).Encode(EnsureResponse{
			Status:           "reauth_required",
			ReauthInProgress: true,
			Message:          "re-authentication required, browser will open",
		})
		return
	}

	// Load current token
	tokens, err := auth.LoadTokens(s.config.TokenPath)
	if err != nil {
		// No token at all - need full auth
		json.NewEncoder(w).Encode(EnsureResponse{
			Status:  "reauth_required",
			Message: "no token found, authentication required",
		})
		return
	}

	// Check if token is expiring soon and force refresh
	if tokens.IsExpiringSoon(5 * time.Minute) {
		if s.refresher != nil {
			fmt.Fprintf(os.Stderr, "[proxy] /api/auth/ensure: Token expiring soon, forcing refresh\n")
			if err := s.refresher.ForceRefresh(); err != nil {
				fmt.Fprintf(os.Stderr, "[proxy] /api/auth/ensure: Force refresh failed: %v\n", err)
				// If refresh failed and needs reauth, handle it
				if s.refresher.GetNeedsReauth() {
					go s.refresher.TriggerReauth()
					json.NewEncoder(w).Encode(EnsureResponse{
						Status:           "reauth_required",
						ReauthInProgress: true,
						Message:          "token refresh failed, re-authentication required",
					})
					return
				}
			}
		}
	}

	// Token is valid (or was just refreshed)
	json.NewEncoder(w).Encode(EnsureResponse{
		Status:  "ok",
		Message: "token is valid",
	})
}

// addAuthHeader reads the current token or API key and adds it to the request
func (s *Server) addAuthHeader(req *http.Request) {
	// Ensure proper host header for the target
	req.Host = s.targetURL.Host

	// API key management paths always use JWT (required by ALB rule)
	isManagementPath := strings.HasPrefix(req.URL.Path, "/v1/api-keys")

	// If an API key is configured and this is NOT a management path, use it
	if s.config.APIKey != "" && !isManagementPath {
		req.Header.Set("X-API-Key", s.config.APIKey)
		if s.config.Debug {
			fmt.Fprintf(os.Stderr, "[proxy] Using API key auth (prefix: %s...)\n", s.config.APIKey[:10])
		}
		return
	}

	// Fall back to JWT auth
	tokens, err := auth.LoadTokens(s.config.TokenPath)
	if err != nil {
		// Log error but don't fail - let the request go through and fail at API level
		// This allows debugging of token issues
		fmt.Fprintf(os.Stderr, "[proxy] Warning: failed to load tokens for auth header: %v\n", err)
		return
	}

	// Log token status for debugging
	timeUntilExpiry := time.Until(tokens.ExpiresAt)
	if timeUntilExpiry < 0 {
		fmt.Fprintf(os.Stderr, "[proxy] WARNING: Using EXPIRED token (expired %v ago)\n", -timeUntilExpiry)
	} else if timeUntilExpiry < 5*time.Minute {
		fmt.Fprintf(os.Stderr, "[proxy] WARNING: Token expiring soon (%v remaining)\n", timeUntilExpiry)
	} else if s.config.Debug {
		fmt.Fprintf(os.Stderr, "[proxy] Token valid, expires in %v\n", timeUntilExpiry)
	}

	// Set the Authorization header
	req.Header.Set("Authorization", "Bearer "+tokens.IDToken)
}

// isPortAvailable checks if a port is available for use
func isPortAvailable(port int) bool {
	addr := fmt.Sprintf("localhost:%d", port)
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		return false
	}
	listener.Close()
	return true
}

// LoadProxyConfig loads the proxy configuration from disk
func LoadProxyConfig(cfg *config.Config) (*ProxyConfig, error) {
	configPath := filepath.Join(cfg.ConfigDir, proxyConfigFile)
	data, err := os.ReadFile(configPath)
	if err != nil {
		return nil, err
	}

	var proxyConfig ProxyConfig
	if err := json.Unmarshal(data, &proxyConfig); err != nil {
		return nil, err
	}

	return &proxyConfig, nil
}

// SaveProxyConfig saves the proxy configuration to disk
func SaveProxyConfig(cfg *config.Config, proxyConfig *ProxyConfig) error {
	configPath := filepath.Join(cfg.ConfigDir, proxyConfigFile)

	// Ensure directory exists
	dir := filepath.Dir(configPath)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return fmt.Errorf("failed to create directory: %w", err)
	}

	data, err := json.MarshalIndent(proxyConfig, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal proxy config: %w", err)
	}

	if err := os.WriteFile(configPath, data, 0600); err != nil {
		return fmt.Errorf("failed to write proxy config: %w", err)
	}

	return nil
}

// IsProcessRunning checks if a process with the given PID is running
func IsProcessRunning(pid int) bool {
	process, err := os.FindProcess(pid)
	if err != nil {
		return false
	}

	// Check if process is running using platform-specific implementation
	return isProcessRunningOS(process)
}

// GetProxyURL returns the proxy URL if a proxy is running
func GetProxyURL(cfg *config.Config) (string, error) {
	proxyConfig, err := LoadProxyConfig(cfg)
	if err != nil {
		return "", err
	}

	// Verify the proxy is actually running
	if !IsProcessRunning(proxyConfig.PID) {
		// Clean up stale config
		configPath := filepath.Join(cfg.ConfigDir, proxyConfigFile)
		os.Remove(configPath)
		return "", fmt.Errorf("proxy not running")
	}

	// Verify it's responsive
	healthURL := fmt.Sprintf("http://localhost:%d/health", proxyConfig.Port)
	client := &http.Client{Timeout: portCheckTimeout}
	resp, err := client.Get(healthURL)
	if err != nil {
		return "", fmt.Errorf("proxy not responsive: %w", err)
	}
	defer resp.Body.Close()

	return fmt.Sprintf("http://localhost:%d", proxyConfig.Port), nil
}

// StartProxy starts the proxy server as a daemon process
func StartProxy(cfg *config.Config) (*ProxyConfig, error) {
	// Acquire startup lock to prevent multiple processes from starting proxy simultaneously
	lockPath := filepath.Join(cfg.ConfigDir, "proxy-startup.lock")
	lock, err := acquireFileLock(lockPath)
	if err != nil {
		return nil, fmt.Errorf("another process is starting proxy: %w", err)
	}
	defer releaseFileLock(lock)

	// Check if already running (after acquiring lock)
	if existing, err := LoadProxyConfig(cfg); err == nil {
		if IsProcessRunning(existing.PID) {
			return existing, nil // Already running
		}
		// Stale config, clean it up
		configPath := filepath.Join(cfg.ConfigDir, proxyConfigFile)
		os.Remove(configPath)
	}

	// Get the current executable path
	binaryPath, err := os.Executable()
	if err != nil {
		return nil, fmt.Errorf("failed to get executable path: %w", err)
	}

	// Start proxy in background by forking
	// We use a special environment variable to indicate we're the child process
	if os.Getenv("OPENCODE_AUTH_PROXY_DAEMON") == "" {
		// Parent process - fork and exit
		cmd := exec.Command(binaryPath, "proxy", "start", "--foreground")
		cmd.Env = append(os.Environ(), "OPENCODE_AUTH_PROXY_DAEMON=1")
		cmd.Stdout = nil
		cmd.Stderr = nil
		cmd.Stdin = nil

		if err := cmd.Start(); err != nil {
			return nil, fmt.Errorf("failed to start proxy daemon: %w", err)
		}

		// Give the daemon time to start and write its config
		time.Sleep(500 * time.Millisecond)

		// Return the config
		return LoadProxyConfig(cfg)
	}

	// Child process - this shouldn't happen as the child calls Start() directly
	// But if it does, just return
	return nil, fmt.Errorf("unexpected state in daemon process")
}

// StopProxy stops the running proxy daemon
func StopProxy(cfg *config.Config) error {
	proxyConfig, err := LoadProxyConfig(cfg)
	if err != nil {
		return fmt.Errorf("no proxy configuration found")
	}

	// Find the process
	process, err := os.FindProcess(proxyConfig.PID)
	if err != nil {
		// Process doesn't exist, clean up config
		configPath := filepath.Join(cfg.ConfigDir, proxyConfigFile)
		os.Remove(configPath)
		return nil
	}

	// Send termination signal using platform-specific implementation
	if err := terminateProcess(process); err != nil {
		// Try Kill as fallback
		process.Kill()
	}

	// Clean up config file
	configPath := filepath.Join(cfg.ConfigDir, proxyConfigFile)
	os.Remove(configPath)

	return nil
}

// StatusProxy returns the status of the proxy daemon
func StatusProxy(cfg *config.Config) (map[string]interface{}, error) {
	proxyConfig, err := LoadProxyConfig(cfg)
	if err != nil {
		return map[string]interface{}{
			"status": "not running",
		}, nil
	}

	running := IsProcessRunning(proxyConfig.PID)
	status := map[string]interface{}{
		"status":  "running",
		"port":    proxyConfig.Port,
		"pid":     proxyConfig.PID,
		"started": proxyConfig.Started,
		"target":  proxyConfig.TargetURL,
	}

	if !running {
		status["status"] = "stopped (stale config)"
		// Clean up stale config
		configPath := filepath.Join(cfg.ConfigDir, proxyConfigFile)
		os.Remove(configPath)
	} else {
		// Check if responsive
		healthURL := fmt.Sprintf("http://localhost:%d/health", proxyConfig.Port)
		client := &http.Client{Timeout: portCheckTimeout}
		resp, err := client.Get(healthURL)
		if err != nil {
			status["health"] = "unresponsive"
		} else {
			status["health"] = "healthy"
			resp.Body.Close()
		}
	}

	return status, nil
}
