// Package proxy provides background token refresh functionality for the proxy server.
package proxy

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"runtime"
	"runtime/debug"
	"strings"
	"sync"
	"time"

	"github.com/aws-samples/sample-opencode-with-bedrock/auth/opencode-auth/auth"
	"github.com/aws-samples/sample-opencode-with-bedrock/auth/opencode-auth/config"
)

const (
	// RefreshThreshold is when to refresh tokens (50 minutes before 1-hour expiry)
	defaultRefreshThreshold = 50 * time.Minute

	// CheckInterval is how often to check token expiration
	defaultCheckInterval = 2 * time.Minute

	// MaxRetries is the maximum number of consecutive refresh failures before alerting
	MaxRetries = 5

	// InitialRetryDelay is the starting delay for exponential backoff
	InitialRetryDelay = 30 * time.Second

	// MaxRetryDelay is the maximum delay between retries
	MaxRetryDelay = 5 * time.Minute

	// ReauthTimeout is how long to wait for user to complete browser auth
	ReauthTimeout = 5 * time.Minute
)

// GetRefreshThreshold returns the refresh threshold, allowing override via environment
func GetRefreshThreshold() time.Duration {
	if val := os.Getenv("PROXY_REFRESH_THRESHOLD"); val != "" {
		if d, err := time.ParseDuration(val); err == nil {
			return d
		}
	}
	return defaultRefreshThreshold
}

// GetCheckInterval returns the check interval, allowing override via environment
func GetCheckInterval() time.Duration {
	if val := os.Getenv("PROXY_CHECK_INTERVAL"); val != "" {
		if d, err := time.ParseDuration(val); err == nil {
			return d
		}
	}
	return defaultCheckInterval
}

var (
	RefreshThreshold = GetRefreshThreshold()
	CheckInterval    = GetCheckInterval()
)

// Refresher manages background token refresh
type Refresher struct {
	config           *config.Config
	ticker           *time.Ticker
	stopChan         chan struct{}
	wg               sync.WaitGroup
	retryCount       int
	lastRefresh      time.Time
	needsReauth      bool
	reauthInProgress bool
	mu               sync.RWMutex
	reauthMu         sync.Mutex
	refreshMu        sync.Mutex // guards actual token refresh calls
}

// NewRefresher creates a new token refresher instance
func NewRefresher(cfg *config.Config) (*Refresher, error) {
	return &Refresher{
		config:   cfg,
		stopChan: make(chan struct{}),
	}, nil
}

// Start begins the background token refresh loop
func (r *Refresher) Start() {
	r.wg.Add(1)
	go r.run()
}

// Stop gracefully stops the background refresh loop
func (r *Refresher) Stop() {
	close(r.stopChan)
	r.wg.Wait()
}

// run is the main refresh loop
func (r *Refresher) run() {
	defer r.wg.Done()

	// Recover from panics to prevent goroutine death
	defer func() {
		if rec := recover(); rec != nil {
			fmt.Fprintf(os.Stderr, "\n[proxy] CRITICAL: Refresher panicked: %v\n", rec)
			fmt.Fprintf(os.Stderr, "[proxy] Stack trace:\n%s\n", debug.Stack())
			fmt.Fprintf(os.Stderr, "[proxy] Token refresh is no longer running!\n")
			fmt.Fprintf(os.Stderr, "[proxy] Run 'opencode-auth proxy restart' to restart the proxy.\n\n")
		}
	}()

	// Create ticker for periodic checks
	r.ticker = time.NewTicker(CheckInterval)
	defer r.ticker.Stop()

	fmt.Fprintf(os.Stderr, "[proxy] Refresher started at %s\n", time.Now().Format(time.RFC3339))
	fmt.Fprintf(os.Stderr, "[proxy] Check interval: %v, Refresh threshold: %v\n", CheckInterval, RefreshThreshold)

	// Do an immediate check on startup
	r.checkAndRefresh()

	for {
		select {
		case <-r.ticker.C:
			fmt.Fprintf(os.Stderr, "[proxy] Ticker fired at %s\n", time.Now().Format(time.RFC3339))
			r.checkAndRefresh()
		case <-r.stopChan:
			fmt.Fprintf(os.Stderr, "[proxy] Refresher stopped at %s\n", time.Now().Format(time.RFC3339))
			return
		}
	}
}

