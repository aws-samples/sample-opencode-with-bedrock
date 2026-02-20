package version

import (
	"encoding/json"
	"os"
	"path/filepath"
	"time"
)

// SuppressionState tracks notification dismissal and config patch state.
type SuppressionState struct {
	DismissedVersion  string `json:"dismissed_version,omitempty"`
	DismissedAt       string `json:"dismissed_at,omitempty"`
	CheckDisabled     bool   `json:"check_disabled,omitempty"`
	LastConfigVersion int    `json:"last_config_version,omitempty"`
}

const (
	suppressionFileName = "version-check.json"
	dismissalDuration   = 7 * 24 * time.Hour // 7 days
)

// suppressionPath returns the path to the suppression state file.
func suppressionPath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return filepath.Join(".opencode", suppressionFileName)
	}
	return filepath.Join(home, ".opencode", suppressionFileName)
}

// LoadSuppression loads the suppression state from disk.
// Returns a zero-value state if the file doesn't exist.
func LoadSuppression() *SuppressionState {
	data, err := os.ReadFile(suppressionPath())
	if err != nil {
		return &SuppressionState{}
	}

	var state SuppressionState
	if err := json.Unmarshal(data, &state); err != nil {
		return &SuppressionState{}
	}
	return &state
}

// SaveSuppression writes the suppression state to disk.
func SaveSuppression(state *SuppressionState) error {
	path := suppressionPath()
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}

	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(path, data, 0600)
}

// ShouldNotify determines whether an update notification should be shown.
// Returns true if the notification should be displayed.
func ShouldNotify(info *UpdateInfo) bool {
	if info == nil || !info.Available {
		return false
	}

	// Critical updates always show
	if info.Critical {
		return true
	}

	// Check environment variable opt-out
	if os.Getenv("OPENCODE_NO_UPDATE_CHECK") == "1" {
		return false
	}

	state := LoadSuppression()

	// Config-level opt-out
	if state.CheckDisabled {
		return false
	}

	// Check if this version was recently dismissed
	if state.DismissedVersion == info.Latest && state.DismissedAt != "" {
		dismissedAt, err := time.Parse(time.RFC3339, state.DismissedAt)
		if err == nil && time.Since(dismissedAt) < dismissalDuration {
			return false
		}
	}

	return true
}

// DismissVersion records that the user has seen (and implicitly dismissed)
// the notification for a specific version.
func DismissVersion(version string) error {
	state := LoadSuppression()
	state.DismissedVersion = version
	state.DismissedAt = time.Now().UTC().Format(time.RFC3339)
	return SaveSuppression(state)
}

// ShouldUpdateConfig returns true if the manifest's config_version is newer
// than what was last applied locally.
func ShouldUpdateConfig(manifest *Manifest) bool {
	if manifest == nil || manifest.ConfigVersion <= 0 {
		return false
	}

	state := LoadSuppression()
	return manifest.ConfigVersion > state.LastConfigVersion
}

// RecordConfigVersion updates the last-applied config version.
func RecordConfigVersion(configVersion int) error {
	state := LoadSuppression()
	state.LastConfigVersion = configVersion
	return SaveSuppression(state)
}
