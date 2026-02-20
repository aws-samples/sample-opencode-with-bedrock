package version

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// withTempSuppressionDir overrides the suppression path for testing.
// It sets HOME to a temp directory and restores it after the test.
func withTempSuppressionDir(t *testing.T) string {
	t.Helper()
	origHome := os.Getenv("HOME")
	tempDir := t.TempDir()
	os.Setenv("HOME", tempDir)
	t.Cleanup(func() { os.Setenv("HOME", origHome) })

	// Create the .opencode directory
	if err := os.MkdirAll(filepath.Join(tempDir, ".opencode"), 0700); err != nil {
		t.Fatal(err)
	}
	return tempDir
}

func TestShouldNotify_NilInfo(t *testing.T) {
	if ShouldNotify(nil) {
		t.Error("ShouldNotify(nil) should return false")
	}
}

func TestShouldNotify_NotAvailable(t *testing.T) {
	info := &UpdateInfo{Available: false}
	if ShouldNotify(info) {
		t.Error("ShouldNotify(not available) should return false")
	}
}

func TestShouldNotify_CriticalAlwaysShows(t *testing.T) {
	withTempSuppressionDir(t)
	info := &UpdateInfo{Available: true, Critical: true, Latest: "2.0.0"}
	if !ShouldNotify(info) {
		t.Error("ShouldNotify(critical) should return true")
	}
}

func TestShouldNotify_CriticalIgnoresEnvOptOut(t *testing.T) {
	withTempSuppressionDir(t)
	os.Setenv("OPENCODE_NO_UPDATE_CHECK", "1")
	defer os.Unsetenv("OPENCODE_NO_UPDATE_CHECK")

	info := &UpdateInfo{Available: true, Critical: true, Latest: "2.0.0"}
	if !ShouldNotify(info) {
		t.Error("ShouldNotify(critical) should return true even with env opt-out")
	}
}

func TestShouldNotify_EnvOptOut(t *testing.T) {
	withTempSuppressionDir(t)
	os.Setenv("OPENCODE_NO_UPDATE_CHECK", "1")
	defer os.Unsetenv("OPENCODE_NO_UPDATE_CHECK")

	info := &UpdateInfo{Available: true, Critical: false, Latest: "2.0.0"}
	if ShouldNotify(info) {
		t.Error("ShouldNotify should return false with OPENCODE_NO_UPDATE_CHECK=1")
	}
}

func TestShouldNotify_DismissedRecently(t *testing.T) {
	home := withTempSuppressionDir(t)

	// Write a suppression state that was dismissed recently
	state := &SuppressionState{
		DismissedVersion: "2.0.0",
		DismissedAt:      time.Now().Add(-1 * time.Hour).UTC().Format(time.RFC3339),
	}
	data, _ := json.MarshalIndent(state, "", "  ")
	os.WriteFile(filepath.Join(home, ".opencode", suppressionFileName), data, 0600)

	info := &UpdateInfo{Available: true, Critical: false, Latest: "2.0.0"}
	if ShouldNotify(info) {
		t.Error("ShouldNotify should return false for recently dismissed version")
	}
}

func TestShouldNotify_DismissedExpired(t *testing.T) {
	home := withTempSuppressionDir(t)

	// Write a suppression state that expired (> 7 days ago)
	state := &SuppressionState{
		DismissedVersion: "2.0.0",
		DismissedAt:      time.Now().Add(-8 * 24 * time.Hour).UTC().Format(time.RFC3339),
	}
	data, _ := json.MarshalIndent(state, "", "  ")
	os.WriteFile(filepath.Join(home, ".opencode", suppressionFileName), data, 0600)

	info := &UpdateInfo{Available: true, Critical: false, Latest: "2.0.0"}
	if !ShouldNotify(info) {
		t.Error("ShouldNotify should return true when dismissal expired (>7 days)")
	}
}

func TestShouldNotify_DismissedDifferentVersion(t *testing.T) {
	home := withTempSuppressionDir(t)

	// Dismissed version 1.5.0, but 2.0.0 is now latest
	state := &SuppressionState{
		DismissedVersion: "1.5.0",
		DismissedAt:      time.Now().Add(-1 * time.Hour).UTC().Format(time.RFC3339),
	}
	data, _ := json.MarshalIndent(state, "", "  ")
	os.WriteFile(filepath.Join(home, ".opencode", suppressionFileName), data, 0600)

	info := &UpdateInfo{Available: true, Critical: false, Latest: "2.0.0"}
	if !ShouldNotify(info) {
		t.Error("ShouldNotify should return true for a different version than the dismissed one")
	}
}

