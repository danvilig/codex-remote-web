package main

import (
	"crypto/rand"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

func conversationStamp(pid int) string {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return ""
	}
	defer windows.CloseHandle(h)
	var created, exited, kernel, user windows.Filetime
	if windows.GetProcessTimes(h, &created, &exited, &kernel, &user) != nil {
		return ""
	}
	return strconv.FormatUint(uint64(created.HighDateTime)<<32|uint64(created.LowDateTime), 10)
}

func processMissing(pid int) bool {
	h, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		return errors.Is(err, windows.ERROR_INVALID_PARAMETER)
	}
	defer windows.CloseHandle(h)
	status, err := windows.WaitForSingleObject(h, 0)
	return err == nil && status == windows.WAIT_OBJECT_0
}

func processAlive(pid int, stamp string) bool {
	if processMissing(pid) {
		return false
	}
	current := conversationStamp(pid)
	return stamp == "" || current == "" || stamp == current
}

const windowsOwnedWorker = "CRW_PRIVATE_OWNED_WINDOWS_WORKER"

func configureOwnedCommand(cmd *exec.Cmd) error {
	if cmd.Err != nil {
		return cmd.Err
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	stamp := conversationStamp(os.Getpid())
	if stamp == "" {
		return errors.New("Cannot verify native process supervisor identity")
	}
	cmd.Args = append([]string{exe, "windows-owned-process", strconv.Itoa(os.Getpid()), stamp, cmd.Path}, cmd.Args[1:]...)
	cmd.Path = exe
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
	return nil
}

func stopOwnedCommand(cmd *exec.Cmd, force bool) error {
	if force {
		return cmd.Process.Kill()
	}
	// The supervisor's stdin has been closed by its owner. Let it exit and
	// close its Job before the caller's bounded force-stop deadline.
	return nil
}

var isProcessInJob = windows.NewLazySystemDLL("kernel32.dll").NewProc("IsProcessInJob")

func workerOwnsProcess() bool {
	if os.Getenv(windowsOwnedWorker) != "1" {
		return false
	}
	var inJob uint32
	ok, _, _ := isProcessInJob.Call(uintptr(windows.CurrentProcess()), 0, uintptr(unsafe.Pointer(&inJob)))
	return ok != 0 && inJob != 0
}
func gracefulOwnedWorker() bool { return false }
func stopOwnedWorker(bool)      {}
func finishOwnedWorker()        {}

func createWindowsJob() (windows.Handle, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return 0, err
	}
	var limits windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
	limits.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err = windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&limits)), uint32(unsafe.Sizeof(limits))); err != nil {
		windows.CloseHandle(job)
		return 0, err
	}
	return job, nil
}

