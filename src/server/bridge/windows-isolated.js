import { join } from 'node:path';

export const windowsIsolatedStartupTimeout = 90000;
// Cold Windows PowerShell/Add-Type startup precedes the native RPC lifetime.
// A separate bounded deadline prevents repeated recompilation at every RPC
// initialize timeout. No native request budget is extended by this handshake.
export function waitForWindowsIsolatedReady(proc, { timeoutMs = windowsIsolatedStartupTimeout } = {}) {
  return new Promise((resolve, reject) => {
    let buffer = '', discarding = false;
    const finish = error => {
      clearTimeout(timer);
      proc.stderr.off('data', data); proc.off('error', failed); proc.off('exit', exited); proc.off('close', exited);
      if (error) reject(error); else resolve();
    };
    const failed = () => finish(new Error('Windows native helper could not start'));
    const exited = () => finish(new Error('Windows native helper exited before readiness'));
    const data = chunk => {
      for (const part of String(chunk).split(/(?<=\n)/)) {
        const complete = part.endsWith('\n');
        if (!discarding) {
          buffer += part;
          if (buffer.length > 128) { buffer = ''; discarding = true; }
          else if (complete && buffer.trim() === '[codex-isolated:native-wait]') { finish(); return; }
        }
        if (complete) { buffer = ''; discarding = false; }
      }
    };
    const timer = setTimeout(() => finish(new Error('Windows native helper startup timed out')), timeoutMs);
    proc.stderr.on('data', data); proc.once('error', failed); proc.once('exit', exited); proc.once('close', exited);
    if (proc.exitCode != null || proc.signalCode != null) exited();
  });
}

