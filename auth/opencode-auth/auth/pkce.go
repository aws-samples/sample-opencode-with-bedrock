// Package auth provides authentication functionality for the OpenCode credential helper.
package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
)

// PKCE holds the PKCE verifier and challenge for OAuth 2.0 PKCE flow.
type PKCE struct {
	Verifier  string
	Challenge string
}

// GeneratePKCE generates a new PKCE verifier and challenge pair.
// The verifier is a cryptographically random string, and the challenge
// is the base64url-encoded SHA256 hash of the verifier.
func GeneratePKCE() (*PKCE, error) {
	// Generate 32 random bytes for the verifier
	verifierBytes := make([]byte, 32)
	if _, err := rand.Read(verifierBytes); err != nil {
		return nil, err
	}

	// Base64url encode the verifier (without padding)
	verifier := base64.RawURLEncoding.EncodeToString(verifierBytes)

	// SHA256 hash the verifier
	hash := sha256.Sum256([]byte(verifier))

	// Base64url encode the hash (without padding)
	challenge := base64.RawURLEncoding.EncodeToString(hash[:])

	return &PKCE{
		Verifier:  verifier,
		Challenge: challenge,
	}, nil
}

// GenerateState generates a random state parameter for OAuth 2.0.
func GenerateState() (string, error) {
	stateBytes := make([]byte, 16)
	if _, err := rand.Read(stateBytes); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(stateBytes), nil
}
