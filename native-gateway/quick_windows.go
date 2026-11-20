package main

import (
	"crypto/rand"
	"encoding/hex"
	"net"
	"os"
	"path/filepath"
)

func tryQuickLock(f *os.File) bool {
	locked, _ := trySQLiteLock(f)
	return locked
}

func quickPlatformReady(string) bool { return true }
func quickPlatformEnv() []string     { return []string{"SystemRoot", "TEMP", "TMP", "PATHEXT"} }

func quickTemp() (string, error) {
	dir := filepath.Join(os.TempDir(), "crw-quick-"+rand.Text())
	return dir, ensureDesktopDirectory(dir)
}

func quickListener(string) (net.Listener, string, map[string]any, error) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return nil, "", nil, err
	}
	var token [24]byte
	_, _ = rand.Read(token[:])
	host := hex.EncodeToString(token[:]) + ".localhost"
	rule := map[string]any{
		"service":       "http://" + listener.Addr().String(),
		"originRequest": map[string]string{"httpHostHeader": host},
	}
	return listener, host, rule, nil
}
