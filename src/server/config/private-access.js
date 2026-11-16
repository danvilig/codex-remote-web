import { execFileSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';

export function privateWindowsAcl(acl) {
  if (!acl || !/^S-1-5-21-(?:\d+-){3}\d+$/.test(acl.user || '') || ![acl.user, 'S-1-5-18', 'S-1-5-32-544'].includes(acl.owner) || !Array.isArray(acl.allow) || !acl.allow.length) return false;
  return acl.allow.every(sid => [acl.user, 'S-1-5-18', 'S-1-5-32-544'].includes(sid));
}
// Windows chmod/uid bits do not express confidentiality. Inspect the NTFS DACL
// and owner instead; never treat the absence of POSIX IDs as permission to skip
// safety checks. Unknown ACLs, reparse points and failed inspection fail closed.
export function privateAccess(stat, path) {
  if (process.platform !== 'win32') return stat.uid === process.getuid?.() && !(stat.mode & 0o077);
  try {
    const link = lstatSync(path);
    if (link.isSymbolicLink() || link.ino !== stat.ino || link.dev !== stat.dev) return false;
    return privateWindowsAcl(inspectWindowsAcl(path));
  } catch { return false; }
}
export function inspectWindowsAcl(path) {
  const script = "$ErrorActionPreference='Stop'; $acl=Get-Acl -LiteralPath $env:CRW_ACL_PATH; $sid=[System.Security.Principal.SecurityIdentifier]; $user=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $owner=$acl.GetOwner($sid).Value; $allow=@($acl.GetAccessRules($true,$true,$sid) | Where-Object { $_.AccessControlType -eq 'Allow' } | ForEach-Object { $_.IdentityReference.Value }); @{ user=$user; owner=$owner; allow=$allow } | ConvertTo-Json -Compress";
  const executable = join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const output = execFileSync(executable, ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, CRW_ACL_PATH: path }, encoding: 'utf8', timeout: 10000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(output);
}
