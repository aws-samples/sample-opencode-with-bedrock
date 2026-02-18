//go:build windows

package proxy

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"unsafe"
)

var (
	modkernel32      = syscall.NewLazyDLL("kernel32.dll")
	procLockFileEx   = modkernel32.NewProc("LockFileEx")
	procUnlockFileEx = modkernel32.NewProc("UnlockFileEx")
)

const (
	lockfileExclusiveLock   = 0x00000002
	lockfileFailImmediately = 0x00000001
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

	// Lock the file using Windows LockFileEx
	var overlapped syscall.Overlapped
	r1, _, err := procLockFileEx.Call(
		file.Fd(),
		lockfileExclusiveLock,
		0,
		1,
		0,
		uintptr(unsafe.Pointer(&overlapped)),
	)
	if r1 == 0 {
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

	var overlapped syscall.Overlapped
	procUnlockFileEx.Call(
		lock.file.Fd(),
		0,
		1,
		0,
		uintptr(unsafe.Pointer(&overlapped)),
	)
	lock.file.Close()
}

// isProcessRunningOS checks if a process is running (Windows implementation)
// On Windows, we use OpenProcess to check if the process exists without signaling it
func isProcessRunningOS(process *os.Process) bool {
	// On Windows, FindProcess always succeeds regardless of whether the process exists.
	// We use OpenProcess with PROCESS_QUERY_LIMITED_INFORMATION to check existence
	// without affecting the process.
	const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
	modkernel32 := syscall.NewLazyDLL("kernel32.dll")
	procOpenProcess := modkernel32.NewProc("OpenProcess")
	procCloseHandle := modkernel32.NewProc("CloseHandle")

	handle, _, _ := procOpenProcess.Call(
		PROCESS_QUERY_LIMITED_INFORMATION,
		0,
		uintptr(process.Pid),
	)
	if handle == 0 {
		return false
	}
	procCloseHandle.Call(handle)
	return true
}

// terminateProcess terminates a process (Windows implementation)
func terminateProcess(process *os.Process) error {
	return process.Kill()
}
