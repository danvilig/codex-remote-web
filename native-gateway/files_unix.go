//go:build darwin || linux

package main

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"syscall"
)

const noFollow = syscall.O_NOFOLLOW
const noBlock = syscall.O_NONBLOCK

func fileIdentity(f *os.File, info os.FileInfo) (device, inode uint64, links uint32, ok bool) {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, 0, 0, false
	}
	return uint64(stat.Dev), uint64(stat.Ino), uint32(stat.Nlink), true
}

func desktopOwned(_ string, info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && stat.Uid == uint32(os.Getuid())
}

func fileOwned(_ *os.File, info os.FileInfo, forbidden os.FileMode) bool {
	return desktopOwned("", info) && info.Mode().Perm()&forbidden == 0
}

func openDesktopNoFollow(path string, flags int) (*os.File, error) {
	fd, err := syscall.Open(path, flags|noFollow|syscall.O_CLOEXEC|noBlock, 0600)
	if errors.Is(err, syscall.ELOOP) {
		return nil, errors.New("Unsafe desktop state file")
	}
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(fd), path), nil
}

func makePrivateDirectory(path string) error { return os.MkdirAll(path, 0700) }

func syncDesktopDirectory(path string) error {
	dir, err := os.Open(path)
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}

func trySQLiteLock(file *os.File) (bool, error) {
	lock := syscall.Flock_t{Type: syscall.F_WRLCK, Whence: io.SeekStart, Start: 0x40000000, Len: 512}
	err := syscall.FcntlFlock(file.Fd(), syscall.F_SETLK, &lock)
	if errors.Is(err, syscall.EACCES) || errors.Is(err, syscall.EAGAIN) || errors.Is(err, syscall.EINTR) {
		return false, nil
	}
	return err == nil, err
}

func canWriteDocument(_ *os.Root, _ string, path string, info os.FileInfo) bool {
	const accessWrite = 2
	return info.Mode().Perm()&0222 != 0 && syscall.Access(path, accessWrite) == nil && syscall.Access(filepath.Dir(path), accessWrite) == nil
}
