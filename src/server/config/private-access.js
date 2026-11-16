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
  // Use .NET ACL APIs directly: no profile, Get-Acl autoload or inherited
  // PowerShell 7 module path is involved when running Windows PowerShell 5.1.
  const script = `$ErrorActionPreference='Stop'; $path=$env:CRW_ACL_PATH; $acl=if([System.IO.Directory]::Exists($path)){[System.IO.Directory]::GetAccessControl($path)}else{[System.IO.File]::GetAccessControl($path)}; $sid=[System.Security.Principal.SecurityIdentifier]; $user=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $owner=$acl.GetOwner($sid).Value; $allow=@(); foreach($rule in $acl.GetAccessRules($true,$true,$sid)){if($rule.AccessControlType -eq 'Allow'){$allow+=('"'+$rule.IdentityReference.Value+'"')}}; [Console]::WriteLine('{"user":"'+$user+'","owner":"'+$owner+'","allow":['+($allow -join ',')+']}')`;

  const executable = join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const output = execFileSync(executable, ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, CRW_ACL_PATH: path, PSModulePath: join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/Modules') }, encoding: 'utf8', timeout: 15000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(output);
}
