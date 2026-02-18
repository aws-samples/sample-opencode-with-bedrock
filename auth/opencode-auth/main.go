// Package main provides the OpenCode credential helper CLI.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/aws-samples/sample-opencode-with-bedrock/auth/opencode-auth/apikey"
	"github.com/aws-samples/sample-opencode-with-bedrock/auth/opencode-auth/auth"
	"github.com/aws-samples/sample-opencode-with-bedrock/auth/opencode-auth/config"
	"github.com/aws-samples/sample-opencode-with-bedrock/auth/opencode-auth/proxy"
	"github.com/spf13/cobra"
)

var (
	cfg     *config.Config
	version = "dev"
)

func main() {
	cfg = config.DefaultConfig()

	rootCmd := &cobra.Command{
		Use:   "opencode-auth",
		Short: "OpenCode credential helper for OIDC authentication",
		Long: `OpenCode credential helper authenticates with your identity provider via OIDC
and provides tokens for CLI tools like Open Code.

Environment variables:
  OPENCODE_CLIENT_ID            OIDC Client ID (required)
  OPENCODE_ISSUER               OIDC Issuer URL (for auto-discovery)
  OPENCODE_AUTHORIZE_ENDPOINT   OIDC authorization endpoint
  OPENCODE_TOKEN_ENDPOINT       OIDC token endpoint`,
		Version: version,
	}

	// Add flags
	rootCmd.PersistentFlags().StringVar(&cfg.ClientID, "client-id", cfg.ClientID, "OIDC Client ID (or set OPENCODE_CLIENT_ID)")
	rootCmd.PersistentFlags().StringVar(&cfg.Issuer, "issuer", cfg.Issuer, "OIDC Issuer URL (or set OPENCODE_ISSUER)")
	rootCmd.PersistentFlags().StringVar(&cfg.AuthorizeEndpoint, "authorize-endpoint", cfg.AuthorizeEndpoint, "OIDC authorization endpoint")
	rootCmd.PersistentFlags().StringVar(&cfg.TokenEndpoint, "token-endpoint", cfg.TokenEndpoint, "OIDC token endpoint")
	rootCmd.PersistentFlags().IntVar(&cfg.CallbackPort, "port", cfg.CallbackPort, "Local callback port")

	// Add commands
	rootCmd.AddCommand(loginCmd())
	rootCmd.AddCommand(logoutCmd())
	rootCmd.AddCommand(tokenCmd())
	rootCmd.AddCommand(statusCmd())
	rootCmd.AddCommand(runCmd())
	rootCmd.AddCommand(proxyCmd())
	rootCmd.AddCommand(apikeyCmd())

	if err := rootCmd.Execute(); err != nil {
		os.Exit(1)
	}
}

func loginCmd() *cobra.Command {
	var timeout time.Duration
	var noBrowser bool

	cmd := &cobra.Command{
		Use:   "login",
		Short: "Authenticate with your identity provider",
		Long: `Opens a browser window to authenticate with your OIDC identity provider.
After successful authentication, tokens are stored locally for CLI use.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runLogin(timeout, noBrowser)
		},
	}

	cmd.Flags().DurationVar(&timeout, "timeout", 5*time.Minute, "Timeout for authentication")
	cmd.Flags().BoolVar(&noBrowser, "no-browser", false, "Print URL instead of opening browser")

	return cmd
}

func logoutCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "logout",
		Short: "Clear stored tokens",
		Long:  `Removes stored authentication tokens from the local system.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runLogout()
		},
	}
}

func tokenCmd() *cobra.Command {
	var refresh bool

	cmd := &cobra.Command{
		Use:   "token",
		Short: "Output current ID token",
		Long: `Outputs the current ID token to stdout for use with apiKeyHelper.
Exits with code 1 if no valid token is available.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runToken(refresh)
		},
	}

	cmd.Flags().BoolVar(&refresh, "refresh", false, "Attempt to refresh expired token")

	return cmd
}

func statusCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "status",
		Short: "Show authentication status",
		Long:  `Displays the current authentication status including user email and token expiry.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runStatus()
		},
	}
}

// applyOpenCodeConfig applies values from the installer config file to the
// runtime config, without overriding values already set by flags or env vars.
func applyOpenCodeConfig(cfg *config.Config, oc *config.OpenCodeConfig) {
	if cfg.ClientID == "" {
		cfg.ClientID = oc.ClientID
	}
	if cfg.APIEndpoint == "" {
		cfg.APIEndpoint = oc.APIEndpoint
	}
	if cfg.APIKey == "" {
		cfg.APIKey = oc.APIKey
	}
	if cfg.Issuer == "" {
		cfg.Issuer = oc.Issuer
	}
	if cfg.AuthorizeEndpoint == "" {
		cfg.AuthorizeEndpoint = oc.AuthorizeEndpoint
	}
	if cfg.TokenEndpoint == "" {
		cfg.TokenEndpoint = oc.TokenEndpoint
	}
}