func runPlatformCommand(name string, args []string) (bool, error) {
	if name != "windows-owned-process" {
		return false, nil
	}
	if len(args) < 3 {
		return true, errors.New("Missing native process command")
	}
	parentPID, err := strconv.ParseUint(args[0], 10, 32)
	if err != nil || parentPID == 0 || args[1] == "" {
		return true, errors.New("Invalid native process supervisor identity")
	}
	parent, err := windows.OpenProcess(windows.SYNCHRONIZE|windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(parentPID))
	if err != nil {
		return true, err
	}
	var created, exited, kernel, user windows.Filetime
	status, err := windows.WaitForSingleObject(parent, 0)
	if err != nil || status != uint32(windows.WAIT_TIMEOUT) || windows.GetProcessTimes(parent, &created, &exited, &kernel, &user) != nil || args[1] != strconv.FormatUint(uint64(created.HighDateTime)<<32|uint64(created.LowDateTime), 10) {
		windows.CloseHandle(parent)
		return true, errors.New("Native process supervisor exited")
	}
	job, err := createWindowsJob()
	if err != nil {
		windows.CloseHandle(parent)
		return true, err
	}
	// Join before starting the child so the child's earliest descendants
	// inherit the job. The sole handle stays with this helper until exit.
	if err := windows.AssignProcessToJobObject(job, windows.CurrentProcess()); err != nil {
		windows.CloseHandle(job)
		windows.CloseHandle(parent)
		return true, err
	}
	go func() {
		_, _ = windows.WaitForSingleObject(parent, windows.INFINITE)
		os.Exit(1)
	}()
	cmd := exec.Command(args[2], args[3:]...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	cmd.Env = append(os.Environ(), windowsOwnedWorker+"=1")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
	return true, cmd.Run()
}

func codexCommand(binary string, args ...string) (*exec.Cmd, error) {
	resolved, err := exec.LookPath(binary)
	if err != nil {
		return nil, err
	}
	extension := strings.ToLower(filepath.Ext(resolved))
	if extension != ".cmd" && extension != ".bat" {
		return exec.Command(resolved, args...), nil
	}
	base := filepath.Dir(resolved)
	for _, relative := range []string{"node_modules/@openai/codex/bin/codex.js", "../@openai/codex/bin/codex.js"} {
		entry := filepath.Join(base, filepath.FromSlash(relative))
		if info, err := os.Stat(entry); err == nil && info.Mode().IsRegular() {
			node := os.Getenv("CODEX_WEBUI_NODE")
			if node == "" {
				node = filepath.Join(base, "node.exe")
				if _, err := exec.LookPath(node); err != nil {
					node = "node.exe"
				}
			}
			return exec.Command(node, append([]string{entry}, args...)...), nil
		}
	}
	return nil, errors.New("Cannot resolve the npm Codex CLI entry. Install @openai/codex or place codex.exe on PATH.")
}

func desktopPathEntries(home string) []string {
	return []string{filepath.Join(home, ".local", "bin"), filepath.Join(os.Getenv("APPDATA"), "npm")}
}

func desktopPlatformEnv() []string {
	return []string{"SystemRoot", "SystemDrive", "ComSpec", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "PATHEXT", "CODEX_WEBUI_NODE"}
}

func isolatedInputPipe() (*os.File, *os.File, error) {
	return windowsProcessPipe(false)
}

func windowsProcessPipe(parentReads bool) (*os.File, *os.File, error) {
	const namePrefix = `\\.\pipe\codex-remote-web-stdio-`
	name, err := windows.UTF16PtrFromString(namePrefix + rand.Text())
	if err != nil {
		return nil, nil, err
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return nil, nil, err
	}
	sd, err := windows.SecurityDescriptorFromString("D:P(A;;GA;;;" + user.User.Sid.String() + ")")
	if err != nil {
		return nil, nil, err
	}
	sa := windows.SecurityAttributes{SecurityDescriptor: sd}
	sa.Length = uint32(unsafe.Sizeof(sa))
	// Parent IO must be overlapped for bounded RPC writes, but the inheritable
	// read end must use blocking IO like a normal child stdin.
	mode, access := uint32(windows.PIPE_ACCESS_OUTBOUND), uint32(windows.GENERIC_READ)
	if parentReads {
		mode, access = windows.PIPE_ACCESS_INBOUND, windows.GENERIC_WRITE
	}
	server, err := windows.CreateNamedPipe(name, mode|windows.FILE_FLAG_FIRST_PIPE_INSTANCE|windows.FILE_FLAG_OVERLAPPED,
		windows.PIPE_TYPE_BYTE|windows.PIPE_REJECT_REMOTE_CLIENTS, 1, 65536, 65536, 0, &sa)
	if err != nil {
		return nil, nil, err
	}
	client, err := windows.CreateFile(name, access, 0, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err == nil {
		err = windows.ConnectNamedPipe(server, &windows.Overlapped{})
		if err == nil || errors.Is(err, windows.ERROR_PIPE_CONNECTED) {
			clientFile := os.NewFile(uintptr(client), "process-pipe-client")
			serverFile := os.NewFile(uintptr(server), "process-pipe-server")
			if parentReads {
				return serverFile, clientFile, nil
			}
			return clientFile, serverFile, nil
		}
		windows.CloseHandle(client)
	}
	windows.CloseHandle(server)
	return nil, nil, err
}
