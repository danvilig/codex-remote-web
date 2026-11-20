//go:build darwin || linux

package main

import "os"

func exposeTestFile(path string) error { return os.Chmod(path, 0644) }
