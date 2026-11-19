package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"time"
)

const desktopStateLimit = 256 << 10

type desktopError struct {
	Message string `json:"error"`
	Code    string `json:"code,omitempty"`
	Status  int    `json:"-"`
}

func (e *desktopError) Error() string { return e.Message }
func desktopFailure(status int, code, message string) error {
	return &desktopError{Message: message, Code: code, Status: status}
}

func desktopErrorCode(err error) string {
	var failure *desktopError
	if errors.As(err, &failure) {
		return failure.Code
	}
	return ""
}

func desktopDirectory(home string) string {
	return filepath.Join(home, ".config", "codex-remote-web", "desktop")
}

func desktopOwned(info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && stat.Uid == uint32(os.Getuid())
}

func ensureDesktopDirectory(directory string) error {
	if err := os.MkdirAll(directory, 0700); err != nil {
		return err
	}
	info, err := os.Lstat(directory)
	if err != nil {
		return err
	}
	if !info.IsDir() || !desktopOwned(info) || info.Mode().Perm()&0077 != 0 {
		return errors.New("Desktop state must be in a private local directory")
	}
	return nil
}

func desktopOpen(path string, flags, limit int, private bool) (*os.File, error) {
	fd, err := syscall.Open(path, flags|syscall.O_NOFOLLOW|syscall.O_CLOEXEC|syscall.O_NONBLOCK, 0600)
	if err != nil {
		if errors.Is(err, syscall.ELOOP) {
			return nil, errors.New("Unsafe desktop state file")
		}
		return nil, err
	}
	file := os.NewFile(uintptr(fd), path)
	info, err := file.Stat()
	if err == nil {
		if !info.Mode().IsRegular() || !desktopOwned(info) || info.Sys().(*syscall.Stat_t).Nlink != 1 || info.Size() > int64(limit) || (private && info.Mode().Perm()&0077 != 0) {
			err = errors.New("Unsafe desktop state file")
		}
	}
	if err != nil {
		file.Close()
		return nil, err
	}
	return file, nil
}

func readDesktopFile(path string, private bool) ([]byte, error) {
	file, err := desktopOpen(path, syscall.O_RDONLY, desktopStateLimit, private)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, desktopStateLimit+1))
	if len(data) > desktopStateLimit {
		return nil, errors.New("Desktop state file is too large")
	}
	if data == nil && err == nil {
		data = []byte{}
	}
	return data, err
}

func readDesktopJSON(path string, dest any) (bool, error) {
	data, err := readDesktopFile(path, true)
	if err != nil || data == nil {
		return false, err
	}
	if err := json.Unmarshal(data, dest); err != nil || bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		return false, errors.New("Invalid desktop state file")
	}
	return true, nil
}

func syncDesktopDirectory(path string) error {
	dir, err := os.Open(path)
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}

func writeDesktopFile(path string, data []byte) error {
	directory := filepath.Dir(path)
	file, err := os.CreateTemp(directory, ".codex-desktop-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	defer file.Close()
	if _, err := file.Write(data); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	if err := os.Rename(file.Name(), path); err != nil {
		return err
	}
	return syncDesktopDirectory(directory)
}

func writeDesktopJSON(path string, value any) error {
	if err := ensureDesktopDirectory(filepath.Dir(path)); err != nil {
		return err
	}
	var previous json.RawMessage
	if _, err := readDesktopJSON(path, &previous); err != nil {
		return err
	}
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	if len(data)+1 > desktopStateLimit {
		return errors.New("Desktop state is too large")
	}
	return writeDesktopFile(path, append(data, '\n'))
}

func removeDesktopFile(path string) error {
	err := os.Remove(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	return syncDesktopDirectory(filepath.Dir(path))
}

var desktopLocks = struct {
	sync.Mutex
	held map[string]bool
}{held: make(map[string]bool)}

// The old agent holds SQLite's BEGIN IMMEDIATE transaction in this stable
// inode. Claim the same POSIX lock range without loading SQLite. Using flock
// here would let an old agent and a native agent both become owners.
func lockDesktop(directory, name string, timeout time.Duration) (func(), error) {
	directory, err := filepath.EvalSymlinks(directory)
	if err != nil {
		return nil, err
	}
	path := filepath.Join(directory, name+".sqlite")
	deadline := time.Now().Add(timeout)
	busy := func() error {
		return desktopFailure(409, "PRIVATE_LOCK_BUSY", "Private storage is busy. Retry shortly.")
	}
	for {
		desktopLocks.Lock()
		if !desktopLocks.held[path] {
			desktopLocks.held[path] = true
			desktopLocks.Unlock()
			break
		}
		desktopLocks.Unlock()
		if !time.Now().Before(deadline) {
			return nil, busy()
		}
		time.Sleep(10 * time.Millisecond)
	}
	forget := func() {
		desktopLocks.Lock()
		delete(desktopLocks.held, path)
		desktopLocks.Unlock()
	}
	file, err := desktopOpen(path, syscall.O_RDWR|syscall.O_CREAT, 1<<20, true)
	if err != nil {
		forget()
		return nil, err
	}
	lock := syscall.Flock_t{Type: syscall.F_WRLCK, Whence: io.SeekStart, Start: 0x40000000, Len: 512}
	for {
		err = syscall.FcntlFlock(file.Fd(), syscall.F_SETLK, &lock)
		if err == nil {
			return sync.OnceFunc(func() { file.Close(); forget() }), nil
		}
		if !errors.Is(err, syscall.EACCES) && !errors.Is(err, syscall.EAGAIN) && !errors.Is(err, syscall.EINTR) {
			file.Close()
			forget()
			return nil, fmt.Errorf("Desktop lock: %w", err)
		}
		if !time.Now().Before(deadline) {
			file.Close()
			forget()
			return nil, busy()
		}
		time.Sleep(10 * time.Millisecond)
	}
}
