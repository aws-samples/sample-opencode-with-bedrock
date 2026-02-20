package version

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestCheckForUpdate_DevVersion(t *testing.T) {
	info, manifest, err := CheckForUpdate("dev", "http://unused")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if info != nil {
		t.Error("expected nil UpdateInfo for dev version")
	}
	if manifest != nil {
		t.Error("expected nil Manifest for dev version")
	}
}

func TestCheckForUpdate_EmptyVersion(t *testing.T) {
	info, manifest, err := CheckForUpdate("", "http://unused")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if info != nil {
		t.Error("expected nil UpdateInfo for empty version")
	}
	if manifest != nil {
		t.Error("expected nil Manifest for empty version")
	}
}

func TestCheckForUpdate_UpToDate(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(Manifest{
			Latest:  "1.0.0",
			Minimum: "0.9.0",
		})
	}))
	defer srv.Close()

	info, manifest, err := CheckForUpdate("1.0.0", srv.URL)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if info != nil {
		t.Error("expected nil UpdateInfo when up to date")
	}
	if manifest == nil {
		t.Error("expected non-nil Manifest")
	}
}

func TestCheckForUpdate_NewerThanLatest(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(Manifest{
			Latest:  "1.0.0",
			Minimum: "0.9.0",
		})
	}))
	defer srv.Close()

	info, _, err := CheckForUpdate("2.0.0", srv.URL)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if info != nil {
		t.Error("expected nil UpdateInfo when current > latest")
	}
}

func TestCheckForUpdate_UpdateAvailable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(Manifest{
			Latest:      "2.0.0",
			Minimum:     "1.0.0",
			Critical:    true,
			Message:     "Important security fix",
			DownloadURL: "https://example.com/download",
		})
	}))
	defer srv.Close()

	info, _, err := CheckForUpdate("1.5.0", srv.URL)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if info == nil {
		t.Fatal("expected non-nil UpdateInfo")
	}
	if !info.Available {
		t.Error("expected Available=true")
	}
	if info.Latest != "2.0.0" {
		t.Errorf("Latest = %q, want %q", info.Latest, "2.0.0")
	}
	if info.Current != "1.5.0" {
		t.Errorf("Current = %q, want %q", info.Current, "1.5.0")
	}
	if !info.Critical {
		t.Error("expected Critical=true")
	}
	if info.BelowMin {
		t.Error("expected BelowMin=false (1.5.0 >= 1.0.0)")
	}
	if info.Message != "Important security fix" {
		t.Errorf("Message = %q, want %q", info.Message, "Important security fix")
	}
	if info.DownloadURL != "https://example.com/download" {
		t.Errorf("DownloadURL = %q, want %q", info.DownloadURL, "https://example.com/download")
	}
}

func TestCheckForUpdate_BelowMinimum(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(Manifest{
			Latest:  "3.0.0",
			Minimum: "2.0.0",
		})
	}))
	defer srv.Close()

	info, _, err := CheckForUpdate("1.0.0", srv.URL)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if info == nil {
		t.Fatal("expected non-nil UpdateInfo")
	}
	if !info.BelowMin {
		t.Error("expected BelowMin=true")
	}
	if !info.Critical {
		t.Error("expected Critical=true when below minimum")
	}
}

func TestCheckForUpdate_NoMinimumSet(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(Manifest{
			Latest: "2.0.0",
			// Minimum not set
		})
	}))
	defer srv.Close()

	info, _, err := CheckForUpdate("1.0.0", srv.URL)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if info == nil {
		t.Fatal("expected non-nil UpdateInfo")
	}
	if info.BelowMin {
		t.Error("expected BelowMin=false when minimum is empty")
	}
}

func TestFetchManifest_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(Manifest{
			Latest:        "1.2.3",
			Minimum:       "1.0.0",
			ConfigVersion: 5,
			Released:      "2025-01-15",
			DownloadURL:   "https://example.com/dl",
			ChangelogURL:  "https://example.com/changelog",
			Critical:      false,
			Message:       "New features",
		})
	}))
	defer srv.Close()

	m, err := FetchManifest(srv.URL)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if m.Latest != "1.2.3" {
		t.Errorf("Latest = %q, want %q", m.Latest, "1.2.3")
	}
	if m.ConfigVersion != 5 {
		t.Errorf("ConfigVersion = %d, want %d", m.ConfigVersion, 5)
	}
}

func TestFetchManifest_NotFound(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	_, err := FetchManifest(srv.URL)
	if err == nil {
		t.Error("expected error for 404 response")
	}
}

func TestFetchManifest_ServerError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	_, err := FetchManifest(srv.URL)
	if err == nil {
		t.Error("expected error for 500 response")
	}
}

func TestFetchManifest_InvalidJSON(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("not json"))
	}))
	defer srv.Close()

	_, err := FetchManifest(srv.URL)
	if err == nil {
		t.Error("expected error for invalid JSON")
	}
}

func TestFetchManifest_Timeout(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// FetchManifest uses 3-second timeout; sleep longer
		time.Sleep(5 * time.Second)
		json.NewEncoder(w).Encode(Manifest{Latest: "1.0.0"})
	}))
	defer srv.Close()

	_, err := FetchManifest(srv.URL)
	if err == nil {
		t.Error("expected timeout error")
	}
}

func TestFetchManifest_UnreachableServer(t *testing.T) {
	_, err := FetchManifest("http://127.0.0.1:1") // port 1 should be unreachable
	if err == nil {
		t.Error("expected error for unreachable server")
	}
}
