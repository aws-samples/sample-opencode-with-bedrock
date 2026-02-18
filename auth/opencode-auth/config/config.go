// Package config provides configuration for the OpenCode credential helper.
package config

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

// Config holds the OIDC configuration for authentication.
type Config struct {
	// OIDC authorize endpoint URL
	AuthorizeEndpoint string
	// OIDC token endpoint URL
	TokenEndpoint string
	// OIDC issuer URL (used for discovery and token validation)
	Issuer string

	// OIDC Client ID
	ClientID string
	// Local callback port
	CallbackPort int
	// Token storage path
	TokenPath string
	// Config directory path
	ConfigDir string
	// API endpoint for proxy target
	APIEndpoint string
	// API key for programmatic access (alternative to JWT)
	APIKey string
	// Debug mode for verbose logging
	Debug bool
}

// Default configuration values
const (
	DefaultCallbackPort = 19876 // High port to avoid conflicts with common dev servers
)

// DefaultConfig returns the default configuration.
func DefaultConfig() *Config {
	return &Config{
		Issuer:            os.Getenv("OPENCODE_ISSUER"),
		AuthorizeEndpoint: os.Getenv("OPENCODE_AUTHORIZE_ENDPOINT"),
		TokenEndpoint:     os.Getenv("OPENCODE_TOKEN_ENDPOINT"),
		ClientID:          os.Getenv("OPENCODE_CLIENT_ID"),
		CallbackPort:      DefaultCallbackPort,
		TokenPath:         defaultTokenPath(),
		ConfigDir:         defaultConfigDir(),
		APIEndpoint:       os.Getenv("OPENAI_BASE_URL"),
		Debug:             os.Getenv("OPENCODE_AUTH_DEBUG") == "1",
	}
}

// defaultConfigDir returns the default configuration directory path.
func defaultConfigDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ".opencode"
	}
	return filepath.Join(home, ".opencode")
}

// defaultTokenPath returns the default token storage path.
func defaultTokenPath() string {
	return filepath.Join(defaultConfigDir(), "tokens.json")
}

// CallbackURL returns the local callback URL.
func (c *Config) CallbackURL() string {
	return fmt.Sprintf("http://localhost:%d/callback", c.CallbackPort)
}

// DiscoverEndpoints uses OIDC Discovery to populate AuthorizeEndpoint and
// TokenEndpoint from the Issuer's .well-known/openid-configuration endpoint.
// It only fetches if AuthorizeEndpoint or TokenEndpoint are not already set.
func (c *Config) DiscoverEndpoints() error {
	if c.Issuer == "" {
		return nil // Nothing to discover from
	}

	if c.AuthorizeEndpoint != "" && c.TokenEndpoint != "" {
		return nil // Already configured
	}

	discoveryURL := c.Issuer + "/.well-known/openid-configuration"

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Get(discoveryURL)
	if err != nil {
		return fmt.Errorf("OIDC discovery failed for %s: %w", discoveryURL, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("OIDC discovery returned status %d: %s", resp.StatusCode, string(body))
	}

	var discovery struct {
		AuthorizationEndpoint string `json:"authorization_endpoint"`
		TokenEndpoint         string `json:"token_endpoint"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&discovery); err != nil {
		return fmt.Errorf("failed to parse OIDC discovery response: %w", err)
	}

	if c.AuthorizeEndpoint == "" {
		if discovery.AuthorizationEndpoint == "" {
			return fmt.Errorf("OIDC discovery response missing authorization_endpoint")
		}
		c.AuthorizeEndpoint = discovery.AuthorizationEndpoint
	}

	if c.TokenEndpoint == "" {
		if discovery.TokenEndpoint == "" {
			return fmt.Errorf("OIDC discovery response missing token_endpoint")
		}
		c.TokenEndpoint = discovery.TokenEndpoint
	}

	return nil
}

// OpenCodeConfig holds configuration loaded from the installer config file.
type OpenCodeConfig struct {
	ClientID          string `json:"client_id"`
	APIEndpoint       string `json:"api_endpoint"`
	AuthorizeEndpoint string `json:"authorize_endpoint,omitempty"`
	TokenEndpoint     string `json:"token_endpoint,omitempty"`
	Issuer            string `json:"issuer,omitempty"`
	APIKey            string `json:"api_key,omitempty"`
}

// SaveOpenCodeConfig writes the config back to ~/.opencode/config.json.
func SaveOpenCodeConfig(cfg *OpenCodeConfig) error {
	configPath := ConfigPath()

	dir := filepath.Dir(configPath)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return fmt.Errorf("failed to create directory: %w", err)
	}

	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal config: %w", err)
	}

	if err := os.WriteFile(configPath, data, 0600); err != nil {
		return fmt.Errorf("failed to write config: %w", err)
	}

	return nil
}

// ConfigPath returns the path to the opencode config file.
func ConfigPath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ".opencode/config.json"
	}
	return filepath.Join(home, ".opencode", "config.json")
}

// LoadOpenCodeConfig loads the installer config from ~/.opencode/config.json.
func LoadOpenCodeConfig() (*OpenCodeConfig, error) {
	configPath := ConfigPath()

	data, err := os.ReadFile(configPath)
	if err != nil {
		return nil, fmt.Errorf("config not found at %s: %w", configPath, err)
	}

	var config OpenCodeConfig
	if err := json.Unmarshal(data, &config); err != nil {
		return nil, fmt.Errorf("failed to parse config: %w", err)
	}

	if config.ClientID == "" {
		return nil, fmt.Errorf("client_id not set in config")
	}

	return &config, nil
}
