// Package configpatch provides a config patching engine that applies
// server-driven patches to local JSON config files while preserving
// user-added fields.
package configpatch

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// PatchResponse is the response from the /v1/update/config endpoint.
type PatchResponse struct {
	ConfigVersion int                  `json:"config_version"`
	Patches       map[string]PatchSpec `json:"patches"`
}

// PatchSpec defines the operations for a single config file.
type PatchSpec struct {
	Set        map[string]interface{} `json:"set,omitempty"`
	SetDeep    map[string]interface{} `json:"set_deep,omitempty"`
	Remove     []string               `json:"remove,omitempty"`
	RemoveDeep []string               `json:"remove_deep,omitempty"`
}

// FetchConfigPatch fetches a config patch from the API via the proxy.
func FetchConfigPatch(proxyURL string, sinceVersion int) (*PatchResponse, error) {
	client := &http.Client{Timeout: 10 * time.Second}
	url := fmt.Sprintf("%s/v1/update/config?since_version=%d", proxyURL, sinceVersion)

	resp, err := client.Get(url)
	if err != nil {
		return nil, fmt.Errorf("fetching config patch: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		return nil, nil // No patch available
	}
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("config patch returned status %d: %s", resp.StatusCode, string(body))
	}

	var patch PatchResponse
	if err := json.NewDecoder(resp.Body).Decode(&patch); err != nil {
		return nil, fmt.Errorf("parsing config patch: %w", err)
	}

	return &patch, nil
}

// Apply applies a PatchSpec to a JSON file.
// It reads the file, applies operations, and writes back.
// Keys not mentioned in the patch are never modified.
func Apply(filePath string, spec PatchSpec) error {
	data, err := os.ReadFile(filePath)
	if err != nil {
		return fmt.Errorf("reading %s: %w", filePath, err)
	}

	var obj map[string]interface{}
	if err := json.Unmarshal(data, &obj); err != nil {
		return fmt.Errorf("parsing %s: %w", filePath, err)
	}

	// Apply top-level set operations
	for key, val := range spec.Set {
		obj[key] = val
	}

	// Apply deep set operations (dot-notation paths)
	for path, val := range spec.SetDeep {
		setDeep(obj, path, val)
	}

	// Apply top-level remove operations
	for _, key := range spec.Remove {
		delete(obj, key)
	}

	// Apply deep remove operations
	for _, path := range spec.RemoveDeep {
		removeDeep(obj, path)
	}

	// Write back with same formatting
	out, err := json.MarshalIndent(obj, "", "  ")
	if err != nil {
		return fmt.Errorf("marshaling %s: %w", filePath, err)
	}
	out = append(out, '\n')

	return os.WriteFile(filePath, out, 0600)
}

// Backup creates a backup copy of the file (file.bak).
func Backup(filePath string) error {
	data, err := os.ReadFile(filePath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil // Nothing to back up
		}
		return err
	}
	return os.WriteFile(filePath+".bak", data, 0600)
}

// Restore restores a file from its backup (file.bak).
func Restore(filePath string) error {
	data, err := os.ReadFile(filePath + ".bak")
	if err != nil {
		return err
	}
	return os.WriteFile(filePath, data, 0600)
}

// setDeep sets a value at a dot-notation path, creating intermediate maps as needed.
// Example: setDeep(obj, "provider.bedrock.models.new-model", {...})
func setDeep(obj map[string]interface{}, path string, val interface{}) {
	parts := strings.Split(path, ".")
	current := obj

	// Navigate/create intermediate maps
	for i := 0; i < len(parts)-1; i++ {
		key := parts[i]
		next, ok := current[key]
		if !ok {
			// Create intermediate map
			newMap := make(map[string]interface{})
			current[key] = newMap
			current = newMap
			continue
		}
		nextMap, ok := next.(map[string]interface{})
		if !ok {
			// Path conflicts with existing non-map value — overwrite with map
			newMap := make(map[string]interface{})
			current[key] = newMap
			current = newMap
			continue
		}
		current = nextMap
	}

	// Set the leaf value
	current[parts[len(parts)-1]] = val
}

// removeDeep removes a value at a dot-notation path.
// No-op if the path doesn't exist.
func removeDeep(obj map[string]interface{}, path string) {
	parts := strings.Split(path, ".")
	current := obj

	// Navigate to the parent
	for i := 0; i < len(parts)-1; i++ {
		next, ok := current[parts[i]]
		if !ok {
			return // Path doesn't exist
		}
		nextMap, ok := next.(map[string]interface{})
		if !ok {
			return // Not a map
		}
		current = nextMap
	}

	// Delete the leaf
	delete(current, parts[len(parts)-1])
}