func runLogin(timeout time.Duration, noBrowser bool) error {
	// Load config file values if not overridden by flags / env
	if openCodeConfig, err := config.LoadOpenCodeConfig(); err == nil {
		applyOpenCodeConfig(cfg, openCodeConfig)
	}

	if cfg.ClientID == "" {
		return fmt.Errorf("client ID not set. Use --client-id or set OPENCODE_CLIENT_ID environment variable")
	}

	// Auto-discover OIDC endpoints from issuer if needed
	if err := cfg.DiscoverEndpoints(); err != nil {
		return fmt.Errorf("OIDC endpoint discovery failed: %w", err)
	}

	if cfg.AuthorizeEndpoint == "" || cfg.TokenEndpoint == "" {
		return fmt.Errorf("OIDC endpoints not configured. Set --issuer for auto-discovery or provide --authorize-endpoint and --token-endpoint")
	}

	// Generate PKCE verifier and challenge
	pkce, err := auth.GeneratePKCE()
	if err != nil {
		return fmt.Errorf("failed to generate PKCE: %w", err)
	}

	// Generate state for CSRF protection
	state, err := auth.GenerateState()
	if err != nil {
		return fmt.Errorf("failed to generate state: %w", err)
	}

	// Start callback server
	server, err := auth.NewCallbackServer(cfg)
	if err != nil {
		return fmt.Errorf("failed to start callback server: %w", err)
	}
	server.Start()
	defer server.Shutdown(context.Background())

	// Build authorization URL
	authURL := buildAuthURL(pkce, state)

	if noBrowser {
		fmt.Fprintf(os.Stderr, "Open this URL in your browser:\n\n%s\n\n", authURL)
	} else {
		fmt.Fprintf(os.Stderr, "Opening browser for authentication...\n")
		if err := openBrowser(authURL); err != nil {
			fmt.Fprintf(os.Stderr, "Failed to open browser. Please open this URL manually:\n\n%s\n\n", authURL)
		}
	}

	fmt.Fprintf(os.Stderr, "Waiting for authentication callback...\n")

	// Wait for callback
	result, err := server.WaitForCallback(timeout)
	if err != nil {
		return fmt.Errorf("authentication failed: %w", err)
	}

	if result.Error != "" {
		return fmt.Errorf("authentication error: %s", result.Error)
	}

	// Verify state
	if result.State != state {
		return fmt.Errorf("state mismatch: possible CSRF attack")
	}

	fmt.Fprintf(os.Stderr, "Exchanging authorization code for tokens...\n")

	// Exchange code for tokens
	tokenResp, err := auth.ExchangeCodeForTokens(cfg, result.Code, pkce)
	if err != nil {
		return fmt.Errorf("token exchange failed: %w", err)
	}

	// Extract email from ID token
	email, err := auth.ExtractEmailFromIDToken(tokenResp.IDToken)
	if err != nil {
		email = "unknown"
	}

	// Get expiry from ID token
	expiresAt, err := auth.GetExpiryFromIDToken(tokenResp.IDToken)
	if err != nil {
		// Fallback to expires_in
		expiresAt = time.Now().Add(time.Duration(tokenResp.ExpiresIn) * time.Second)
	}

	// Save tokens
	tokens := &auth.TokenData{
		IDToken:      tokenResp.IDToken,
		AccessToken:  tokenResp.AccessToken,
		RefreshToken: tokenResp.RefreshToken,
		ExpiresAt:    expiresAt,
		Email:        email,
	}

	if err := auth.SaveTokens(cfg.TokenPath, tokens); err != nil {
		return fmt.Errorf("failed to save tokens: %w", err)
	}

	fmt.Fprintf(os.Stderr, "\nAuthentication successful!\n")
	fmt.Fprintf(os.Stderr, "  Email: %s\n", email)
	fmt.Fprintf(os.Stderr, "  Expires: %s\n", expiresAt.Local().Format(time.RFC822))
	fmt.Fprintf(os.Stderr, "  Tokens stored at: %s\n", cfg.TokenPath)

	return nil
}

func runLogout() error {
	if err := auth.DeleteTokens(cfg.TokenPath); err != nil {
		return fmt.Errorf("failed to delete tokens: %w", err)
	}
	fmt.Fprintf(os.Stderr, "Logged out successfully. Tokens removed from %s\n", cfg.TokenPath)
	return nil
}

