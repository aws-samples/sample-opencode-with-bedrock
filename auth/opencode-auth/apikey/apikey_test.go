package apikey

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// ---------------------------------------------------------------------------
// NewClient
// ---------------------------------------------------------------------------

func TestNewClient(t *testing.T) {
	c := NewClient("https://api.example.com", "my-jwt")
	if c.baseURL != "https://api.example.com" {
		t.Errorf("baseURL = %q", c.baseURL)
	}
	if c.jwtToken != "my-jwt" {
		t.Errorf("jwtToken = %q", c.jwtToken)
	}
	if c.httpClient == nil {
		t.Error("httpClient should not be nil")
	}
	if c.httpClient.Timeout.Seconds() != 30 {
		t.Errorf("httpClient.Timeout = %v, want 30s", c.httpClient.Timeout)
	}
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

func TestCreate_Success(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			t.Errorf("method = %s, want POST", r.Method)
		}
		if r.URL.Path != "/v1/api-keys" {
			t.Errorf("path = %s, want /v1/api-keys", r.URL.Path)
		}

		auth := r.Header.Get("Authorization")
		if auth != "Bearer test-jwt" {
			t.Errorf("Authorization = %q, want %q", auth, "Bearer test-jwt")
		}
		if r.Header.Get("Content-Type") != "application/json" {
			t.Errorf("Content-Type = %q", r.Header.Get("Content-Type"))
		}

		// Verify request body
		body, _ := io.ReadAll(r.Body)
		var req CreateRequest
		json.Unmarshal(body, &req)
		if req.Description != "My test key" {
			t.Errorf("request description = %q", req.Description)
		}
		if req.ExpiresInDays != 30 {
			t.Errorf("request expires_in_days = %d", req.ExpiresInDays)
		}

		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(APIKey{
			Key:         "oc_full-key-value",
			KeyPrefix:   "oc_full-ke",
			Description: "My test key",
			Status:      "active",
			CreatedAt:   "2026-01-01T00:00:00Z",
			ExpiresAt:   "2026-04-01T00:00:00Z",
		})
	}))
	defer server.Close()

	c := NewClient(server.URL, "test-jwt")
	key, err := c.Create("My test key", 30)
	if err != nil {
		t.Fatalf("Create failed: %v", err)
	}

	if key.Key != "oc_full-key-value" {
		t.Errorf("Key = %q", key.Key)
	}
	if key.Status != "active" {
		t.Errorf("Status = %q", key.Status)
	}
}

func TestCreate_APIError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(ErrorResponse{Error: "Invalid expiry"})
	}))
	defer server.Close()

	c := NewClient(server.URL, "test-jwt")
	_, err := c.Create("test", 0)
	if err == nil {
		t.Fatal("Create should return error on 400")
	}
	if !strings.Contains(err.Error(), "Invalid expiry") {
		t.Errorf("error should contain API message, got: %v", err)
	}
}

func TestCreate_ServerError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte("internal error"))
	}))
	defer server.Close()

	c := NewClient(server.URL, "test-jwt")
	_, err := c.Create("test", 30)
	if err == nil {
		t.Fatal("Create should return error on 500")
	}
}

func TestCreate_NoJWT(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		if auth != "" {
			t.Errorf("Authorization should be empty when no JWT, got %q", auth)
		}
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(APIKey{Key: "oc_test"})
	}))
	defer server.Close()

	c := NewClient(server.URL, "")
	_, err := c.Create("test", 30)
	if err != nil {
		t.Fatalf("Create without JWT should still work: %v", err)
	}
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

func TestList_Success(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" {
			t.Errorf("method = %s, want GET", r.Method)
		}
		if r.URL.Path != "/v1/api-keys" {
			t.Errorf("path = %s", r.URL.Path)
		}

		auth := r.Header.Get("Authorization")
		if auth != "Bearer test-jwt" {
			t.Errorf("Authorization = %q", auth)
		}

		json.NewEncoder(w).Encode(ListResponse{
			Keys: []APIKeySummary{
				{
					KeyPrefix:   "oc_abc",
					Description: "Key 1",
					Status:      "active",
				},
				{
					KeyPrefix:   "oc_def",
					Description: "Key 2",
					Status:      "revoked",
				},
			},
		})
	}))
	defer server.Close()

	c := NewClient(server.URL, "test-jwt")
	resp, err := c.List()
	if err != nil {
		t.Fatalf("List failed: %v", err)
	}

	if len(resp.Keys) != 2 {
		t.Fatalf("len(Keys) = %d, want 2", len(resp.Keys))
	}
	if resp.Keys[0].KeyPrefix != "oc_abc" {
		t.Errorf("Keys[0].KeyPrefix = %q", resp.Keys[0].KeyPrefix)
	}
	if resp.Keys[1].Status != "revoked" {
		t.Errorf("Keys[1].Status = %q", resp.Keys[1].Status)
	}
}

func TestList_Unauthorized(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		json.NewEncoder(w).Encode(ErrorResponse{Error: "Authentication required"})
	}))
	defer server.Close()

	c := NewClient(server.URL, "bad-jwt")
	_, err := c.List()
	if err == nil {
		t.Fatal("List should return error on 401")
	}
	if !strings.Contains(err.Error(), "Authentication required") {
		t.Errorf("error should contain API message, got: %v", err)
	}
}

// ---------------------------------------------------------------------------
// Revoke
// ---------------------------------------------------------------------------

func TestRevoke_Success(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "DELETE" {
			t.Errorf("method = %s, want DELETE", r.Method)
		}
		if r.URL.Path != "/v1/api-keys/oc_abc" {
			t.Errorf("path = %s, want /v1/api-keys/oc_abc", r.URL.Path)
		}

		json.NewEncoder(w).Encode(RevokeResponse{
			Status:    "revoked",
			KeyPrefix: "oc_abc",
		})
	}))
	defer server.Close()

	c := NewClient(server.URL, "test-jwt")
	resp, err := c.Revoke("oc_abc")
	if err != nil {
		t.Fatalf("Revoke failed: %v", err)
	}

	if resp.Status != "revoked" {
		t.Errorf("Status = %q, want %q", resp.Status, "revoked")
	}
	if resp.KeyPrefix != "oc_abc" {
		t.Errorf("KeyPrefix = %q", resp.KeyPrefix)
	}
}

func TestRevoke_NotFound(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(ErrorResponse{Error: "API key not found"})
	}))
	defer server.Close()

	c := NewClient(server.URL, "test-jwt")
	_, err := c.Revoke("oc_nonexistent")
	if err == nil {
		t.Fatal("Revoke should return error on 404")
	}
	if !strings.Contains(err.Error(), "not found") {
		t.Errorf("error should mention 'not found', got: %v", err)
	}
}

func TestRevoke_ServerError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte("something broke"))
	}))
	defer server.Close()

	c := NewClient(server.URL, "test-jwt")
	_, err := c.Revoke("oc_abc")
	if err == nil {
		t.Fatal("Revoke should return error on 500")
	}
}
