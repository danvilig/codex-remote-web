package main

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"
)

type terminalSession struct {
	read, write *os.File
	mu          sync.Mutex
	console     windows.Handle
	job         windows.Handle
	done        chan struct{}
	code        int
}

func terminalCommand(cwd string) *exec.Cmd {
	shell := getenvDefault("SHELL", "powershell.exe")
	if shell == "powershell.exe" {
		shell = filepath.Join(getenvDefault("SystemRoot", `C:\Windows`), "System32", "WindowsPowerShell", "v1.0", shell)
	}
	cmd := exec.Command(shell)
	cmd.Dir = cwd
	cmd.Env = append(os.Environ(), "TERM=xterm-256color", "COLORTERM=truecolor")
	return cmd
}

func startTerminal(cmd *exec.Cmd, cols, rows uint16) (_ *terminalSession, failure error) {
	if cmd.Err != nil {
		return nil, cmd.Err
	}
	consoleIn, input, err := windowsProcessPipe(false)
	if err != nil {
		return nil, err
	}
	defer consoleIn.Close()
	defer func() {
		if failure != nil {
			input.Close()
		}
	}()
	output, consoleOut, err := windowsProcessPipe(true)
	if err != nil {
		return nil, err
	}
	defer consoleOut.Close()
	defer func() {
		if failure != nil {
			output.Close()
		}
	}()
	var console windows.Handle
	if err = windows.CreatePseudoConsole(windows.Coord{X: int16(cols), Y: int16(rows)}, windows.Handle(consoleIn.Fd()), windows.Handle(consoleOut.Fd()), 0, &console); err != nil {
		return nil, err
	}
	defer func() {
		if failure != nil {
			output.Close()
			windows.ClosePseudoConsole(console)
		}
	}()
	job, err := createWindowsJob()
	if err != nil {
		return nil, err
	}
	defer func() {
		if failure != nil {
			windows.CloseHandle(job)
		}
	}()
	attrs, err := windows.NewProcThreadAttributeList(2)
	if err != nil {
		return nil, err
	}
	defer attrs.Delete()
	consolePtr := *(*unsafe.Pointer)(unsafe.Pointer(&console))
	if err = attrs.Update(windows.PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, consolePtr, unsafe.Sizeof(console)); err != nil {
		return nil, err
	}
	// Job assignment is part of CreateProcess. Descendants cannot start before
	// they are owned, and the shell receives no handles to the Job itself.
	const jobList = 0x0002000d // PROC_THREAD_ATTRIBUTE_JOB_LIST
	if err = attrs.Update(jobList, unsafe.Pointer(&job), unsafe.Sizeof(job)); err != nil {
		return nil, err
	}
	startup := windows.StartupInfoEx{ProcThreadAttributeList: attrs.List()}
	startup.Cb = uint32(unsafe.Sizeof(startup))
	// Leave the three handles null so Windows uses the pseudoconsole even
	// when the host's own standard streams are redirected.
	startup.Flags = windows.STARTF_USESTDHANDLES
	program, err := windows.UTF16PtrFromString(cmd.Path)
	if err != nil {
		return nil, err
	}
	commandLine, err := windows.UTF16PtrFromString(windows.ComposeCommandLine(cmd.Args))
	if err != nil {
		return nil, err
	}
	var dir *uint16
	if cmd.Dir != "" {
		if dir, err = windows.UTF16PtrFromString(cmd.Dir); err != nil {
			return nil, err
		}
	}
	env := utf16.Encode([]rune(strings.Join(cmd.Environ(), "\x00") + "\x00\x00"))
	var child windows.ProcessInformation
	if err = windows.CreateProcess(program, commandLine, nil, nil, false, windows.CREATE_UNICODE_ENVIRONMENT|windows.EXTENDED_STARTUPINFO_PRESENT,
		&env[0], dir, &startup.StartupInfo, &child); err != nil {
		return nil, err
	}
	_ = windows.CloseHandle(child.Thread)
	s := &terminalSession{read: output, write: input, console: console, job: job, done: make(chan struct{})}
	go func() {
		_, waitErr := windows.WaitForSingleObject(child.Process, windows.INFINITE)
		var status uint32
		if waitErr != nil || windows.GetExitCodeProcess(child.Process, &status) != nil {
			status = 1
		}
		s.code = int(status)
		_ = windows.CloseHandle(child.Process)
		s.mu.Lock()
		_ = windows.CloseHandle(s.job)
		s.job = 0
		console := s.console
		s.console = 0
		s.mu.Unlock()
		windows.ClosePseudoConsole(console)
		close(s.done)
	}()
	return s, nil
}

func (s *terminalSession) input() io.Writer  { return s.write }
func (s *terminalSession) output() io.Reader { return s.read }
func (s *terminalSession) exitStatus() int   { return s.code }

func (s *terminalSession) resize(cols, rows uint16) error {
	if cols < 20 || cols > 500 || rows < 5 || rows > 200 {
		return errors.New("Invalid terminal dimensions")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.console == 0 {
		return os.ErrClosed
	}
	return windows.ResizePseudoConsole(s.console, windows.Coord{X: int16(cols), Y: int16(rows)})
}

func (s *terminalSession) close() {
	// On Windows before 24H2 closing a pseudo console may wait for the
	// reader. Close the parent pipe first so a disconnected client can't hang.
	_ = s.read.Close()
	_ = s.write.Close()
	s.mu.Lock()
	if s.job != 0 {
		_ = windows.TerminateJobObject(s.job, 1)
	}
	s.mu.Unlock()
	<-s.done
}

func checkPTY() error {
	cmd := terminalCommand("")
	// Match the shell's native input, UTF-8 output, and post-resize state.
	cmd = exec.Command(cmd.Path, "-NoLogo", "-NoProfile", "-Command", `[Console]::WriteLine(('CRW_READY:{0}x{1}' -f [Console]::WindowWidth,[Console]::WindowHeight)); $line=[Console]::ReadLine(); [Console]::WriteLine(('CRW_RESULT:{0}x{1}:{2}' -f [Console]::WindowWidth,[Console]::WindowHeight,$line))`)
	s, err := startTerminal(cmd, 80, 24)
	if err != nil {
		return err
	}
	defer s.close()
	deadline := time.Now().Add(15 * time.Second)
	if err := s.read.SetReadDeadline(deadline); err != nil {
		return err
	}
	if err := s.write.SetWriteDeadline(deadline); err != nil {
		return err
	}
	reader := bufio.NewReader(s.output())
	check := func(want string) error {
		for {
			line, err := reader.ReadString('\n')
			if strings.Contains(line, want) {
				return nil
			}
			if err != nil {
				return fmt.Errorf("expected ConPTY output %q: %w", want, err)
			}
		}
	}
	if err := check("CRW_READY:80x24"); err != nil {
		return err
	}
	if err := s.resize(132, 41); err != nil {
		return err
	}
	if _, err := io.WriteString(s.input(), "probe-token\r"); err != nil {
		return err
	}
	return check("CRW_RESULT:132x41:probe-token")
}