func runToken(refresh bool) error {
	tokens, err := auth.LoadTokens(cfg.TokenPath)
	if err != nil {
		return fmt.Errorf("not authenticated: %w", err)
	}

	// Check if token is expired or expiring soon
	if tokens.IsExpired() || (refresh && tokens.IsExpiringSoon(5*time.Minute)) {
		if !refresh {
			return fmt.Errorf("token expired at %s. Run 'opencode-auth login' to re-authenticate", tokens.ExpiresAt.Local().Format(time.RFC822))
		}

		// Delegate refresh to proxy if running (prevents multiple processes from refreshing)
		proxyURL, err := proxy.GetProxyURL(cfg)
		if err == nil {
			// Proxy is running - ask it to ensure token is valid
			ensureResp, err := callProxyEnsure(proxyURL)
			if err != nil {
				return fmt.Errorf("failed to communicate with proxy: %w", err)
			}

			if ensureResp.Status == "reauth_required" || ensureResp.Status == "reauth_in_progress" {
				return fmt.Errorf("re-authentication required. Run 'opencode-auth login' or 'oc' to re-authenticate")
			}

			// Reload tokens after proxy refresh
			tokens, err = auth.LoadTokens(cfg.TokenPath)
			if err != nil {
				return fmt.Errorf("failed to load tokens after refresh: %w", err)
			}
		} else {
			// No proxy running - return error instead of refreshing directly
			// This prevents multiple token commands from racing to refresh
			return fmt.Errorf("token expired and proxy not running. Run 'oc' to start proxy and refresh token")
		}
	}

	// Output ID token to stdout (for apiKeyHelper)
	fmt.Print(tokens.IDToken)
	return nil
}

func runStatus() error {
	tokens, err := auth.LoadTokens(cfg.TokenPath)
	if err != nil {
		fmt.Println("Status: Not authenticated")
		fmt.Printf("Token path: %s\n", cfg.TokenPath)
		return nil
	}

	status := "Valid"
	if tokens.IsExpired() {
		status = "Expired"
	} else if tokens.IsExpiringSoon(10 * time.Minute) {
		status = "Expiring soon"
	}

	fmt.Printf("Status: %s\n", status)
	fmt.Printf("Email: %s\n", tokens.Email)
	fmt.Printf("Expires: %s\n", tokens.ExpiresAt.Local().Format(time.RFC822))
	fmt.Printf("Token path: %s\n", cfg.TokenPath)

	if !tokens.IsExpired() {
		remaining := time.Until(tokens.ExpiresAt)
		fmt.Printf("Time remaining: %s\n", remaining.Round(time.Second))
	}

	return nil
}

func buildAuthURL(pkce *auth.PKCE, state string) string {
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

func openBrowser(url string) error {
	var cmd *exec.Cmd

	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "linux":
		// Try xdg-open first, then common browsers
		if _, err := exec.LookPath("xdg-open"); err == nil {
			cmd = exec.Command("xdg-open", url)
		} else if _, err := exec.LookPath("sensible-browser"); err == nil {
			cmd = exec.Command("sensible-browser", url)
		} else {
			return fmt.Errorf("no browser command found")
		}
	case "windows":
		cmd = exec.Command("cmd", "/c", "start", url)
	default:
		return fmt.Errorf("unsupported platform: %s", runtime.GOOS)
	}

	return cmd.Start()
}

func runCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "run [flags] [-- args...]",
		Short: "Run opencode with automatic authentication",
		Long: `Authenticates automatically and launches opencode with the proper token.

If not authenticated, opens a browser to login first.
All arguments after -- are passed to opencode.`,
		DisableFlagParsing: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runOpenCode(args)
		},
	}
}

// findRealOpenCode finds the actual opencode binary, skipping wrapper scripts
func findRealOpenCode() (string, error) {
	pathEnv := os.Getenv("PATH")
	paths := filepath.SplitList(pathEnv)

	for _, dir := range paths {
		// Skip the directory containing our wrapper
		if dir == filepath.Dir(os.Args[0]) {
			continue
		}

		opencodePath := filepath.Join(dir, "opencode")
		info, err := os.Stat(opencodePath)
		if err != nil {
			continue
		}

		// Check if it's a regular file (not a symlink or directory)
		if info.Mode().IsRegular() {
			// Check if it's not a shell script (wrapper)
			data := make([]byte, 2)
			file, err := os.Open(opencodePath)
			if err != nil {
				continue
			}
			n, _ := file.Read(data)
			file.Close()

			// If it starts with "#!", it's a script - skip it
			if n >= 2 && string(data) == "#!" {
				continue
			}

			// Found the real binary
			return opencodePath, nil
		}
	}

	return "", fmt.Errorf("real opencode binary not found in PATH")
}

