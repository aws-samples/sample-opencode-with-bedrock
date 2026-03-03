package auth

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// makeJWT creates a minimal JWT string with the given claims for testing.
func makeJWT(t *testing.T, claims map[string]interface{}) string {
	t.Helper()
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none","typ":"JWT"}`))
	payload, err := json.Marshal(claims)
	if err != nil {
		t.Fatalf("failed to marshal claims: %v", err)
	}
	payloadB64 := base64.RawURLEncoding.EncodeToString(payload)
	return header + "." + payloadB64 + ".signature"
}

// ---------------------------------------------------------------------------
// SaveTokens / LoadTokens round-trip
// ---------------------------------------------------------------------------

func TestSaveAndLoadTokens(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "tokens.json")

	original := &TokenData{
		IDToken:      "id-tok-123",
		AccessToken:  "access-tok-456",
		RefreshToken: "refresh-tok-789",
		ExpiresAt:    time.Now().Add(1 * time.Hour).Truncate(time.Second),
		Email:        "user@example.com",
	}

	if err := SaveTokens(path, original); err != nil {
		t.Fatalf("SaveTokens failed: %v", err)
	}

	loaded, err := LoadTokens(path)
	if err != nil {
		t.Fatalf("LoadTokens failed: %v", err)
	}

	if loaded.IDToken != original.IDToken {
		t.Errorf("IDToken = %q, want %q", loaded.IDToken, original.IDToken)
	}
	if loaded.AccessToken != original.AccessToken {
		t.Errorf("AccessToken = %q, want %q", loaded.AccessToken, original.AccessToken)
	}
	if loaded.RefreshToken != original.RefreshToken {
		t.Errorf("RefreshToken = %q, want %q", loaded.RefreshToken, original.RefreshToken)
	}
	if loaded.Email != original.Email {
		t.Errorf("Email = %q, want %q", loaded.Email, original.Email)
	}
	// Compare truncated to second to avoid sub-second JSON precision issues
	if !loaded.ExpiresAt.Truncate(time.Second).Equal(original.ExpiresAt) {
		t.Errorf("ExpiresAt = %v, want %v", loaded.ExpiresAt, original.ExpiresAt)
	}
}

func TestSaveTokens_CreatesDirectory(t *testing.T) {
	dir := t.TempDir()
	nested := filepath.Join(dir, "sub", "deep", "tokens.json")

	tokens := &TokenData{IDToken: "tok"}
	if err := SaveTokens(nested, tokens); err != nil {
		t.Fatalf("SaveTokens should create nested dirs: %v", err)
	}

	if _, err := os.Stat(nested); os.IsNotExist(err) {
		t.Error("SaveTokens did not create the file at nested path")
	}
}

func TestLoadTokens_FileNotFound(t *testing.T) {
	_, err := LoadTokens("/nonexistent/path/tokens.json")
	if err == nil {
		t.Error("LoadTokens should return error for missing file")
	}
}

func TestLoadTokens_InvalidJSON(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "tokens.json")
	if err := os.WriteFile(path, []byte("not json"), 0600); err != nil {
		t.Fatal(err)
	}

	_, err := LoadTokens(path)
	if err == nil {
		t.Error("LoadTokens should return error for invalid JSON")
	}
}

func TestLoadTokens_EmptyFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "tokens.json")
	if err := os.WriteFile(path, []byte(""), 0600); err != nil {
		t.Fatal(err)
	}

	_, err := LoadTokens(path)
	if err == nil {
		t.Error("LoadTokens should return error for empty file")
	}
}

// ---------------------------------------------------------------------------
// DeleteTokens
// ---------------------------------------------------------------------------

func TestDeleteTokens(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "tokens.json")

	if err := os.WriteFile(path, []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}

	if err := DeleteTokens(path); err != nil {
		t.Errorf("DeleteTokens should succeed: %v", err)
	}

	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Error("DeleteTokens should remove the file")
	}
}