// checkAndRefresh checks if token needs refresh and performs the refresh
func (r *Refresher) checkAndRefresh() {
	fmt.Fprintf(os.Stderr, "[proxy] checkAndRefresh() called at %s\n", time.Now().Format(time.RFC3339))

	// Check if we need re-auth and it's not already in progress
	r.mu.RLock()
	needsReauth := r.needsReauth
	reauthInProgress := r.reauthInProgress
	r.mu.RUnlock()

	if needsReauth {
		// Check if tokens were refreshed externally (e.g., opencode-auth login)
		if tokens, err := auth.LoadTokens(r.config.TokenPath); err == nil && !tokens.IsExpiringSoon(5*time.Minute) {
			fmt.Fprintf(os.Stderr, "[proxy] Valid token found on disk (expires %s), clearing needsReauth\n",
				tokens.ExpiresAt.Format(time.RFC3339))
			r.mu.Lock()
			r.needsReauth = false
			r.retryCount = 0
			r.lastRefresh = time.Now()
			r.mu.Unlock()
			return
		}

		if !reauthInProgress {
			fmt.Fprintf(os.Stderr, "[proxy] Re-authentication required, initiating...\n")
			go r.performReauth()
		}
		return
	}

	// Test mode: Force re-auth flow for testing/troubleshooting
	if os.Getenv("OPENCODE_FORCE_REAUTH") == "1" {
		fmt.Fprintf(os.Stderr, "\n[proxy] TEST MODE: OPENCODE_FORCE_REAUTH=1, triggering re-authentication flow\n")
		fmt.Fprintf(os.Stderr, "[proxy] This simulates a 12-hour token expiry for testing purposes\n\n")
		r.handleRefreshError(fmt.Errorf("invalid_grant: refresh token expired (forced by OPENCODE_FORCE_REAUTH)"))
		return
	}

	tokens, err := auth.LoadTokens(r.config.TokenPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[proxy] ERROR: Failed to load tokens: %v\n", err)
		return
	}

	timeUntilExpiry := time.Until(tokens.ExpiresAt)
	fmt.Fprintf(os.Stderr, "[proxy] Token loaded - Email: %s, Expires: %s (in %v)\n",
		tokens.Email, tokens.ExpiresAt.Format(time.RFC3339), timeUntilExpiry)

	// Check if token is already expired
	if tokens.IsExpired() {
		fmt.Fprintf(os.Stderr, "[proxy] WARNING: Token is already EXPIRED (expired %v ago)\n", -timeUntilExpiry)
	}

	// Check if token is expiring soon
	needsRefresh := r.needsRefresh(tokens)
	fmt.Fprintf(os.Stderr, "[proxy] needsRefresh check: IsExpiringSoon(%v)=%v, lastRefresh=%v\n",
		RefreshThreshold, tokens.IsExpiringSoon(RefreshThreshold), r.GetLastRefresh())

	if !needsRefresh {
		fmt.Fprintf(os.Stderr, "[proxy] Token does not need refresh yet (expires in %v)\n", timeUntilExpiry)
		return
	}

	fmt.Fprintf(os.Stderr, "[proxy] Token needs refresh, attempting refresh...\n")

	// Attempt to refresh
	if err := r.refreshToken(tokens); err != nil {
		fmt.Fprintf(os.Stderr, "[proxy] Token refresh failed: %v\n", err)
		r.handleRefreshError(err)
	} else {
		// Success - reset retry count
		r.mu.Lock()
		r.retryCount = 0
		r.lastRefresh = time.Now()
		r.mu.Unlock()

		fmt.Fprintf(os.Stderr, "[proxy] Token refreshed successfully at %s\n", time.Now().Format(time.RFC3339))
	}
}