// ProxyHealth represents the health status response from the proxy
type ProxyHealth struct {
	Status    string `json:"status"`
	Port      int    `json:"port"`
	Target    string `json:"target"`
	Timestamp string `json:"timestamp"`
	Refresher *struct {
		Running          bool      `json:"running"`
		LastRefresh      time.Time `json:"last_refresh"`
		RetryCount       int       `json:"retry_count"`
		NeedsReauth      bool      `json:"needs_reauth"`
		ReauthInProgress bool      `json:"reauth_in_progress"`
	} `json:"refresher,omitempty"`
}

// EnsureResponse is the response from /api/auth/ensure endpoint
type EnsureResponse struct {
	Status           string `json:"status"`
	ReauthInProgress bool   `json:"reauth_in_progress,omitempty"`
	Message          string `json:"message,omitempty"`
}

// TokenStatusResponse is the response from /api/token/status endpoint
type TokenStatusResponse struct {
	Valid            bool      `json:"valid"`
	ExpiresIn        string    `json:"expires_in,omitempty"`
	Email            string    `json:"email,omitempty"`
	NeedsReauth      bool      `json:"needs_reauth"`
	ReauthInProgress bool      `json:"reauth_in_progress"`
	ExpiresAt        time.Time `json:"expires_at,omitempty"`
}

// checkProxyHealth queries the proxy health endpoint
func checkProxyHealth(proxyURL string) (*ProxyHealth, error) {
	resp, err := http.Get(proxyURL + "/health")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var health ProxyHealth
	if err := json.NewDecoder(resp.Body).Decode(&health); err != nil {
		return nil, err
	}

	return &health, nil
}

// callProxyEnsure asks the proxy to ensure we have a valid token
func callProxyEnsure(proxyURL string) (*EnsureResponse, error) {
	resp, err := http.Post(proxyURL+"/api/auth/ensure", "application/json", nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var ensureResp EnsureResponse
	if err := json.NewDecoder(resp.Body).Decode(&ensureResp); err != nil {
		return nil, err
	}

	return &ensureResp, nil
}

// waitForReauth polls the proxy until reauth is complete or times out
func waitForReauth(proxyURL string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	pollInterval := 2 * time.Second

	for time.Now().Before(deadline) {
		resp, err := http.Get(proxyURL + "/api/token/status")
		if err != nil {
			time.Sleep(pollInterval)
			continue
		}

		var status TokenStatusResponse
		if err := json.NewDecoder(resp.Body).Decode(&status); err != nil {
			resp.Body.Close()
			time.Sleep(pollInterval)
			continue
		}
		resp.Body.Close()

		// If valid, reauth succeeded
		if status.Valid {
			return nil
		}

		// If not in progress and needs reauth, something went wrong
		if !status.ReauthInProgress && status.NeedsReauth {
			return fmt.Errorf("re-authentication failed")
		}

		time.Sleep(pollInterval)
	}

	return fmt.Errorf("re-authentication timed out after %v", timeout)
}

func runOpenCode(args []string) error {
	// Load installer config (get client ID from file)
	openCodeConfig, err := config.LoadOpenCodeConfig()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		fmt.Fprintf(os.Stderr, "Run the installer first: curl -fsSL https://downloads.oc.example.com/install.sh | bash\n")
		os.Exit(1)
	}

	// Apply config file values
	applyOpenCodeConfig(cfg, openCodeConfig)

	// Auto-discover OIDC endpoints from issuer if needed
	if err := cfg.DiscoverEndpoints(); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: OIDC endpoint discovery failed: %v\n", err)
	}

	// Check if we have valid tokens (not just present — also not expired)
	tokens, err := auth.LoadTokens(cfg.TokenPath)
	needsInitialAuth := err != nil || tokens == nil || tokens.IsExpired()

	if needsInitialAuth {
		reason := "Authentication required"
		if tokens != nil && tokens.IsExpired() {
			reason = "Session expired"
		}
		fmt.Fprintf(os.Stderr, "%s. Opening browser...\n", reason)
		if err := runLogin(5*time.Minute, false); err != nil {
			return fmt.Errorf("authentication failed: %w", err)
		}
	}

	// Ensure proxy is running
	proxyURL, err := proxy.GetProxyURL(cfg)
	if err != nil {
		// Proxy not running, start it
		fmt.Fprintf(os.Stderr, "Starting authentication proxy...\n")
		proxyConfig, err := proxy.StartProxy(cfg)
		if err != nil {
			return fmt.Errorf("failed to start proxy: %w", err)
		}
		proxyURL = fmt.Sprintf("http://localhost:%d", proxyConfig.Port)
		fmt.Fprintf(os.Stderr, "Proxy started\n")
		// Give the proxy a moment to initialize its refresher
		time.Sleep(500 * time.Millisecond)
	} else {
		// Verify proxy config matches current config (catches stale proxy after update)
		if proxyConfig, err := proxy.LoadProxyConfig(cfg); err == nil {
			expectedTarget := strings.TrimSuffix(cfg.APIEndpoint, "/v1")
			if proxyConfig.TargetURL != expectedTarget {
				fmt.Fprintf(os.Stderr, "Proxy target changed (%s → %s), restarting...\n",
					proxyConfig.TargetURL, expectedTarget)
				proxy.StopProxy(cfg)
				time.Sleep(500 * time.Millisecond)
				newConfig, err := proxy.StartProxy(cfg)
				if err != nil {
					return fmt.Errorf("failed to restart proxy: %w", err)
				}
				proxyURL = fmt.Sprintf("http://localhost:%d", newConfig.Port)
				time.Sleep(500 * time.Millisecond)
			}
		}
	}

	// Ask proxy to ensure we have a valid token
	// This delegates ALL token refresh/reauth to the proxy
	ensureResp, err := callProxyEnsure(proxyURL)
	if err != nil {
		return fmt.Errorf("failed to communicate with proxy: %w", err)
	}

	switch ensureResp.Status {
	case "ok":
		// Token is valid, continue
	case "reauth_required", "reauth_in_progress":
		// Proxy is handling reauth, wait for it
		fmt.Fprintf(os.Stderr, "Re-authentication in progress. Please complete login in browser...\n")
		if err := waitForReauth(proxyURL, 5*time.Minute); err != nil {
			return fmt.Errorf("re-authentication failed: %w", err)
		}
		fmt.Fprintf(os.Stderr, "Re-authentication successful\n")
	default:
		return fmt.Errorf("unexpected proxy response: %s", ensureResp.Status)
	}

	// Final safety check: verify tokens are valid before launching opencode
	tokens, err = auth.LoadTokens(cfg.TokenPath)
	if err != nil || tokens == nil || tokens.IsExpired() {
		return fmt.Errorf("tokens are not valid after refresh. Run 'opencode-auth login' manually")
	}
	fmt.Fprintf(os.Stderr, "Authenticated as %s (expires %s)\n", tokens.Email, tokens.ExpiresAt.Local().Format(time.Kitchen))

	// Find the real opencode binary (not a wrapper)
	opencodePath, err := findRealOpenCode()
	if err != nil {
		return fmt.Errorf("opencode not found in PATH. Please install opencode first: %w", err)
	}

	// Execute opencode
	cmd := exec.Command(opencodePath, args...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Env = os.Environ()

	if err := cmd.Run(); err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			os.Exit(exitErr.ExitCode())
		}
		return fmt.Errorf("failed to run opencode: %w", err)
	}

	return nil
}

func apikeyCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "apikey",
		Short: "Manage API keys for programmatic access",
		Long: `Manage API keys that can be used for CI/CD pipelines and automation.

API keys are tied to your OIDC identity and provide long-lived access
without requiring interactive browser login.

Keys are shown in full only once at creation. Store them securely.`,
	}

	cmd.AddCommand(apikeyCreateCmd())
	cmd.AddCommand(apikeyListCmd())
	cmd.AddCommand(apikeyRevokeCmd())

	return cmd
}

func apikeyCreateCmd() *cobra.Command {
	var description string
	var expiresInDays int
	var saveToConfig bool

	cmd := &cobra.Command{
		Use:   "create",
		Short: "Create a new API key",
		Long: `Creates a new API key tied to your OIDC identity.

The full API key is displayed only once. Store it securely — it cannot be
retrieved again.

Use --save to automatically save the key to ~/.opencode/config.json so the
proxy uses API key authentication instead of JWT.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runApikeyCreate(description, expiresInDays, saveToConfig)
		},
	}

	cmd.Flags().StringVarP(&description, "description", "d", "", "Description for the API key (e.g., 'CI pipeline')")
	cmd.Flags().IntVar(&expiresInDays, "expires-in-days", 90, "Number of days until key expires (1-365)")
	cmd.Flags().BoolVar(&saveToConfig, "save", false, "Save the API key to config for proxy to use")

	return cmd
}

func apikeyListCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "list",
		Short: "List your API keys",
		Long:  `Lists all API keys associated with your identity, showing prefix, description, and status.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runApikeyList()
		},
	}
}

func apikeyRevokeCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "revoke <key-prefix>",
		Short: "Revoke an API key",
		Long: `Revokes an API key by its prefix (e.g., oc_AbCdEfG).

Revoked keys stop working within 5 minutes (due to caching).`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runApikeyRevoke(args[0])
		},
	}
}

