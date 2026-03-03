// Package proxy provides a local HTTP proxy server.
// This file implements optional debug logging to ~/.opencode/logs/proxy-debug.log
// for diagnosing streaming and connection issues.
//
// Enable with: OPENCODE_DEBUG=1 or opencode-auth proxy --debug
package proxy

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// DebugLogger writes timestamped debug events to a local log file.
// It is safe for concurrent use and no-ops when disabled.
type DebugLogger struct {
	mu      sync.Mutex
	file    *os.File
	enabled bool
}

// NewDebugLogger creates a debug logger. If enabled is false, all methods are no-ops.
// Log files are written to ~/.opencode/logs/proxy-debug.log with rotation on startup.
func NewDebugLogger(configDir string, enabled bool) *DebugLogger {
	dl := &DebugLogger{enabled: enabled}
	if !enabled {
		return dl
	}

	logDir := filepath.Join(configDir, "logs")
	if err := os.MkdirAll(logDir, 0700); err != nil {
		fmt.Fprintf(os.Stderr, "[proxy] warning: could not create log directory: %v\n", err)
		dl.enabled = false
		return dl
	}

	logPath := filepath.Join(logDir, "proxy-debug.log")

	// Rotate: if existing log is > 5MB, rename to .prev
	if info, err := os.Stat(logPath); err == nil && info.Size() > 5*1024*1024 {
		prevPath := logPath + ".prev"
		os.Remove(prevPath)
		os.Rename(logPath, prevPath)
	}

	f, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[proxy] warning: could not open debug log: %v\n", err)
		dl.enabled = false
		return dl
	}

	dl.file = f
	dl.Log("debug logging started (pid=%d)", os.Getpid())
	fmt.Fprintf(os.Stderr, "[proxy] debug logging to %s\n", logPath)
	return dl
}

// Log writes a formatted debug message with a timestamp.
func (dl *DebugLogger) Log(format string, args ...interface{}) {
	if !dl.enabled || dl.file == nil {
		return
	}
	msg := fmt.Sprintf(format, args...)
	ts := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")

	dl.mu.Lock()
	defer dl.mu.Unlock()
	fmt.Fprintf(dl.file, "%s  %s\n", ts, msg)
}

// Close flushes and closes the log file.
func (dl *DebugLogger) Close() {
	if dl.file != nil {
		dl.Log("debug logging stopped")
		dl.file.Close()
	}
}
