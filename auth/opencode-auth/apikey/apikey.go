// Package apikey provides a client for managing API keys via the router service.
package apikey

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Client communicates with the /v1/api-keys management endpoints.
type Client struct {
	baseURL    string
	jwtToken   string
	httpClient *http.Client
}

// NewClient creates a new API key management client.
func NewClient(baseURL, jwtToken string) *Client {
	return &Client{
		baseURL:  baseURL,
		jwtToken: jwtToken,
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

// CreateRequest is the request body for creating an API key.
type CreateRequest struct {
	Description   string `json:"description"`
	ExpiresInDays int    `json:"expires_in_days,omitempty"`
}

// APIKey represents a created API key (includes the full key, shown only once).
type APIKey struct {
	Key         string `json:"key"`
	KeyPrefix   string `json:"key_prefix"`
	Description string `json:"description"`
	Status      string `json:"status"`
	CreatedAt   string `json:"created_at"`
	ExpiresAt   string `json:"expires_at"`
}

// APIKeySummary represents an API key in list responses (never includes full key).
type APIKeySummary struct {
	KeyPrefix  string  `json:"key_prefix"`
	Description string `json:"description"`
	Status      string `json:"status"`
	CreatedAt   string `json:"created_at"`
	ExpiresAt   string `json:"expires_at"`
	LastUsedAt  *string `json:"last_used_at"`
}

// ListResponse is the response from listing API keys.
type ListResponse struct {
	Keys []APIKeySummary `json:"keys"`
}

// RevokeResponse is the response from revoking an API key.
type RevokeResponse struct {
	Status    string `json:"status"`
	KeyPrefix string `json:"key_prefix"`
}

// ErrorResponse is an error from the API.
type ErrorResponse struct {
	Error string `json:"error"`
}

// Create creates a new API key.
func (c *Client) Create(description string, expiresInDays int) (*APIKey, error) {
	reqBody := CreateRequest{
		Description:   description,
		ExpiresInDays: expiresInDays,
	}

	data, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request: %w", err)
	}

	req, err := http.NewRequest("POST", c.baseURL+"/v1/api-keys", bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	if c.jwtToken != "" {
		req.Header.Set("Authorization", "Bearer "+c.jwtToken)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %w", err)
	}

	if resp.StatusCode != http.StatusCreated {
		var errResp ErrorResponse
		if json.Unmarshal(body, &errResp) == nil && errResp.Error != "" {
			return nil, fmt.Errorf("API error (%d): %s", resp.StatusCode, errResp.Error)
		}
		return nil, fmt.Errorf("unexpected status %d: %s", resp.StatusCode, string(body))
	}

	var apiKey APIKey
	if err := json.Unmarshal(body, &apiKey); err != nil {
		return nil, fmt.Errorf("failed to parse response: %w", err)
	}

	return &apiKey, nil
}

// List returns all API keys for the authenticated user.
func (c *Client) List() (*ListResponse, error) {
	req, err := http.NewRequest("GET", c.baseURL+"/v1/api-keys", nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	if c.jwtToken != "" {
		req.Header.Set("Authorization", "Bearer "+c.jwtToken)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		var errResp ErrorResponse
		if json.Unmarshal(body, &errResp) == nil && errResp.Error != "" {
			return nil, fmt.Errorf("API error (%d): %s", resp.StatusCode, errResp.Error)
		}
		return nil, fmt.Errorf("unexpected status %d: %s", resp.StatusCode, string(body))
	}

	var listResp ListResponse
	if err := json.Unmarshal(body, &listResp); err != nil {
		return nil, fmt.Errorf("failed to parse response: %w", err)
	}

	return &listResp, nil
}

// Revoke revokes an API key by its prefix.
func (c *Client) Revoke(keyPrefix string) (*RevokeResponse, error) {
	req, err := http.NewRequest("DELETE", c.baseURL+"/v1/api-keys/"+keyPrefix, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	if c.jwtToken != "" {
		req.Header.Set("Authorization", "Bearer "+c.jwtToken)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		var errResp ErrorResponse
		if json.Unmarshal(body, &errResp) == nil && errResp.Error != "" {
			return nil, fmt.Errorf("API error (%d): %s", resp.StatusCode, errResp.Error)
		}
		return nil, fmt.Errorf("unexpected status %d: %s", resp.StatusCode, string(body))
	}

	var revokeResp RevokeResponse
	if err := json.Unmarshal(body, &revokeResp); err != nil {
		return nil, fmt.Errorf("failed to parse response: %w", err)
	}

	return &revokeResp, nil
}
