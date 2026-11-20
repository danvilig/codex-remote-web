package main

import (
	"errors"
	"os"
	"path/filepath"
	"unsafe"

	"golang.org/x/sys/windows"
)

const noFollow = windows.FILE_FLAG_OPEN_REPARSE_POINT
const noBlock = 0

func fileIdentity(f *os.File, _ os.FileInfo) (device, inode uint64, links uint32, ok bool) {
	var data windows.ByHandleFileInformation
	if windows.GetFileInformationByHandle(windows.Handle(f.Fd()), &data) != nil || data.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return 0, 0, 0, false
	}
	return uint64(data.VolumeSerialNumber), uint64(data.FileIndexHigh)<<32 | uint64(data.FileIndexLow), data.NumberOfLinks, true
}

func windowsFile(path string, access, disposition uint32) (windows.Handle, error) {
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return windows.InvalidHandle, err
	}
	return windows.CreateFile(name, access, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil, disposition, noFollow|windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
}

func desktopOwned(path string, info os.FileInfo) bool {
	f, err := openDesktopNoFollow(path, os.O_RDONLY)
	if err != nil {
		return false
	}
	defer f.Close()
	actual, err := f.Stat()
	return err == nil && os.SameFile(info, actual) && fileOwned(f, actual, 0)
}

func fileOwned(f *os.File, info os.FileInfo, forbidden os.FileMode) bool {
	if _, _, _, safe := fileIdentity(f, info); !safe {
		return false
	}
	sd, err := windows.GetSecurityInfo(windows.Handle(f.Fd()), windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return false
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return false
	}
	trusted := func(sid *windows.SID) bool {
		return sid != nil && sid.IsValid() && (sid.Equals(user.User.Sid) || sid.IsWellKnown(windows.WinLocalSystemSid) || sid.IsWellKnown(windows.WinBuiltinAdministratorsSid))
	}
	owner, _, err := sd.Owner()
	if err != nil || !trusted(owner) {
		return false
	}
	if forbidden == 0 {
		return true
	}
	acl, _, err := sd.DACL()
	if err != nil || acl == nil || acl.AceCount == 0 {
		return false
	}
	const accessAllowedACE = 0
	const accessDeniedACE = 1
	const fileDeleteChild = 0x0040
	const writeAccess = windows.FILE_WRITE_DATA | windows.FILE_APPEND_DATA | windows.FILE_WRITE_ATTRIBUTES | windows.FILE_WRITE_EA |
		fileDeleteChild | windows.DELETE | windows.WRITE_DAC | windows.WRITE_OWNER | windows.GENERIC_WRITE | windows.GENERIC_ALL | windows.MAXIMUM_ALLOWED
	allowed := false
	for i := uint32(0); i < uint32(acl.AceCount); i++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if windows.GetAce(acl, i, &ace) != nil || ace == nil {
			return false
		}
		switch ace.Header.AceType {
		case accessDeniedACE:
			continue
		case accessAllowedACE:
			allowed = true
			sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
			if !trusted(sid) && (forbidden != 0022 || ace.Mask&writeAccess != 0) {
				return false
			}
		default:
			// Reject object, callback, and unknown ACEs instead of ignoring a grant.
			return false
		}
	}
	return allowed
}

func openDesktopNoFollow(path string, flags int) (*os.File, error) {
	disposition := uint32(windows.OPEN_EXISTING)
	if flags&(os.O_CREATE|os.O_EXCL) == os.O_CREATE|os.O_EXCL {
		disposition = windows.CREATE_NEW
	} else if flags&os.O_CREATE != 0 {
		disposition = windows.OPEN_ALWAYS
	}
	access := uint32(windows.GENERIC_READ)
	if flags&(os.O_WRONLY|os.O_RDWR) != 0 {
		access |= windows.GENERIC_WRITE
	}
	h, err := windowsFile(path, access, disposition)
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: path, Err: err}
	}
	return os.NewFile(uintptr(h), path), nil
}

func makePrivateDirectory(path string) error {
	if info, err := os.Lstat(path); err == nil {
		if !info.IsDir() {
			return &os.PathError{Op: "mkdir", Path: path, Err: windows.ERROR_DIRECTORY}
		}
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return err
	}
	sd, err := windows.SecurityDescriptorFromString("O:" + user.User.Sid.String() + "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;" + user.User.Sid.String() + ")")
	if err != nil {
		return err
	}
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	sa := windows.SecurityAttributes{SecurityDescriptor: sd}
	sa.Length = uint32(unsafe.Sizeof(sa))
	err = windows.CreateDirectory(name, &sa)
	if errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
		if info, statErr := os.Lstat(path); statErr == nil && info.IsDir() {
			return nil
		}
	}
	return err
}

// Windows doesn't support flushing a directory handle. The file is flushed
// before replacement, matching the legacy gateway's durability contract.
func syncDesktopDirectory(string) error { return nil }

func trySQLiteLock(file *os.File) (bool, error) {
	overlap := windows.Overlapped{Offset: 0x40000000}
	err := windows.LockFileEx(windows.Handle(file.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 512, 0, &overlap)
	if errors.Is(err, windows.ERROR_LOCK_VIOLATION) || errors.Is(err, windows.ERROR_IO_PENDING) {
		return false, nil
	}
	return err == nil, err
}

func canWriteDocument(root *os.Root, name, path string, info os.FileInfo) bool {
	writable, err := root.OpenFile(name, os.O_WRONLY|noFollow, 0)
	if err != nil {
		return false
	}
	defer writable.Close()
	current, err := writable.Stat()
	if err != nil || !os.SameFile(current, info) {
		return false
	}
	// FILE_ADD_FILE has the same access bit as FILE_WRITE_DATA.
	dir, err := windowsFile(filepath.Dir(path), windows.FILE_WRITE_DATA|windows.FILE_READ_ATTRIBUTES, windows.OPEN_EXISTING)
	if err != nil {
		return false
	}
	defer windows.CloseHandle(dir)
	var stat windows.ByHandleFileInformation
	return windows.GetFileInformationByHandle(dir, &stat) == nil && stat.FileAttributes&(windows.FILE_ATTRIBUTE_DIRECTORY|windows.FILE_ATTRIBUTE_REPARSE_POINT) == windows.FILE_ATTRIBUTE_DIRECTORY
}
