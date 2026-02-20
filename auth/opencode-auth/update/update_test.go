package update

import (
	"archive/zip"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestGetDownloadURL_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/update/download-url" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(DownloadURLResponse{
			DownloadURL: "https://example.com/installer.zip",
			ExpiresIn:   3600,
		})
	}))
	defer srv.Close()

	resp, err := GetDownloadURL(srv.URL)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.DownloadURL != "https://example.com/installer.zip" {
		t.Errorf("DownloadURL = %q, want %q", resp.DownloadURL, "https://example.com/installer.zip")
	}
	if resp.ExpiresIn != 3600 {
		t.Errorf("ExpiresIn = %d, want %d", resp.ExpiresIn, 3600)
	}
}

func TestGetDownloadURL_ServerError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(`{"error": "internal server error"}`))
	}))
	defer srv.Close()

	_, err := GetDownloadURL(srv.URL)
	if err == nil {
		t.Error("expected error for 500 response")
	}
}

func TestGetDownloadURL_Unauthorized(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		w.Write([]byte(`{"error": "unauthorized"}`))
	}))
	defer srv.Close()

	_, err := GetDownloadURL(srv.URL)
	if err == nil {
		t.Error("expected error for 401 response")
	}
}

func TestGetDownloadURL_UnreachableServer(t *testing.T) {
	_, err := GetDownloadURL("http://127.0.0.1:1")
	if err == nil {
		t.Error("expected error for unreachable server")
	}
}

func TestDownloadZip_Success(t *testing.T) {
	// Serve a small valid zip file
	zipContent := createTestZip(t, map[string]string{
		"install.sh": "#!/bin/bash\necho hello",
	})

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/zip")
		w.Write(zipContent)
	}))
	defer srv.Close()

	path, err := DownloadZip(srv.URL)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	defer os.Remove(path)

	// Verify the file exists and has content
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("downloaded file not found: %v", err)
	}
	if info.Size() == 0 {
		t.Error("downloaded file is empty")
	}
}

func TestDownloadZip_ServerError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	}))
	defer srv.Close()

	_, err := DownloadZip(srv.URL)
	if err == nil {
		t.Error("expected error for 403 response")
	}
}

func TestExtractZip_ValidZip(t *testing.T) {
	zipContent := createTestZip(t, map[string]string{
		"file1.txt": "hello",
		"file2.txt": "world",
	})

	// Write zip to temp file
	tmpFile, err := os.CreateTemp("", "test-*.zip")
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(tmpFile.Name())
	tmpFile.Write(zipContent)
	tmpFile.Close()

	// Extract
	destDir := t.TempDir()
	if err := extractZip(tmpFile.Name(), destDir); err != nil {
		t.Fatalf("extractZip() error: %v", err)
	}

	// Verify files
	data, err := os.ReadFile(filepath.Join(destDir, "file1.txt"))
	if err != nil {
		t.Fatalf("file1.txt not found: %v", err)
	}
	if string(data) != "hello" {
		t.Errorf("file1.txt = %q, want %q", string(data), "hello")
	}
}

func TestExtractAndInstall_MissingInstallSh(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("self-update not supported on Windows")
	}

	// Create a zip without install.sh
	zipContent := createTestZip(t, map[string]string{
		"readme.txt": "no installer here",
	})

	tmpFile, err := os.CreateTemp("", "test-*.zip")
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(tmpFile.Name())
	tmpFile.Write(zipContent)
	tmpFile.Close()

	err = ExtractAndInstall(tmpFile.Name())
	if err == nil {
		t.Error("expected error when install.sh is missing")
	}
	if err != nil && !containsString(err.Error(), "install.sh not found") {
		t.Errorf("unexpected error message: %v", err)
	}
}

func TestExtractAndInstall_WindowsUnsupported(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("this test only runs on Windows")
	}

	err := ExtractAndInstall("/tmp/nonexistent.zip")
	if err == nil {
		t.Error("expected error on Windows")
	}
}

// createTestZip creates an in-memory zip file with the given files.
func createTestZip(t *testing.T, files map[string]string) []byte {
	t.Helper()

	tmpFile, err := os.CreateTemp("", "testzip-*.zip")
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(tmpFile.Name())

	w := zip.NewWriter(tmpFile)
	for name, content := range files {
		f, err := w.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		f.Write([]byte(content))
	}
	w.Close()
	tmpFile.Close()

	data, err := os.ReadFile(tmpFile.Name())
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func containsString(s, substr string) bool {
	return len(s) >= len(substr) && searchString(s, substr)
}

func searchString(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}
