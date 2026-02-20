package version

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// Manifest represents the version.json manifest served by the distribution endpoint.
type Manifest struct {
	Latest        string `json:"latest"`
	Minimum       string `json:"minimum"`
	ConfigVersion int    `json:"config_version"`
	Released      string `json:"released"`
	DownloadURL   string `json:"download_url"`
	ChangelogURL  string `json:"changelog_url"`
	Critical      bool   `json:"critical"`
	Message       string `json:"message"`
}

// UpdateInfo contains information about an available update.
type UpdateInfo struct {
	Available   bool
	Latest      string
	Current     string
	Critical    bool
	BelowMin    bool // true if current version is below the minimum supported version
	Message     string
	DownloadURL string
}

// CheckForUpdate fetches the version manifest and checks if an update is available.
// Returns nil if the current version is "dev" or if no update is available.
// The check uses a short timeout to avoid blocking startup.
func CheckForUpdate(currentVersion, manifestURL string) (*UpdateInfo, *Manifest, error) {
	if IsDev(currentVersion) {
		return nil, nil, nil
	}

	manifest, err := FetchManifest(manifestURL)
	if err != nil {
		return nil, nil, err
	}

	cmp, err := Compare(currentVersion, manifest.Latest)
	if err != nil {
		return nil, manifest, fmt.Errorf("comparing versions: %w", err)
	}

	if cmp >= 0 {
		// Current version is up to date (or newer)
		return nil, manifest, nil
	}

	info := &UpdateInfo{
		Available:   true,
		Latest:      manifest.Latest,
		Current:     currentVersion,
		Critical:    manifest.Critical,
		Message:     manifest.Message,
		DownloadURL: manifest.DownloadURL,
	}

	// Check if below minimum supported version
	if manifest.Minimum != "" {
		minCmp, err := Compare(currentVersion, manifest.Minimum)
		if err == nil && minCmp < 0 {
			info.BelowMin = true
			info.Critical = true // Being below minimum is always critical
		}
	}

	return info, manifest, nil
}

// FetchManifest fetches and parses the version manifest from the given URL.
// Uses a 3-second timeout to avoid blocking.
func FetchManifest(manifestURL string) (*Manifest, error) {
	client := &http.Client{Timeout: 3 * time.Second}

	resp, err := client.Get(manifestURL)
	if err != nil {
		return nil, fmt.Errorf("fetching manifest: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		return nil, fmt.Errorf("version manifest not found (404)")
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("unexpected status %d from manifest URL", resp.StatusCode)
	}

	var manifest Manifest
	if err := json.NewDecoder(resp.Body).Decode(&manifest); err != nil {
		return nil, fmt.Errorf("parsing manifest: %w", err)
	}

	return &manifest, nil
}
