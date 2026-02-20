// Package update implements the self-update mechanism for opencode-auth.
// It downloads the installer zip via a JWT-authenticated presigned URL
// and runs install.sh to replace the current binary.
package update

import (
	"archive/zip"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// DownloadURLResponse is the response from /v1/update/download-url.
type DownloadURLResponse struct {
	DownloadURL string `json:"download_url"`
	ExpiresIn   int    `json:"expires_in"`
}

// GetDownloadURL fetches a presigned download URL from the API via the proxy.
func GetDownloadURL(proxyURL string) (*DownloadURLResponse, error) {
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Get(proxyURL + "/v1/update/download-url")
	if err != nil {
		return nil, fmt.Errorf("fetching download URL: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("download URL returned status %d: %s", resp.StatusCode, string(body))
	}

	var dlResp DownloadURLResponse
	if err := json.NewDecoder(resp.Body).Decode(&dlResp); err != nil {
		return nil, fmt.Errorf("parsing download URL response: %w", err)
	}

	return &dlResp, nil
}

// DownloadZip downloads the installer zip from the presigned URL to a temp file.
func DownloadZip(downloadURL string) (string, error) {
	client := &http.Client{Timeout: 5 * time.Minute}
	resp, err := client.Get(downloadURL)
	if err != nil {
		return "", fmt.Errorf("downloading installer: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("download returned status %d", resp.StatusCode)
	}

	tmpFile, err := os.CreateTemp("", "opencode-installer-*.zip")
	if err != nil {
		return "", fmt.Errorf("creating temp file: %w", err)
	}
	defer tmpFile.Close()

	if _, err := io.Copy(tmpFile, resp.Body); err != nil {
		os.Remove(tmpFile.Name())
		return "", fmt.Errorf("writing installer zip: %w", err)
	}

	return tmpFile.Name(), nil
}

// ExtractAndInstall extracts the zip and runs install.sh.
func ExtractAndInstall(zipPath string) error {
	if runtime.GOOS == "windows" {
		return fmt.Errorf("self-update is not supported on Windows; please download and install manually")
	}

	// Create temp directory for extraction
	tmpDir, err := os.MkdirTemp("", "opencode-update-*")
	if err != nil {
		return fmt.Errorf("creating temp dir: %w", err)
	}
	defer os.RemoveAll(tmpDir)

	// Extract zip
	if err := extractZip(zipPath, tmpDir); err != nil {
		return fmt.Errorf("extracting zip: %w", err)
	}

	// Find and run install.sh
	installScript := filepath.Join(tmpDir, "install.sh")
	if _, err := os.Stat(installScript); os.IsNotExist(err) {
		return fmt.Errorf("install.sh not found in update package")
	}

	cmd := exec.Command("bash", installScript)
	cmd.Dir = tmpDir
	cmd.Stdout = os.Stderr // install.sh output goes to stderr
	cmd.Stderr = os.Stderr
	cmd.Stdin = os.Stdin

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("install.sh failed: %w", err)
	}

	return nil
}

// extractZip extracts a zip file to the destination directory.
func extractZip(zipPath, destDir string) error {
	r, err := zip.OpenReader(zipPath)
	if err != nil {
		return err
	}
	defer r.Close()

	for _, f := range r.File {
		destPath := filepath.Join(destDir, f.Name)

		// Prevent zip slip — filepath.HasPrefix is deprecated; use
		// strings.HasPrefix on the cleaned, absolute path instead.
		cleanDest := filepath.Clean(destPath)
		cleanDir := filepath.Clean(destDir) + string(os.PathSeparator)
		if !strings.HasPrefix(cleanDest, cleanDir) && cleanDest != filepath.Clean(destDir) {
			return fmt.Errorf("illegal file path in zip: %s", f.Name)
		}

		if f.FileInfo().IsDir() {
			os.MkdirAll(destPath, f.Mode())
			continue
		}

		// Create parent directories
		os.MkdirAll(filepath.Dir(destPath), 0755)

		outFile, err := os.OpenFile(destPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, f.Mode())
		if err != nil {
			return err
		}

		rc, err := f.Open()
		if err != nil {
			outFile.Close()
			return err
		}

		_, err = io.Copy(outFile, rc)
		rc.Close()
		outFile.Close()
		if err != nil {
			return err
		}
	}

	return nil
}