// Windows has no Unix process group. This hidden helper first joins its own
// non-breakaway Job, then starts the native server, so even immediately spawned
// tools inherit ownership. The sole non-inheritable Job handle belongs to the
// helper: killing it, losing stdin, or the native root exiting closes the Job.
// Shared daemons never enter this path. Keep C# compatible with PowerShell 5.1.
export const windowsIsolatedSource = String.raw`
using System;
using System.ComponentModel;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

public static class CodexIsolatedJob {
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
        public uint ActiveProcesses;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters {
        public ulong ReadOperations, WriteOperations, OtherOperations;
        public ulong ReadBytes, WriteBytes, OtherBytes;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")]
    static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);
    static IntPtr ownedJob;

    static void CloseJob() {
        IntPtr handle = Interlocked.Exchange(ref ownedJob, IntPtr.Zero);
        if (handle != IntPtr.Zero) CloseHandle(handle);
    }

    // ProcessStartInfo on .NET Framework accepts a command-line string, not
    // ArgumentList. Quote each argv element using the Windows CRT convention;
    // no command or argument is ever interpreted by cmd.exe or PowerShell.
    public static string QuoteArgument(string value) {
        StringBuilder quoted = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') quoted.Append('\\', slashes * 2 + 1);
            else quoted.Append('\\', slashes);
            quoted.Append(c); slashes = 0;
        }
        quoted.Append('\\', slashes * 2); quoted.Append('"');
        return quoted.ToString();
    }

    // The reader never waits for the native writer. Otherwise native stdin
    // backpressure could hide EOF after the gateway dies. Saturation revokes
    // the Job rather than buffering without bound or losing request bytes.
    public static void RelayInput(Stream input, Stream output, Action revoke) {
        BlockingCollection<byte[]> pending = new BlockingCollection<byte[]>(2048);
        long buffered = 0;
        ThreadPool.QueueUserWorkItem(delegate(object ignored) {
            try {
                foreach (byte[] block in pending.GetConsumingEnumerable()) {
                    output.Write(block, 0, block.Length);
                    // .NET Framework's Process.StandardInput.BaseStream is
                    // buffered. Direct byte writes bypass StreamWriter's
                    // AutoFlush, so a short JSON-RPC must flush explicitly.
                    output.Flush();
                    Interlocked.Add(ref buffered, -block.Length);
                }
            }
            catch { revoke(); }
        });
        try {
            while (true) {
                byte[] block = new byte[65536];
                int count = input.Read(block, 0, block.Length);
                if (count == 0) return;
                if (count != block.Length) Array.Resize(ref block, count);
                if (Interlocked.Add(ref buffered, count) > 64L * 1024 * 1024 || !pending.TryAdd(block))
                    throw new IOException("Native stdin backlog exceeded its private buffer limit");
            }
        }
        finally { pending.CompleteAdding(); revoke(); }
    }

    public static int Run(string[] command, string directory) {
        string phase = "job-create";
        try {
            Console.Error.WriteLine("[codex-isolated:" + phase + "]");
            ownedJob = CreateJobObject(IntPtr.Zero, null);
            if (ownedJob == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObject failed");
            ExtendedLimits limits = new ExtendedLimits();
            limits.Basic.Flags = 0x00002000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE only: no breakaway.
            phase = "job-limits"; Console.Error.WriteLine("[codex-isolated:" + phase + "]");
            if (!SetInformationJobObject(ownedJob, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "SetInformationJobObject failed");
            // No native process exists until ownership succeeds. An inherited
            // outer job is retained; unsupported nesting fails closed.
            phase = "job-assign"; Console.Error.WriteLine("[codex-isolated:" + phase + "]");
            if (!AssignProcessToJobObject(ownedJob, GetCurrentProcess()))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "AssignProcessToJobObject failed");

            StringBuilder arguments = new StringBuilder();
            for (int i = 1; i < command.Length; i++) {
                if (i > 1) arguments.Append(' ');
                arguments.Append(QuoteArgument(command[i]));
            }
            ProcessStartInfo spec = new ProcessStartInfo(command[0], arguments.ToString());
            spec.WorkingDirectory = directory; spec.UseShellExecute = false;
            spec.CreateNoWindow = true;
            spec.RedirectStandardInput = spec.RedirectStandardOutput = spec.RedirectStandardError = true;
            Process native = new Process(); native.StartInfo = spec;
            phase = "native-start"; Console.Error.WriteLine("[codex-isolated:" + phase + "]");
            if (!native.Start()) throw new InvalidOperationException("Native server did not start");

            // Stream bytes directly: preserve UTF-8 and do not send PowerShell
            // object/line serialization through the JSON-RPC transport.
            Task output = native.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
            Task errors = native.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
            output.ContinueWith(delegate(Task task) { if (task.IsFaulted) CloseJob(); }, TaskScheduler.Default);
            errors.ContinueWith(delegate(Task task) { if (task.IsFaulted) CloseJob(); }, TaskScheduler.Default);
            ThreadPool.QueueUserWorkItem(delegate(object ignored) {
                try { RelayInput(Console.OpenStandardInput(), native.StandardInput.BaseStream, CloseJob); }
                catch { CloseJob(); }
            });
            // Wait only for the root, never the output pumps: a tool may hold
            // those pipes open, or close them and keep silently running.
            phase = "native-wait"; Console.Error.WriteLine("[codex-isolated:" + phase + "]");
            while (!native.WaitForExit(1000)) { }
            return native.ExitCode;
        }
        catch (Exception error) {
            Win32Exception nativeError = error as Win32Exception;
            Console.Error.WriteLine("[codex-isolated:" + phase + ":" + (nativeError == null ? 0 : nativeError.NativeErrorCode) + "]");
            Console.Error.WriteLine("[codex-isolated] " + error.Message);
            return 1;
        }
        finally { CloseJob(); }
    }
}
`;

export const windowsIsolatedScript = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $phase='compile'; try {
[Console]::Error.WriteLine('[codex-isolated:compile]');
Add-Type -Language CSharp -TypeDefinition @'
${windowsIsolatedSource}
'@
$phase='spec'; [Console]::Error.WriteLine('[codex-isolated:spec]');
$spec=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:CODEX_WEBUI_ISOLATED_SPEC))|ConvertFrom-Json;
Remove-Item Env:CODEX_WEBUI_ISOLATED_SPEC;
[Environment]::Exit([CodexIsolatedJob]::Run([string[]]$spec.command,[string]$spec.cwd));
} catch { [Console]::Error.WriteLine('[codex-isolated:'+$phase+':0]'); [Console]::Error.WriteLine('[codex-isolated] '+$_.Exception.Message); exit 1 }`;

export function windowsIsolatedProcess(command, cwd, env = process.env) {
  if (!Array.isArray(command) || !command.length || command.some(value => typeof value !== 'string' || value.includes('\0')) || !command[0]
      || typeof cwd !== 'string' || !cwd || cwd.includes('\0')) throw new Error('Invalid isolated process specification');
  return {
    binary: join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(windowsIsolatedScript, 'utf16le').toString('base64')],
    env: { ...env, CODEX_WEBUI_ISOLATED_SPEC: Buffer.from(JSON.stringify({ command, cwd }), 'utf8').toString('base64') },
  };
}