// needsRefresh determines if the token should be refreshed
func (r *Refresher) needsRefresh(tokens *auth.TokenData) bool {
	// Check if we're within the refresh threshold of expiry
	if tokens.IsExpiringSoon(RefreshThreshold) {
		return true
	}

	// Also refresh if we haven't refreshed in a while (backup check)
	r.mu.RLock()
	lastRefresh := r.lastRefresh
	r.mu.RUnlock()

	if !lastRefresh.IsZero() && time.Since(lastRefresh) > 55*time.Minute {
		return true
	}

	return false
}

// refreshToken performs the actual token refresh
// Uses refreshMu to ensure only one refresh call at a time
func (r *Refresher) refreshToken(tokens *auth.TokenData) error {
	if tokens.RefreshToken == "" {
		return fmt.Errorf("no refresh token available")
	}

	if r.config.ClientID == "" {
		return fmt.Errorf("client ID not configured")
	}

	// Serialize refresh calls to prevent concurrent requests
	r.refreshMu.Lock()
	defer r.refreshMu.Unlock()

	// Re-check if token was already refreshed while we waited for the lock
	freshTokens, err := auth.LoadTokens(r.config.TokenPath)
	if err == nil && !freshTokens.IsExpiringSoon(5*time.Minute) {
		fmt.Fprintf(os.Stderr, "[proxy] Token was already refreshed by another call, skipping\n")
		return nil
	}

	// Perform the refresh
	tokenResp, err := auth.RefreshTokens(r.config, tokens.RefreshToken)
	if err != nil {
		return fmt.Errorf("token refresh failed: %w", err)
	}

	// Extract expiry from new token
	expiresAt, err := auth.GetExpiryFromIDToken(tokenResp.IDToken)
	if err != nil {
		// Fallback to expires_in
		expiresAt = time.Now().Add(time.Duration(tokenResp.ExpiresIn) * time.Second)
	}

	// Create updated token data
	updatedTokens := &auth.TokenData{
		IDToken:      tokenResp.IDToken,
		AccessToken:  tokenResp.AccessToken,
		RefreshToken: tokens.RefreshToken,
		Email:        tokens.Email,
		ExpiresAt:    expiresAt,
	}

	// Update refresh token if a new one was provided
	if tokenResp.RefreshToken != "" {
		updatedTokens.RefreshToken = tokenResp.RefreshToken
	}

	// Save the updated tokens
	if err := auth.SaveTokens(r.config.TokenPath, updatedTokens); err != nil {
		return fmt.Errorf("failed to save refreshed tokens: %w", err)
	}

	return nil
}

// handleRefreshError manages retry logic for failed refreshes
func (r *Refresher) handleRefreshError(err error) {
	// Check if this is a permanent failure (e.g., refresh token expired)
	if isPermanentRefreshError(err) {
		r.mu.Lock()
		r.needsReauth = true
		r.mu.Unlock()

		fmt.Fprintf(os.Stderr, "\n[proxy] WARNING: Token refresh permanently failed\n")
		fmt.Fprintf(os.Stderr, "[proxy] Error: %v\n", err)
		fmt.Fprintf(os.Stderr, "[proxy] Re-authentication will be initiated automatically\n\n")

		// Trigger re-auth immediately
		go r.performReauth()
		return
	}

	r.mu.Lock()
	r.retryCount++
	retryCount := r.retryCount
	r.mu.Unlock()

	// Use much longer backoff for rate limits to avoid making things worse
	var delay time.Duration
	if isRateLimitError(err) {
		// Rate limit: start at 2 minutes, cap at 10 minutes
		delay = 2 * time.Minute * time.Duration(1<<uint(min(retryCount-1, 2)))
		if delay > 10*time.Minute {
			delay = 10 * time.Minute
		}
		fmt.Fprintf(os.Stderr, "[proxy] Rate limited by identity provider (attempt %d/%d), backing off for %v\n", retryCount, MaxRetries, delay)
	} else {
		// Normal transient error: standard backoff
		delay = InitialRetryDelay * time.Duration(1<<uint(retryCount-1))
		if delay > MaxRetryDelay {
			delay = MaxRetryDelay
		}
	}

	if retryCount >= MaxRetries {
		// Alert user after max retries
		fmt.Fprintf(os.Stderr, "\n[proxy] WARNING: Token refresh has failed %d times.\n", MaxRetries)
		fmt.Fprintf(os.Stderr, "[proxy] Last error: %v\n", err)
		fmt.Fprintf(os.Stderr, "[proxy] API calls may fail when token expires.\n")
		fmt.Fprintf(os.Stderr, "[proxy] Run 'opencode-auth login' to re-authenticate.\n\n")
	} else if r.config.Debug {
		fmt.Fprintf(os.Stderr, "[proxy] Token refresh failed (attempt %d/%d): %v\n", retryCount, MaxRetries, err)
		fmt.Fprintf(os.Stderr, "[proxy] Retrying in %v...\n", delay)
	}

	// Schedule a retry sooner than the normal check interval
	go func() {
		select {
		case <-time.After(delay):
			r.checkAndRefresh()
		case <-r.stopChan:
			return
		}
	}()
}