func loadConfigAndToken() (string, string, error) {
	openCodeConfig, err := config.LoadOpenCodeConfig()
	if err != nil {
		return "", "", fmt.Errorf("failed to load config: %w\nRun the installer first", err)
	}

	applyOpenCodeConfig(cfg, openCodeConfig)

	// API key management goes through the proxy (which adds JWT for us).
	// Check if proxy is running first.
	proxyURL, err := proxy.GetProxyURL(cfg)
	if err != nil {
		return "", "", fmt.Errorf("proxy not running: %w\nStart with 'opencode-auth proxy start' or 'oc'", err)
	}

	// Verify we have a valid JWT (proxy needs it for management endpoints)
	tokens, err := auth.LoadTokens(cfg.TokenPath)
	if err != nil {
		return "", "", fmt.Errorf("not authenticated: %w\nRun 'opencode-auth login' first", err)
	}

	if tokens.IsExpired() {
		return "", "", fmt.Errorf("token expired. Run 'opencode-auth login' to re-authenticate")
	}

	// Use proxy URL — it will add the JWT Authorization header
	return proxyURL, "", nil
}

func runApikeyCreate(description string, expiresInDays int, saveToConfig bool) error {
	endpoint, token, err := loadConfigAndToken()
	if err != nil {
		return err
	}

	client := apikey.NewClient(endpoint, token)
	key, err := client.Create(description, expiresInDays)
	if err != nil {
		return fmt.Errorf("failed to create API key: %w", err)
	}

	fmt.Fprintf(os.Stderr, "\nAPI key created successfully!\n\n")
	fmt.Fprintf(os.Stderr, "  Key:         %s\n", key.Key)
	fmt.Fprintf(os.Stderr, "  Prefix:      %s\n", key.KeyPrefix)
	fmt.Fprintf(os.Stderr, "  Description: %s\n", key.Description)
	fmt.Fprintf(os.Stderr, "  Expires:     %s\n", key.ExpiresAt)
	fmt.Fprintf(os.Stderr, "\n  WARNING: This is the only time the full key will be shown.\n")
	fmt.Fprintf(os.Stderr, "  Store it securely!\n\n")

	if saveToConfig {
		openCodeConfig, err := config.LoadOpenCodeConfig()
		if err != nil {
			fmt.Fprintf(os.Stderr, "  Warning: could not load config to save API key: %v\n", err)
		} else {
			openCodeConfig.APIKey = key.Key
			if err := config.SaveOpenCodeConfig(openCodeConfig); err != nil {
				fmt.Fprintf(os.Stderr, "  Warning: could not save API key to config: %v\n", err)
			} else {
				fmt.Fprintf(os.Stderr, "  API key saved to %s\n", config.ConfigPath())
				fmt.Fprintf(os.Stderr, "  The proxy will use this key for authentication.\n")
				fmt.Fprintf(os.Stderr, "  Restart the proxy to apply: opencode-auth proxy restart\n\n")
			}
		}
	} else {
		fmt.Fprintf(os.Stderr, "  To save to config: opencode-auth apikey create --save -d \"...\"\n")
		fmt.Fprintf(os.Stderr, "  For direct use:    curl -H \"X-API-Key: %s\" https://<api-domain>/v1/chat/completions\n\n", key.Key)
	}

	return nil
}

func runApikeyList() error {
	endpoint, token, err := loadConfigAndToken()
	if err != nil {
		return err
	}

	client := apikey.NewClient(endpoint, token)
	resp, err := client.List()
	if err != nil {
		return fmt.Errorf("failed to list API keys: %w", err)
	}

	if len(resp.Keys) == 0 {
		fmt.Println("No API keys found.")
		fmt.Println("Create one with: opencode-auth apikey create -d \"my key\"")
		return nil
	}

	fmt.Printf("%-12s %-10s %-25s %-25s %-25s %s\n", "PREFIX", "STATUS", "CREATED", "EXPIRES", "LAST USED", "DESCRIPTION")
	fmt.Println("---------- -------- ----------------------- ----------------------- ----------------------- -----------")
	for _, k := range resp.Keys {
		lastUsed := "never"
		if k.LastUsedAt != nil {
			lastUsed = *k.LastUsedAt
		}
		// Truncate ISO timestamps for display
		created := truncateTimestamp(k.CreatedAt)
		expires := truncateTimestamp(k.ExpiresAt)
		if lastUsed != "never" {
			lastUsed = truncateTimestamp(lastUsed)
		}
		fmt.Printf("%-12s %-10s %-25s %-25s %-25s %s\n", k.KeyPrefix, k.Status, created, expires, lastUsed, k.Description)
	}

	return nil
}

func runApikeyRevoke(keyPrefix string) error {
	endpoint, token, err := loadConfigAndToken()
	if err != nil {
		return err
	}

	client := apikey.NewClient(endpoint, token)
	resp, err := client.Revoke(keyPrefix)
	if err != nil {
		return fmt.Errorf("failed to revoke API key: %w", err)
	}

	fmt.Fprintf(os.Stderr, "API key %s revoked successfully.\n", resp.KeyPrefix)
	fmt.Fprintf(os.Stderr, "Note: Cached sessions may take up to 5 minutes to expire.\n")
	return nil
}