func TestDeleteTokens_NonExistent(t *testing.T) {
	err := DeleteTokens("/nonexistent/tokens.json")
	if err != nil {
		t.Errorf("DeleteTokens of non-existent file should return nil: %v", err)
	}
}

// ---------------------------------------------------------------------------
// IsExpired / IsExpiringSoon
// ---------------------------------------------------------------------------

func TestIsExpired(t *testing.T) {
	tests := []struct {
		name      string
		expiresAt time.Time
		want      bool
	}{
		{"expired 1h ago", time.Now().Add(-1 * time.Hour), true},
		{"expires in 10s (within 30s buffer)", time.Now().Add(10 * time.Second), true},
		{"expires in 5min", time.Now().Add(5 * time.Minute), false},
		{"expires in 1h", time.Now().Add(1 * time.Hour), false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			td := &TokenData{ExpiresAt: tt.expiresAt}
			got := td.IsExpired()
			if got != tt.want {
				t.Errorf("IsExpired() = %v, want %v (expiresAt: %v, now: %v)",
					got, tt.want, tt.expiresAt, time.Now())
			}
		})
	}
}

func TestIsExpiringSoon(t *testing.T) {
	tests := []struct {
		name      string
		expiresAt time.Time
		within    time.Duration
		want      bool
	}{
		{"expires in 5min, check 10min window", time.Now().Add(5 * time.Minute), 10 * time.Minute, true},
		{"expires in 30min, check 10min window", time.Now().Add(30 * time.Minute), 10 * time.Minute, false},
		{"expires in 45min, check 50min window", time.Now().Add(45 * time.Minute), 50 * time.Minute, true},
		{"already expired, check any window", time.Now().Add(-1 * time.Minute), 1 * time.Second, true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			td := &TokenData{ExpiresAt: tt.expiresAt}
			got := td.IsExpiringSoon(tt.within)
			if got != tt.want {
				t.Errorf("IsExpiringSoon(%v) = %v, want %v", tt.within, got, tt.want)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// ExtractEmailFromIDToken
// ---------------------------------------------------------------------------

func TestExtractEmailFromIDToken(t *testing.T) {
	token := makeJWT(t, map[string]interface{}{
		"sub":   "user-123",
		"email": "test@example.com",
		"exp":   float64(time.Now().Add(1 * time.Hour).Unix()),
	})

	email, err := ExtractEmailFromIDToken(token)
	if err != nil {
		t.Fatalf("ExtractEmailFromIDToken failed: %v", err)
	}
	if email != "test@example.com" {
		t.Errorf("email = %q, want %q", email, "test@example.com")
	}
}

func TestExtractEmailFromIDToken_InvalidFormat(t *testing.T) {
	_, err := ExtractEmailFromIDToken("not-a-jwt")
	if err == nil {
		t.Error("should return error for invalid token format")
	}
	if !strings.Contains(err.Error(), "invalid") {
		t.Errorf("error should mention 'invalid', got: %v", err)
	}
}

func TestExtractEmailFromIDToken_MissingEmailClaim(t *testing.T) {
	token := makeJWT(t, map[string]interface{}{
		"sub": "user-123",
	})

	_, err := ExtractEmailFromIDToken(token)
	if err == nil {
		t.Error("should return error when email claim is missing")
	}
}

func TestExtractEmailFromIDToken_InvalidBase64(t *testing.T) {
	_, err := ExtractEmailFromIDToken("header.!!!invalid!!!.sig")
	if err == nil {
		t.Error("should return error for invalid base64 payload")
	}
}

// ---------------------------------------------------------------------------
// GetExpiryFromIDToken
// ---------------------------------------------------------------------------

func TestGetExpiryFromIDToken(t *testing.T) {
	expiry := time.Now().Add(2 * time.Hour)
	token := makeJWT(t, map[string]interface{}{
		"sub":   "user-123",
		"email": "test@example.com",
		"exp":   float64(expiry.Unix()),
	})

	got, err := GetExpiryFromIDToken(token)
	if err != nil {
		t.Fatalf("GetExpiryFromIDToken failed: %v", err)
	}

	if got.Unix() != expiry.Unix() {
		t.Errorf("expiry = %v, want %v", got.Unix(), expiry.Unix())
	}
}

func TestGetExpiryFromIDToken_MissingExpClaim(t *testing.T) {
	token := makeJWT(t, map[string]interface{}{
		"sub":   "user-123",
		"email": "test@example.com",
	})

	_, err := GetExpiryFromIDToken(token)
	if err == nil {
		t.Error("should return error when exp claim is missing")
	}
}

func TestGetExpiryFromIDToken_InvalidFormat(t *testing.T) {
	_, err := GetExpiryFromIDToken("bad-token")
	if err == nil {
		t.Error("should return error for invalid token format")
	}
}

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

func TestGeneratePKCE(t *testing.T) {
	pkce, err := GeneratePKCE()
	if err != nil {
		t.Fatalf("GeneratePKCE failed: %v", err)
	}

	if pkce.Verifier == "" {
		t.Error("Verifier should not be empty")
	}
	if pkce.Challenge == "" {
		t.Error("Challenge should not be empty")
	}
	if pkce.Verifier == pkce.Challenge {
		t.Error("Verifier and Challenge should be different")
	}

	// Verify the challenge is deterministic from the verifier
	hash := sha256.Sum256([]byte(pkce.Verifier))
	expectedChallenge := base64.RawURLEncoding.EncodeToString(hash[:])
	if pkce.Challenge != expectedChallenge {
		t.Errorf("Challenge = %q, want %q (computed from verifier)", pkce.Challenge, expectedChallenge)
	}
}

func TestGeneratePKCE_Uniqueness(t *testing.T) {
	p1, _ := GeneratePKCE()
	p2, _ := GeneratePKCE()
	if p1.Verifier == p2.Verifier {
		t.Error("Two PKCE generations should produce different verifiers")
	}
}

func TestGeneratePKCE_VerifierLength(t *testing.T) {
	pkce, _ := GeneratePKCE()
	// 32 random bytes -> 43 base64url chars (no padding)
	if len(pkce.Verifier) != 43 {
		t.Errorf("Verifier length = %d, want 43", len(pkce.Verifier))
	}
}

func TestGeneratePKCE_ValidBase64URL(t *testing.T) {
	pkce, _ := GeneratePKCE()
	for _, s := range []string{pkce.Verifier, pkce.Challenge} {
		if strings.ContainsAny(s, "+/=") {
			t.Errorf("PKCE value %q contains invalid base64url characters", s)
		}
	}
}

func TestGenerateState(t *testing.T) {
	state, err := GenerateState()
	if err != nil {
		t.Fatalf("GenerateState failed: %v", err)
	}
	if state == "" {
		t.Error("State should not be empty")
	}
	// 16 random bytes -> 22 base64url chars
	if len(state) != 22 {
		t.Errorf("State length = %d, want 22", len(state))
	}
}

func TestGenerateState_Uniqueness(t *testing.T) {
	s1, _ := GenerateState()
	s2, _ := GenerateState()
	if s1 == s2 {
		t.Error("Two state generations should produce different values")
	}
}

// ---------------------------------------------------------------------------
// addPadding (unexported helper)
// ---------------------------------------------------------------------------

func TestAddPadding(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{"len%4==0, no padding needed", "abcd", "abcd"},
		{"len%4==2, needs ==", "ab", "ab=="},
		{"len%4==3, needs =", "abc", "abc="},
		{"len%4==1, no padding added", "a", "a"},
		{"empty string", "", ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := addPadding(tt.input)
			if got != tt.want {
				t.Errorf("addPadding(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}
