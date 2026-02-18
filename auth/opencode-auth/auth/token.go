// Package auth provides authentication functionality for the OpenCode credential helper.
package auth

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// TokenData represents the stored OAuth tokens.
type TokenData struct {
	IDToken      string    `json:"id_token"`
	AccessToken  string    `json:"access_token"`
	RefreshToken string    `json:"refresh_token"`
	ExpiresAt    time.Time `json:"expires_at"`
	Email        string    `json:"email"`
}

// TokenResponse represents the response from the token endpoint.
type TokenResponse struct {
	IDToken      string `json:"id_token"`
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int    `json:"expires_in"`
	TokenType    string `json:"token_type"`
}

// LoadTokens loads tokens from the specified file path.
func LoadTokens(path string) (*TokenData, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("failed to read tokens file: %w", err)
	}

	var tokens TokenData
	if err := json.Unmarshal(data, &tokens); err != nil {
		return nil, fmt.Errorf("failed to parse tokens: %w", err)
	}

	return &tokens, nil
}

// FileLock represents a file-based lock
type FileLock struct {
	path string
	file *os.File
}

// acquireFileLock and releaseFileLock are implemented in lock_unix.go and lock_windows.go

// SaveTokens saves tokens to the specified file path with secure permissions.
// Uses file locking and atomic write (write to temp file, then rename) to prevent race conditions.
func SaveTokens(path string, tokens *TokenData) error {
	// Ensure directory exists
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return fmt.Errorf("failed to create directory: %w", err)
	}

	// Acquire file lock
	lockPath := path + ".lock"
	lock, err := acquireFileLock(lockPath)
	if err != nil {
		return fmt.Errorf("failed to acquire token lock: %w", err)
	}
	defer releaseFileLock(lock)

	data, err := json.MarshalIndent(tokens, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal tokens: %w", err)
	}

	// Write to temporary file first (atomic write pattern)
	tmpPath := path + ".tmp"
	if err := os.WriteFile(tmpPath, data, 0600); err != nil {
		return fmt.Errorf("failed to write temp tokens file: %w", err)
	}

	// Atomic rename - ensures readers never see partial writes
	if err := os.Rename(tmpPath, path); err != nil {
		os.Remove(tmpPath) // Clean up temp file
		return fmt.Errorf("failed to rename tokens file: %w", err)
	}

	return nil
}

// DeleteTokens removes the tokens file.
func DeleteTokens(path string) error {
	err := os.Remove(path)
	if os.IsNotExist(err) {
		return nil // Already deleted
	}
	return err
}

// IsExpired checks if the token has expired.
func (t *TokenData) IsExpired() bool {
	// Add a 30-second buffer to account for clock skew
	return time.Now().Add(30 * time.Second).After(t.ExpiresAt)
}

// IsExpiringSoon checks if the token will expire within the given duration.
func (t *TokenData) IsExpiringSoon(within time.Duration) bool {
	return time.Now().Add(within).After(t.ExpiresAt)
}

// ExtractEmailFromIDToken extracts the email claim from an ID token.
func ExtractEmailFromIDToken(idToken string) (string, error) {
	parts := strings.Split(idToken, ".")
	if len(parts) != 3 {
		return "", fmt.Errorf("invalid ID token format")
	}

	// Decode the payload (middle part)
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		// Try with standard base64 with padding
		payload, err = base64.StdEncoding.DecodeString(addPadding(parts[1]))
		if err != nil {
			return "", fmt.Errorf("failed to decode token payload: %w", err)
		}
	}

	var claims map[string]interface{}
	if err := json.Unmarshal(payload, &claims); err != nil {
		return "", fmt.Errorf("failed to parse token claims: %w", err)
	}

	email, ok := claims["email"].(string)
	if !ok {
		return "", fmt.Errorf("email claim not found in token")
	}

	return email, nil
}

// GetExpiryFromIDToken extracts the expiry time from an ID token.
func GetExpiryFromIDToken(idToken string) (time.Time, error) {
	parts := strings.Split(idToken, ".")
	if len(parts) != 3 {
		return time.Time{}, fmt.Errorf("invalid ID token format")
	}

	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		payload, err = base64.StdEncoding.DecodeString(addPadding(parts[1]))
		if err != nil {
			return time.Time{}, fmt.Errorf("failed to decode token payload: %w", err)
		}
	}

	var claims map[string]interface{}
	if err := json.Unmarshal(payload, &claims); err != nil {
		return time.Time{}, fmt.Errorf("failed to parse token claims: %w", err)
	}

	exp, ok := claims["exp"].(float64)
	if !ok {
		return time.Time{}, fmt.Errorf("exp claim not found in token")
	}

	return time.Unix(int64(exp), 0), nil
}

// addPadding adds base64 padding to a string if needed.
func addPadding(s string) string {
	switch len(s) % 4 {
	case 2:
		return s + "=="
	case 3:
		return s + "="
	}
	return s
}