func truncateTimestamp(ts string) string {
	t, err := time.Parse(time.RFC3339, ts)
	if err != nil {
		// Try parsing without timezone
		t, err = time.Parse("2006-01-02T15:04:05.999999", ts)
		if err != nil {
			return ts
		}
	}
	return t.Local().Format("2006-01-02 15:04")
}

func proxyCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "proxy",
		Short: "Manage the authentication proxy server",
		Long: `Manage the local authentication proxy server that handles token refresh.

The proxy runs in the background and:
- Intercepts API requests from opencode
- Automatically adds authentication headers
- Refreshes tokens before they expire (every 50 minutes)

This enables seamless long-running sessions without 401 errors.`,
	}

	cmd.AddCommand(proxyStartCmd())
	cmd.AddCommand(proxyStopCmd())
	cmd.AddCommand(proxyRestartCmd())
	cmd.AddCommand(proxyStatusCmd())
	cmd.AddCommand(proxyReauthCmd())

	return cmd
}

func proxyStartCmd() *cobra.Command {
	var foreground bool

	cmd := &cobra.Command{
		Use:   "start",
		Short: "Start the authentication proxy",
		Long: `Starts the local authentication proxy server if not already running.

By default, the proxy runs in the background. Use --foreground to run in the current terminal.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			// Load config
			openCodeConfig, err := config.LoadOpenCodeConfig()
			if err != nil {
				return fmt.Errorf("failed to load config: %w\nRun the installer first: curl -fsSL https://downloads.oc.example.com/install.sh | bash", err)
			}
			applyOpenCodeConfig(cfg, openCodeConfig)
			if err := cfg.DiscoverEndpoints(); err != nil {
				fmt.Fprintf(os.Stderr, "Warning: OIDC endpoint discovery failed: %v\n", err)
			}

			// Check if already running
			if proxyURL, err := proxy.GetProxyURL(cfg); err == nil {
				fmt.Fprintf(os.Stderr, "Proxy already running at %s\n", proxyURL)
				return nil
			}

			if foreground {
				// Run in current process (blocking)
				fmt.Fprintf(os.Stderr, "Starting authentication proxy...\n")
				server, err := proxy.NewServer(cfg)
				if err != nil {
					return fmt.Errorf("failed to create proxy server: %w", err)
				}

				if err := server.Start(); err != nil {
					return fmt.Errorf("failed to start proxy: %w", err)
				}

				fmt.Fprintf(os.Stderr, "Proxy started successfully!\n")
				fmt.Fprintf(os.Stderr, "  Port: %d\n", server.Port())
				fmt.Fprintf(os.Stderr, "  PID: %d\n", os.Getpid())
				fmt.Fprintf(os.Stderr, "  Target: %s\n", cfg.APIEndpoint)
				fmt.Fprintf(os.Stderr, "\nUse 'opencode-auth proxy status' to check status\n")
				fmt.Fprintf(os.Stderr, "Use 'opencode-auth proxy stop' to stop the proxy\n")
				fmt.Fprintf(os.Stderr, "\nRunning in foreground mode. Press Ctrl+C to stop.\n")
				// Block until interrupted
				select {}
			}

			// Background mode - fork a new process
			proxyConfig, err := proxy.StartProxy(cfg)
			if err != nil {
				return fmt.Errorf("failed to start proxy: %w", err)
			}

			fmt.Fprintf(os.Stderr, "Proxy started successfully!\n")
			fmt.Fprintf(os.Stderr, "  Port: %d\n", proxyConfig.Port)
			fmt.Fprintf(os.Stderr, "  PID: %d\n", proxyConfig.PID)
			fmt.Fprintf(os.Stderr, "  Target: %s\n", proxyConfig.TargetURL)
			fmt.Fprintf(os.Stderr, "\nUse 'opencode-auth proxy status' to check status\n")
			fmt.Fprintf(os.Stderr, "Use 'opencode-auth proxy stop' to stop the proxy\n")

			return nil
		},
	}

	cmd.Flags().BoolVar(&foreground, "foreground", false, "Run proxy in foreground (don't detach)")

	return cmd
}

func proxyStopCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "stop",
		Short: "Stop the authentication proxy",
		Long:  `Stops the local authentication proxy server.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := proxy.StopProxy(cfg); err != nil {
				return err
			}
			fmt.Fprintf(os.Stderr, "Proxy stopped successfully\n")
			return nil
		},
	}
}

