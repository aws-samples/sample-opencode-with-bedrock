package configpatch

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestSetTopLevel(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "test.json")
	writeJSON(t, path, map[string]interface{}{"existing": "value"})

	err := Apply(path, PatchSpec{
		Set: map[string]interface{}{
			"new_key": "new_value",
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	result := readJSON(t, path)
	if result["existing"] != "value" {
		t.Error("existing key was modified")
	}
	if result["new_key"] != "new_value" {
		t.Error("new key was not set")
	}
}

func TestSetOverwritesManaged(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "test.json")
	writeJSON(t, path, map[string]interface{}{
		"managed": "old",
		"user":    "custom",
	})

	err := Apply(path, PatchSpec{
		Set: map[string]interface{}{
			"managed": "new",
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	result := readJSON(t, path)
	if result["managed"] != "new" {
		t.Error("managed key was not updated")
	}
	if result["user"] != "custom" {
		t.Error("user key was modified")
	}
}

func TestSetDeep(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "test.json")
	writeJSON(t, path, map[string]interface{}{
		"provider": map[string]interface{}{
			"bedrock": map[string]interface{}{
				"models": map[string]interface{}{
					"existing-model": map[string]interface{}{"name": "Old Model"},
				},
			},
		},
		"model": "bedrock/existing-model",
	})

	err := Apply(path, PatchSpec{
		SetDeep: map[string]interface{}{
			"provider.bedrock.models.new-model": map[string]interface{}{
				"name": "New Model",
			},
			"provider.bedrock.models.existing-model.name": "Updated Model",
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	result := readJSON(t, path)
	// User's model preference must survive
	if result["model"] != "bedrock/existing-model" {
		t.Errorf("user model preference was modified: %v", result["model"])
	}

	// New model should exist
	provider := result["provider"].(map[string]interface{})
	bedrock := provider["bedrock"].(map[string]interface{})
	models := bedrock["models"].(map[string]interface{})
	newModel := models["new-model"].(map[string]interface{})
	if newModel["name"] != "New Model" {
		t.Error("new model was not added")
	}
}

func TestRemoveDeep(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "test.json")
	writeJSON(t, path, map[string]interface{}{
		"provider": map[string]interface{}{
			"bedrock": map[string]interface{}{
				"models": map[string]interface{}{
					"keep":   "yes",
					"remove": "this",
				},
			},
		},
	})

	err := Apply(path, PatchSpec{
		RemoveDeep: []string{"provider.bedrock.models.remove"},
	})
	if err != nil {
		t.Fatal(err)
	}

	result := readJSON(t, path)
	provider := result["provider"].(map[string]interface{})
	bedrock := provider["bedrock"].(map[string]interface{})
	models := bedrock["models"].(map[string]interface{})
	if _, ok := models["remove"]; ok {
		t.Error("key was not removed")
	}
	if models["keep"] != "yes" {
		t.Error("other key was affected")
	}
}

func TestRemoveDeepNonExistent(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "test.json")
	writeJSON(t, path, map[string]interface{}{"key": "value"})

	// Should not error on non-existent path
	err := Apply(path, PatchSpec{
		RemoveDeep: []string{"nonexistent.deeply.nested.path"},
	})
	if err != nil {
		t.Fatal(err)
	}

	result := readJSON(t, path)
	if result["key"] != "value" {
		t.Error("existing key was modified")
	}
}

func TestBackupAndRestore(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "test.json")
	writeJSON(t, path, map[string]interface{}{"original": true})

	if err := Backup(path); err != nil {
		t.Fatal(err)
	}

	// Modify the file
	writeJSON(t, path, map[string]interface{}{"modified": true})

	// Restore
	if err := Restore(path); err != nil {
		t.Fatal(err)
	}

	result := readJSON(t, path)
	if _, ok := result["original"]; !ok {
		t.Error("backup was not restored")
	}
}

func TestSetDeepCreatesIntermediates(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "test.json")
	writeJSON(t, path, map[string]interface{}{})

	err := Apply(path, PatchSpec{
		SetDeep: map[string]interface{}{
			"a.b.c": "deep_value",
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	result := readJSON(t, path)
	a := result["a"].(map[string]interface{})
	b := a["b"].(map[string]interface{})
	if b["c"] != "deep_value" {
		t.Error("deep value was not set")
	}
}

// Helper functions

func writeJSON(t *testing.T, path string, data interface{}) {
	t.Helper()
	b, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, b, 0600); err != nil {
		t.Fatal(err)
	}
}

func readJSON(t *testing.T, path string) map[string]interface{} {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var result map[string]interface{}
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatal(err)
	}
	return result
}
