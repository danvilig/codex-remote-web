import assert from 'node:assert/strict';
import { lstat, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { command } from './distribution.ts';

const bundledRuntime = /^(?:electron(?:\.exe)?|app\.asar(?:\.unpacked)?|chrome[-_]sandbox|chrome_\d+_percent\.pak|icudtl\.dat|snapshot_blob\.bin|v8_context_snapshot\.bin|node(?:\.exe)?|bun(?:\.exe)?|msedgewebview2\.exe|libwebkit2gtk[^/]*\.so(?:\.\d+)*|LICENSES\.chromium\.html|resources\.pak)$/i;
export const systemDesktopBudget = { installedBytes: 32_000_000, installerBytes: 16_000_000 };

export async function systemDesktopSize(directory: string) {
  let logicalBytes = 0, files = 0;
  async function walk(path: string) {
    const info = await lstat(path);
    assert.equal(info.isSymbolicLink(), false, `Unexpected desktop payload link: ${path}`);
    assert.equal(bundledRuntime.test(basename(path)), false, `Bundled browser or language runtime: ${path}`);
    if (info.isDirectory()) {
      for (const name of await readdir(path)) await walk(join(path, name));
    } else {
      assert.ok(info.isFile(), `Unexpected desktop payload file type: ${path}`);
      logicalBytes += info.size;
      files++;
    }
  }
  await walk(directory);
  assert.ok(files > 0 && logicalBytes > 0);
  assert.ok(logicalBytes < systemDesktopBudget.installedBytes, `Installed desktop payload is ${logicalBytes} bytes`);
  return { logicalBytes, files };
}

export async function installedSystemDesktopSize(directory: string) {
  const size = await systemDesktopSize(directory);
  let allocatedBytes: number;
  if (process.platform === 'win32') {
    // NTFS reports each file's real compressed size or its cluster allocation.
    const path = directory.replaceAll("'", "''");
    const script = `$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class DiskSize {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern UInt32 GetCompressedFileSize(string path, out UInt32 high);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool GetDiskFreeSpace(string root, out UInt32 sectors, out UInt32 bytes, out UInt32 free, out UInt32 total);
}
'@
$path = '${path}'
[uint32]$sectors=0; [uint32]$bytes=0; [uint32]$free=0; [uint32]$total=0
if (-not [DiskSize]::GetDiskFreeSpace([IO.Path]::GetPathRoot($path),[ref]$sectors,[ref]$bytes,[ref]$free,[ref]$total)) { throw 'Cannot measure disk allocation' }
$cluster = $sectors * $bytes
[long]$sum = 0
foreach ($file in (Get-ChildItem -LiteralPath $path -Recurse -File -Force)) {
  [uint32]$high = 0
  $low = [DiskSize]::GetCompressedFileSize($file.FullName,[ref]$high)
  if (($low -eq [uint32]::MaxValue) -and ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -ne 0)) { throw 'Cannot measure file allocation' }
  $length = ([long]$high * 4294967296) + $low
  $sum += [long]([Math]::Ceiling($length / $cluster) * $cluster)
}
Write-Output $sum`;
    allocatedBytes = Number(await command(['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], directory, { timeoutMs: 45_000 }));
  } else {
    allocatedBytes = Number((await command(['du', '-B1', '-s', '--', directory], directory)).split(/\s+/, 1)[0]);
  }
  assert.ok(Number.isSafeInteger(allocatedBytes) && allocatedBytes > 0 && allocatedBytes < systemDesktopBudget.installedBytes, `Installed desktop allocation is ${allocatedBytes} bytes`);
  return { ...size, allocatedBytes };
}