// isPermanentRefreshError determines if refresh failure is unrecoverable
func isPermanentRefreshError(err error) bool {
	if err == nil {
		return false
	}
	errStr := strings.ToLower(err.Error())

	// Refresh token expired or revoked
	if strings.Contains(errStr, "invalid_grant") {
		return true
	}

	// Refresh token not found
	if strings.Contains(errStr, "invalid refresh token") {
		return true
	}

	// User no longer exists
	if strings.Contains(errStr, "user not found") {
		return true
	}

	return false
}

// isRateLimitError checks if the error is a rate limit from the identity provider
func isRateLimitError(err error) bool {
	if err == nil {
		return false
	}
	errStr := strings.ToLower(err.Error())
	return strings.Contains(errStr, "rate limit") ||
		strings.Contains(errStr, "rate exceeded") ||
		strings.Contains(errStr, "too many requests") ||
		strings.Contains(errStr, "status 429")
}

// performReauth initiates full OAuth flow from proxy
func (r *Refresher) performReauth() {
	r.reauthMu.Lock()
	if r.reauthInProgress {
		r.reauthMu.Unlock()
		return // Already authenticating
	}
	r.reauthInProgress = true
	r.reauthMu.Unlock()

	defer func() {
		r.reauthMu.Lock()
		r.reauthInProgress = false
		r.reauthMu.Unlock()
	}()

	fmt.Fprintf(os.Stderr, "\n[proxy] === Re-Authentication Required ===\n")
	fmt.Fprintf(os.Stderr, "[proxy] Your session has expired (12-hour limit)\n")
	fmt.Fprintf(os.Stderr, "[proxy] Opening browser for authentication...\n\n")

	// Generate PKCE
	pkce, err := auth.GeneratePKCE()
	if err != nil {
		fmt.Fprintf(os.Stderr, "[proxy] ERROR: Failed to generate PKCE: %v\n", err)
		return
	}

	// Generate state
	state, err := auth.GenerateState()
	if err != nil {
		fmt.Fprintf(os.Stderr, "[proxy] ERROR: Failed to generate state: %v\n", err)
		return
	}

	// Start callback server
	callbackServer, err := auth.NewCallbackServer(r.config)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[proxy] ERROR: Failed to start callback server: %v\n", err)
		return
	}
	callbackServer.Start()
	defer callbackServer.Shutdown(context.Background())

	// Build auth URL
	authURL := buildAuthURL(r.config, pkce, state)

	// Open browser
	if err := auth.OpenBrowser(authURL); err != nil {
		fmt.Fprintf(os.Stderr, "[proxy] ERROR: Failed to open browser: %v\n", err)
		fmt.Fprintf(os.Stderr, "[proxy] Please open this URL manually:\n%s\n\n", authURL)
	}

	// Send macOS desktop notification so the user notices the re-auth prompt
	if runtime.GOOS == "darwin" {
		exec.Command("osascript", "-e",
			`display notification "Your session has expired. Please complete login in the browser." with title "OpenCode Auth" sound name "default"`).Run()
	}

	// Wait for callback (5 minute timeout)
	fmt.Fprintf(os.Stderr, "[proxy] Waiting for authentication (%v timeout)...\n", ReauthTimeout)
	result, err := callbackServer.WaitForCallback(ReauthTimeout)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[proxy] ERROR: Authentication timed out: %v\n", err)
		return
	}

	if result.Error != "" {
		fmt.Fprintf(os.Stderr, "[proxy] ERROR: Authentication failed: %s\n", result.Error)
		return
	}

	// Exchange code for tokens
	fmt.Fprintf(os.Stderr, "[proxy] Exchanging authorization code for tokens...\n")
	tokenResp, err := auth.ExchangeCodeForTokens(r.config, result.Code, pkce)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[proxy] ERROR: Token exchange failed: %v\n", err)
		return
	}

	// Extract expiry and email
	expiresAt, _ := auth.GetExpiryFromIDToken(tokenResp.IDToken)
	email, _ := auth.ExtractEmailFromIDToken(tokenResp.IDToken)

	// Save tokens
	tokens := &auth.TokenData{
		IDToken:      tokenResp.IDToken,
		AccessToken:  tokenResp.AccessToken,
		RefreshToken: tokenResp.RefreshToken,
		ExpiresAt:    expiresAt,
		Email:        email,
	}

	if err := auth.SaveTokens(r.config.TokenPath, tokens); err != nil {
		fmt.Fprintf(os.Stderr, "[proxy] ERROR: Failed to save tokens: %v\n", err)
		return
	}

	// Update state
	r.mu.Lock()
	r.needsReauth = false
	r.retryCount = 0
	r.lastRefresh = time.Now()
	r.mu.Unlock()

	fmt.Fprintf(os.Stderr, "\n[proxy] === Re-Authentication Successful ===\n")
	fmt.Fprintf(os.Stderr, "[proxy] Email: %s\n", email)
	fmt.Fprintf(os.Stderr, "[proxy] Expires: %s\n", expiresAt.Format(time.RFC822))
	fmt.Fprintf(os.Stderr, "[proxy] You can continue using opencode\n\n")
}