func proxyRestartCmd() *cobra.Command {
	var foreground bool

	cmd := &cobra.Command{
		Use:   "restart",
		Short: "Restart the authentication proxy",
		Long: `Stops and restarts the local authentication proxy server.

This is useful for applying updates or recovering from issues.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			// Stop if running
			if err := proxy.StopProxy(cfg); err != nil {
				fmt.Fprintf(os.Stderr, "Note: %v\n", err)
			} else {
				fmt.Fprintf(os.Stderr, "Proxy stopped\n")
			}

			// Small delay to ensure port is released
			time.Sleep(500 * time.Millisecond)

			// Load config
			openCodeConfig, err := config.LoadOpenCodeConfig()
			if err != nil {
				return fmt.Errorf("failed to load config: %w\nRun the installer first: curl -fsSL https://downloads.oc.example.com/install.sh | bash", err)
			}
			applyOpenCodeConfig(cfg, openCodeConfig)
			if err := cfg.DiscoverEndpoints(); err != nil {
				fmt.Fprintf(os.Stderr, "Warning: OIDC endpoint discovery failed: %v\n", err)
			}

			if foreground {
				// Run in current process (blocking)
				fmt.Fprintf(os.Stderr, "Starting authentication proxy...\n")
				server, err := proxy.NewServer(cfg)
				if err != nil {
					return fmt.Errorf("failed to create proxy server: %w", err)
				}

				if err := server.Start(); err != nil {
					return fmt.Errorf("failed to start proxy: %w", err)
				}

				fmt.Fprintf(os.Stderr, "Proxy restarted successfully!\n")
				fmt.Fprintf(os.Stderr, "  Port: %d\n", server.Port())
				fmt.Fprintf(os.Stderr, "  PID: %d\n", os.Getpid())
				fmt.Fprintf(os.Stderr, "  Target: %s\n", cfg.APIEndpoint)
				fmt.Fprintf(os.Stderr, "\nRunning in foreground mode. Press Ctrl+C to stop.\n")
				// Block until interrupted
				select {}
			}

			// Background mode - fork a new process
			proxyConfig, err := proxy.StartProxy(cfg)
			if err != nil {
				return fmt.Errorf("failed to start proxy: %w", err)
			}

			fmt.Fprintf(os.Stderr, "Proxy restarted successfully!\n")
			fmt.Fprintf(os.Stderr, "  Port: %d\n", proxyConfig.Port)
			fmt.Fprintf(os.Stderr, "  PID: %d\n", proxyConfig.PID)
			fmt.Fprintf(os.Stderr, "  Target: %s\n", proxyConfig.TargetURL)
			fmt.Fprintf(os.Stderr, "\nUse 'opencode-auth proxy status' to check status\n")

			return nil
		},
	}

	cmd.Flags().BoolVar(&foreground, "foreground", false, "Run proxy in foreground (don't detach)")

	return cmd
}

func proxyStatusCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "status",
		Short: "Show proxy status",
		Long:  `Displays the current status of the authentication proxy server.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			status, err := proxy.StatusProxy(cfg)
			if err != nil {
				return err
			}

			// Pretty print the status
			jsonData, err := json.MarshalIndent(status, "", "  ")
			if err != nil {
				return err
			}
			fmt.Println(string(jsonData))
			return nil
		},
	}
}

func proxyReauthCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "reauth",
		Short: "Force re-authentication",
		Long: `Forces the proxy to re-authenticate immediately.

This is useful if you want to refresh your session proactively or if
automatic re-authentication failed and you want to retry manually.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			// Check if proxy is running
			proxyConfig, err := proxy.LoadProxyConfig(cfg)
			if err != nil {
				return fmt.Errorf("proxy not running: %w", err)
			}

			if !proxy.IsProcessRunning(proxyConfig.PID) {
				return fmt.Errorf("proxy not running")
			}

			fmt.Fprintf(os.Stderr, "Triggering proxy re-authentication...\n")

			// Stop and restart proxy to trigger re-auth
			if err := proxy.StopProxy(cfg); err != nil {
				fmt.Fprintf(os.Stderr, "Warning: failed to stop proxy: %v\n", err)
			}

			time.Sleep(500 * time.Millisecond)

			// Load config before starting
			openCodeConfig, err := config.LoadOpenCodeConfig()
			if err != nil {
				return fmt.Errorf("failed to load config: %w\nRun the installer first: curl -fsSL https://downloads.oc.example.com/install.sh | bash", err)
			}
			applyOpenCodeConfig(cfg, openCodeConfig)
			if err := cfg.DiscoverEndpoints(); err != nil {
				fmt.Fprintf(os.Stderr, "Warning: OIDC endpoint discovery failed: %v\n", err)
			}

			newConfig, err := proxy.StartProxy(cfg)
			if err != nil {
				return fmt.Errorf("failed to restart proxy: %w", err)
			}

			fmt.Fprintf(os.Stderr, "Proxy restarted. PID: %d\n", newConfig.PID)
			fmt.Fprintf(os.Stderr, "The proxy will re-authenticate on next token check.\n")

			return nil
		},
	}
}
