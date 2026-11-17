param([Parameter(Mandatory=$true)][string]$Source)
$ErrorActionPreference='Stop'
# Runs on a disposable Linux PowerShell host too; never invokes Windows APIs.
Add-Type -Path $Source -CompilerOptions '/langversion:5'
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Threading;
public class BlockedSink : Stream {
 public ManualResetEvent Entered = new ManualResetEvent(false);
 public ManualResetEvent Release = new ManualResetEvent(false);
 public override bool CanRead {get{return false;}} public override bool CanSeek {get{return false;}} public override bool CanWrite {get{return true;}}
 public override long Length {get{throw new NotSupportedException();}} public override long Position {get{throw new NotSupportedException();}set{throw new NotSupportedException();}}
 public override void Flush(){} public override int Read(byte[] b,int o,int n){throw new NotSupportedException();}
 public override long Seek(long n,SeekOrigin o){throw new NotSupportedException();} public override void SetLength(long n){throw new NotSupportedException();}
 public override void Write(byte[] b,int o,int n){Entered.Set();Release.WaitOne();}
}
public class GatedInput : Stream {
 readonly byte[] bytes; readonly WaitHandle proceed; bool sent;
 public GatedInput(byte[] data, WaitHandle gate){bytes=data;proceed=gate;}
 public override bool CanRead {get{return true;}} public override bool CanSeek {get{return false;}} public override bool CanWrite {get{return false;}}
 public override long Length {get{throw new NotSupportedException();}} public override long Position {get{throw new NotSupportedException();}set{throw new NotSupportedException();}}
 public override void Flush(){} public override void Write(byte[] b,int o,int n){throw new NotSupportedException();}
 public override long Seek(long n,SeekOrigin o){throw new NotSupportedException();} public override void SetLength(long n){throw new NotSupportedException();}
 public override int Read(byte[] b,int o,int n){if(sent){if(!proceed.WaitOne(5000))throw new Exception("Writer never entered before EOF");return 0;}sent=true;Buffer.BlockCopy(bytes,0,b,o,bytes.Length);return bytes.Length;}
}
public class ObservedSink : MemoryStream {
 public ManualResetEvent Written = new ManualResetEvent(false);
 public override void Write(byte[] b,int o,int n){base.Write(b,o,n);Written.Set();}
}
'@ -CompilerOptions '/langversion:5'
$cases=@('', 'hello world','汉字','a"b','end\','\\"x\')
foreach($text in $cases){$quoted=[CodexIsolatedJob]::QuoteArgument($text); if(!$quoted.StartsWith('"') -or !$quoted.EndsWith('"')){throw 'unquoted argument'}; Write-Host ('quoted '+$quoted)}
# Pass the callback as managed Action via closed-over synchronization object.
$sink=[BlockedSink]::new()
$bytes=[byte[]]::new(8192)
$input=[GatedInput]::new($bytes,$sink.Entered)
# C# helper makes callbacks run without a PowerShell runspace on worker threads.
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Reflection;
using System.Threading;
public static class RelayHarness {
 public static void CheckBuffered(Type job, Stream input, Stream output, WaitHandle delivered) {
  // Keep gateway stdin open until the short request reaches the underlying
  // pipe sink. StreamWriter.AutoFlush does not apply to BaseStream writes.
  Exception problem=null;
  Thread reader=new Thread(delegate(){try{job.GetMethod("RelayInput").Invoke(null,new object[]{input,output,new Action(delegate(){})});}catch(Exception e){problem=e;}});
  reader.IsBackground=true;reader.Start();
  if(!delivered.WaitOne(5000))throw new Exception("Short JSON-RPC remained buffered while gateway input stayed open");
  if(!reader.Join(1000))throw new Exception("Buffered relay failed to finish after delivered input EOF");
  if(problem!=null)throw problem;
 }
 public static void Check(Type job, Stream input, Stream output, bool throws) {
  ManualResetEvent revoked=new ManualResetEvent(false); Exception problem=null;
  Thread thread=new Thread(delegate(){try{job.GetMethod("RelayInput").Invoke(null,new object[]{input,output,new Action(delegate(){revoked.Set();})});}catch(Exception e){problem=e;}});
  thread.IsBackground=true; thread.Start();
  if(!revoked.WaitOne(5000))throw new Exception("EOF/backlog did not revoke job while writer was blocked");
  if(!thread.Join(1000))throw new Exception("Reader waited for blocked writer");
  if(throws && problem==null)throw new Exception("Expected saturation error");
  if(!throws && problem!=null)throw problem;
 }
}
'@ -CompilerOptions '/langversion:5'
[RelayHarness]::Check([CodexIsolatedJob],$input,$sink,$false)
if(!$sink.Entered.WaitOne(0)){throw 'Writer was never blocked'}
$sink.Release.Set()|Out-Null
Write-Host 'PASS: actual C# RelayInput detects EOF despite blocked native writer'
$large=[IO.MemoryStream]::new([byte[]]::new(70*1024*1024))
$sink2=[BlockedSink]::new()
[RelayHarness]::Check([CodexIsolatedJob],$large,$sink2,$true)
if($large.Position -ne (64*1024*1024+65536)){throw ('Unexpected pending byte limit: '+$large.Position)}
$sink2.Release.Set()|Out-Null
Write-Host 'PASS: actual C# RelayInput fails closed at bounded backlog'
$utf8=[Text.Encoding]::UTF8.GetBytes('Unicode 原始 UTF8 '+[char]0+' with trailing bytes')
$observed=[ObservedSink]::new()
$gated=[GatedInput]::new($utf8,$observed.Written)
[RelayHarness]::Check([CodexIsolatedJob],$gated,$observed,$false)
$copied=$observed.ToArray()
if([Convert]::ToBase64String($copied) -cne [Convert]::ToBase64String($utf8)){throw 'Byte relay changed input'}
Write-Host 'PASS: production C# RelayInput preserves raw UTF8 and zero bytes before EOF'
$short=[Text.Encoding]::UTF8.GetBytes('{"id":1,"method":"initialize","params":{}}'+[char]10)
$pipeSink=[ObservedSink]::new()
$nativeInput=[IO.BufferedStream]::new($pipeSink,4096)
$gatewayInput=[GatedInput]::new($short,$pipeSink.Written)
[RelayHarness]::CheckBuffered([CodexIsolatedJob],$gatewayInput,$nativeInput,$pipeSink.Written)
if([Convert]::ToBase64String($pipeSink.ToArray()) -cne [Convert]::ToBase64String($short)){throw 'Buffered stdin changed the short JSON-RPC'}
Write-Host 'PASS: short JSON-RPC flushes through buffered native stdin while gateway input remains open'
# Use the supplied Node runtime as an argv dumper. No shell is involved.
$expected=@('', 'hello world', '汉字', 'a"b', 'end\', '\\"x\', '$(echo injected); & | %PATH%')
$dump=[Diagnostics.ProcessStartInfo]::new($env:CODEX_WEBUI_TEST_NODE)
$dump.UseShellExecute=$false
$dump.RedirectStandardOutput=$true
$argv=@('-e','process.stdout.write(JSON.stringify(process.argv.slice(1)))','--')+$expected
$dump.Arguments=($argv|ForEach-Object{[CodexIsolatedJob]::QuoteArgument($_)}) -join ' '
$p=[Diagnostics.Process]::Start($dump)
$received=$p.StandardOutput.ReadToEnd()|ConvertFrom-Json
$p.WaitForExit()
if($p.ExitCode -ne 0 -or $received.Count -ne $expected.Count){throw 'argv count failed'}
for($i=0;$i -lt $expected.Count;$i++){if($received[$i] -cne $expected[$i]){throw ('argv mismatch '+$i)}}
Write-Host 'PASS: production C# quoting round-trips empty Unicode quotes trailing slash and shell metacharacters through real ProcessStartInfo'