// buildAuthURL builds the OAuth authorization URL
func buildAuthURL(cfg *config.Config, pkce *auth.PKCE, state string) string {
	params := url.Values{
		"response_type":         {"code"},
		"client_id":             {cfg.ClientID},
		"redirect_uri":          {cfg.CallbackURL()},
		"scope":                 {"openid email profile"},
		"state":                 {state},
		"code_challenge":        {pkce.Challenge},
		"code_challenge_method": {"S256"},
	}
	return cfg.AuthorizeEndpoint + "?" + params.Encode()
}

// GetLastRefresh returns the timestamp of the last successful refresh
func (r *Refresher) GetLastRefresh() time.Time {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.lastRefresh
}

// GetRetryCount returns the current retry count
func (r *Refresher) GetRetryCount() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.retryCount
}

// GetNeedsReauth returns whether re-authentication is needed
func (r *Refresher) GetNeedsReauth() bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.needsReauth
}

// GetReauthInProgress returns whether re-authentication is in progress
func (r *Refresher) GetReauthInProgress() bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.reauthInProgress
}

// ForceRefresh immediately attempts to refresh the token
func (r *Refresher) ForceRefresh() error {
	tokens, err := auth.LoadTokens(r.config.TokenPath)
	if err != nil {
		return fmt.Errorf("failed to load tokens: %w", err)
	}

	if err := r.refreshToken(tokens); err != nil {
		return err
	}

	// Reset retry count on success
	r.mu.Lock()
	r.retryCount = 0
	r.lastRefresh = time.Now()
	r.mu.Unlock()

	return nil
}

// TriggerReauth triggers re-authentication flow if not already in progress
func (r *Refresher) TriggerReauth() {
	r.mu.Lock()
	r.needsReauth = true
	r.mu.Unlock()
	r.performReauth()
}

// ClearNeedsReauth clears the re-authentication flag when tokens have been refreshed externally
func (r *Refresher) ClearNeedsReauth() {
	r.mu.Lock()
	r.needsReauth = false
	r.retryCount = 0
	r.lastRefresh = time.Now()
	r.mu.Unlock()
}
