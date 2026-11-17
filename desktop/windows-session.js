import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

const exec = promisify(execFile);
// Fixed source only. All launcher values and task XML travel as UTF-8 JSON.
// Compare the full actual task between phases, including its enabled flag;
// action ownership alone must never authorize overwriting a later edit.
export const windowsSessionScript = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
function Decode($value) { return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($value)) | ConvertFrom-Json }
$s=Decode $env:CRW_TASK_SPEC
$old=Decode $env:CRW_TASK_PREVIOUS
$before=Decode $env:CRW_TASK_BEFORE
$after=Decode $env:CRW_TASK_AFTER
$scheduler=New-Object -ComObject Schedule.Service
$scheduler.Connect()
$folder=$scheduler.GetFolder('\')
$user=[Security.Principal.WindowsIdentity]::GetCurrent().Name
function CurrentTask {
  try { return $folder.GetTask($s.name) } catch {
    $code=$_.Exception.GetBaseException().HResult
    if($code -eq -2147024894 -or $code -eq -2147024893) { return $null }
    throw
  }
}
function Snapshot($task) {
  if($null -eq $task) { return $null }
  $xml=[string]$task.Xml
  $enabled=$task.Enabled
  if([string]::IsNullOrEmpty($xml) -or $enabled -isnot [bool]) { throw 'Invalid background task snapshot' }
  return @{xml=$xml; enabled=$enabled}
}
function Same($a,$b) {
  if($null -eq $a -or $null -eq $b) { return ($null -eq $a -and $null -eq $b) }
  return ($a.xml -ceq $b.xml -and $a.enabled -eq $b.enabled)
}
function Owned($task) {
  if($null -eq $task) { return }
  if($null -eq $old) { throw 'A background task with this name already exists' }
  $actions=$task.Definition.Actions
  if($actions.Count -ne 1 -or $actions.Item(1).Type -ne 0 -or
     $actions.Item(1).Path -cne $old.executable -or $actions.Item(1).Arguments -cne $old.arguments) {
    throw 'The background task changed; preserve it'
  }
}
function Restore($expected,$previous) {
  if(!(Same (Snapshot (CurrentTask)) $expected)) { throw 'The background task changed before rollback; preserve it' }
  if($null -eq $previous) {
    if($null -ne $expected) { $folder.DeleteTask($s.name,0) }
  } else {
    # TASK_CREATE_OR_UPDATE, interactive current user only; never credentials.
    $restored=$folder.RegisterTask($s.name,$previous.xml,6,$user,$null,3)
    $restored.Enabled=[bool]$previous.enabled
  }
}
$current=CurrentTask
switch($env:CRW_TASK_OPERATION) {
  'snapshot' { $result=Snapshot $current }
  'inspect' { Owned $current; $result=Snapshot $current }
  'apply' {
    if(!(Same (Snapshot $current) $before)) { throw 'The background task changed before update; preserve it' }
    Owned $current
    $changed=$false; $written=$null
    try {
      if($env:CRW_TASK_ENABLED -eq '1') {
        $task=$scheduler.NewTask(0)
        $task.RegistrationInfo.Description='Codex Remote Web desktop v1'
        $task.Principal.LogonType=3; $task.Principal.RunLevel=0
        $task.Settings.Enabled=$true
        $task.Settings.DisallowStartIfOnBatteries=$false
        $task.Settings.StopIfGoingOnBatteries=$false
        $task.Settings.ExecutionTimeLimit='PT0S'; $task.Settings.MultipleInstances=2
        $trigger=$task.Triggers.Create(9); $trigger.UserId=$user
        $action=$task.Actions.Create(0); $action.Path=$s.executable; $action.Arguments=$s.arguments
        $written=$folder.RegisterTaskDefinition($s.name,$task,6,$user,$null,3)
        $changed=$true
        $result=Snapshot $written
      } else {
        if($null -ne $current) { $folder.DeleteTask($s.name,0); $changed=$true }
        $result=$null
      }
      # Serialize while still inside the transaction's error handler.
      $json=ConvertTo-Json -InputObject $result -Compress -Depth 8
    } catch {
      $failure=$_
      if($changed) {
        try { Restore (Snapshot $written) $before } catch { throw "Background task update and rollback failed: $failure; $_" }
      }
      throw $failure
    }
  }
  'rollback' { Restore $after $before; $result=$null }
  default { throw 'Invalid background task operation' }
}
if($env:CRW_TASK_OPERATION -ne 'apply') { $json=ConvertTo-Json -InputObject $result -Compress -Depth 8 }
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
[Console]::WriteLine($json)
`;

export async function windowsSession(operation, { spec, saved, enabled, before = null, after = null }) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64');
  const binary = join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const { stdout } = await exec(binary, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(windowsSessionScript, 'utf16le').toString('base64')], {
    env: { ...process.env, CRW_TASK_OPERATION: operation, CRW_TASK_ENABLED: enabled ? '1' : '0', CRW_TASK_SPEC: encode(spec), CRW_TASK_PREVIOUS: encode(saved), CRW_TASK_BEFORE: encode(before), CRW_TASK_AFTER: encode(after) },
    windowsHide: true, timeout: 20000, maxBuffer: 262144,
  });
  const snapshot = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
  if (snapshot !== null && (typeof snapshot !== 'object' || typeof snapshot.xml !== 'string' || !snapshot.xml || typeof snapshot.enabled !== 'boolean')) throw new Error('Invalid background task snapshot');
  return snapshot;
}
