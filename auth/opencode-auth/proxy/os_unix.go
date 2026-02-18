//go:build !windows

package proxy

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

// acquireFileLock acquires an exclusive lock on the specified file
func acquireFileLock(path string) (*FileLock, error) {
	// Ensure directory exists
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, fmt.Errorf("failed to create lock directory: %w", err)
	}

	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, fmt.Errorf("failed to open lock file: %w", err)
	}

	// Try to acquire exclusive lock (blocks until available)
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX); err != nil {
		file.Close()
		return nil, fmt.Errorf("failed to acquire lock: %w", err)
	}

	return &FileLock{path: path, file: file}, nil
}

// releaseFileLock releases the file lock
func releaseFileLock(lock *FileLock) {
	if lock == nil || lock.file == nil {
		return
	}
	syscall.Flock(int(lock.file.Fd()), syscall.LOCK_UN)
	lock.file.Close()
}

// isProcessRunningOS checks if a process is running (Unix implementation)
func isProcessRunningOS(process *os.Process) bool {
	err := process.Signal(syscall.Signal(0))
	return err == nil
}

// terminateProcess sends SIGTERM to a process (Unix implementation)
func terminateProcess(process *os.Process) error {
	return process.Signal(syscall.SIGTERM)
}