func TestShouldNotify_CheckDisabled(t *testing.T) {
	home := withTempSuppressionDir(t)

	state := &SuppressionState{CheckDisabled: true}
	data, _ := json.MarshalIndent(state, "", "  ")
	os.WriteFile(filepath.Join(home, ".opencode", suppressionFileName), data, 0600)

	info := &UpdateInfo{Available: true, Critical: false, Latest: "2.0.0"}
	if ShouldNotify(info) {
		t.Error("ShouldNotify should return false when CheckDisabled=true")
	}
}

func TestDismissVersion_PersistsAndLoads(t *testing.T) {
	withTempSuppressionDir(t)

	if err := DismissVersion("3.0.0"); err != nil {
		t.Fatalf("DismissVersion() error: %v", err)
	}

	state := LoadSuppression()
	if state.DismissedVersion != "3.0.0" {
		t.Errorf("DismissedVersion = %q, want %q", state.DismissedVersion, "3.0.0")
	}
	if state.DismissedAt == "" {
		t.Error("DismissedAt should be set")
	}

	// Verify the timestamp is recent
	dismissedAt, err := time.Parse(time.RFC3339, state.DismissedAt)
	if err != nil {
		t.Fatalf("failed to parse DismissedAt: %v", err)
	}
	if time.Since(dismissedAt) > 5*time.Second {
		t.Error("DismissedAt should be recent")
	}
}

func TestShouldUpdateConfig_NoManifest(t *testing.T) {
	if ShouldUpdateConfig(nil) {
		t.Error("ShouldUpdateConfig(nil) should return false")
	}
}

func TestShouldUpdateConfig_ZeroVersion(t *testing.T) {
	m := &Manifest{ConfigVersion: 0}
	if ShouldUpdateConfig(m) {
		t.Error("ShouldUpdateConfig with config_version=0 should return false")
	}
}

func TestShouldUpdateConfig_NewerVersion(t *testing.T) {
	withTempSuppressionDir(t)

	// No prior state, so last_config_version defaults to 0
	m := &Manifest{ConfigVersion: 1}
	if !ShouldUpdateConfig(m) {
		t.Error("ShouldUpdateConfig should return true when config_version > 0 and no prior state")
	}
}

func TestShouldUpdateConfig_SameVersion(t *testing.T) {
	withTempSuppressionDir(t)

	// Record version 5
	if err := RecordConfigVersion(5); err != nil {
		t.Fatalf("RecordConfigVersion() error: %v", err)
	}

	m := &Manifest{ConfigVersion: 5}
	if ShouldUpdateConfig(m) {
		t.Error("ShouldUpdateConfig should return false when versions match")
	}
}

func TestShouldUpdateConfig_OlderVersion(t *testing.T) {
	withTempSuppressionDir(t)

	if err := RecordConfigVersion(5); err != nil {
		t.Fatalf("RecordConfigVersion() error: %v", err)
	}

	m := &Manifest{ConfigVersion: 3}
	if ShouldUpdateConfig(m) {
		t.Error("ShouldUpdateConfig should return false when manifest version is older")
	}
}

func TestRecordConfigVersion_PersistsAndLoads(t *testing.T) {
	withTempSuppressionDir(t)

	if err := RecordConfigVersion(42); err != nil {
		t.Fatalf("RecordConfigVersion() error: %v", err)
	}

	state := LoadSuppression()
	if state.LastConfigVersion != 42 {
		t.Errorf("LastConfigVersion = %d, want %d", state.LastConfigVersion, 42)
	}
}

func TestRecordConfigVersion_PreservesOtherFields(t *testing.T) {
	withTempSuppressionDir(t)

	// First dismiss a version
	if err := DismissVersion("1.0.0"); err != nil {
		t.Fatalf("DismissVersion() error: %v", err)
	}

	// Then record config version
	if err := RecordConfigVersion(10); err != nil {
		t.Fatalf("RecordConfigVersion() error: %v", err)
	}

	state := LoadSuppression()
	if state.DismissedVersion != "1.0.0" {
		t.Error("RecordConfigVersion should not clear DismissedVersion")
	}
	if state.LastConfigVersion != 10 {
		t.Errorf("LastConfigVersion = %d, want %d", state.LastConfigVersion, 10)
	}
}

func TestLoadSuppression_NoFile(t *testing.T) {
	withTempSuppressionDir(t)

	state := LoadSuppression()
	if state == nil {
		t.Fatal("LoadSuppression() should return non-nil even with no file")
	}
	if state.DismissedVersion != "" || state.CheckDisabled || state.LastConfigVersion != 0 {
		t.Error("LoadSuppression() should return zero-value state when file doesn't exist")
	}
}
