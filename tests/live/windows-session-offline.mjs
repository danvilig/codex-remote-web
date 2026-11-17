// Explicit portable PowerShell verification of the production registration
// protocol. Schedule.Service and WindowsIdentity are disposable substitutes;
// no Windows API, real startup task, credentials or service is used.
// CODEX_WEBUI_TEST_POWERSHELL=/path/to/pwsh bun tests/live/windows-session-offline.mjs
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { windowsSessionScript } from '../../desktop/windows-session.js';

const binary = process.env.CODEX_WEBUI_TEST_POWERSHELL || Bun.which('pwsh') || Bun.which('powershell');
assert(binary, 'Set CODEX_WEBUI_TEST_POWERSHELL to an installed portable PowerShell executable');
const identity = '[Security.Principal.WindowsIdentity]::GetCurrent().Name';
assert.equal(windowsSessionScript.split(identity).length, 2, 'Keep the one native identity substitution explicit');
const directory = await mkdtemp(join(tmpdir(), 'crw-session-offline-'));
const fixture = String.raw`
param([string]$Source)
$ErrorActionPreference='Stop'
$global:Tasks=@{}
$global:ReadFailure=$false
$global:FailNextXmlRead=$false
$global:FailNextEnabledRead=$false
$global:FailRegisteredSnapshot=$false
$global:FailRegisteredEnabled=$false
$global:MutationCount=0
function Assert($condition,$message) { if(!$condition) { throw $message } }
function New-Definition {
  $actions=[pscustomobject]@{Count=0;Value=$null}
  $actions | Add-Member ScriptMethod Create { param($kind) $this.Value=[pscustomobject]@{Type=$kind;Path='';Arguments=''}; $this.Count=1; return $this.Value }
  $actions | Add-Member ScriptMethod Item { param($index) if($index -ne 1) { throw 'Invalid action index' }; return $this.Value }
  $triggers=[pscustomobject]@{}
  $triggers | Add-Member ScriptMethod Create { param($kind) return [pscustomobject]@{Type=$kind;UserId=''} }
  return [pscustomobject]@{
    RegistrationInfo=[pscustomobject]@{Description=''}
    Principal=[pscustomobject]@{LogonType=0;RunLevel=0}
    Settings=[pscustomobject]@{Enabled=$false;DisallowStartIfOnBatteries=$true;StopIfGoingOnBatteries=$true;ExecutionTimeLimit='';MultipleInstances=0}
    Actions=$actions;Triggers=$triggers
  }
}
function New-Registered($definition,$xml=$null) {
  if($null -eq $xml) {
    $escaped=[Security.SecurityElement]::Escape(($definition | ConvertTo-Json -Compress -Depth 8))
    $xml='<FixtureTask>'+ $escaped +'</FixtureTask>'
  }
  $registered=[pscustomobject]@{XmlValue=[string]$xml;EnabledValue=[bool]$definition.Settings.Enabled;Definition=$definition}
  $registered | Add-Member ScriptProperty Xml {
    if($global:FailNextXmlRead) { $global:FailNextXmlRead=$false; throw 'Fixture snapshot failure' }
    return $this.XmlValue
  } { param($value) $this.XmlValue=$value }
  $registered | Add-Member ScriptProperty Enabled {
    if($global:FailNextEnabledRead) { $global:FailNextEnabledRead=$false; throw 'Fixture enabled failure' }
    return $this.EnabledValue
  } { param($value) $this.EnabledValue=[bool]$value }
  return $registered
}
$global:Folder=[pscustomobject]@{}
$global:Folder | Add-Member ScriptMethod GetTask {
  param($name)
  if($global:ReadFailure) { throw [Runtime.InteropServices.COMException]::new('Fixture denied',-2147024891) }
  if(!$global:Tasks.ContainsKey($name)) { throw [Runtime.InteropServices.COMException]::new('Fixture not found',-2147024894) }
  return $global:Tasks[$name]
}
$global:Folder | Add-Member ScriptMethod RegisterTaskDefinition {
  param($name,$definition,$flags,$user,$password,$logon)
  Assert ($flags -eq 6 -and $user -ceq 'fixture-user' -and $null -eq $password -and $logon -eq 3) 'Unexpected registration credentials/flags'
  $task=New-Registered $definition
  $global:Tasks[$name]=$task
  $global:MutationCount++
  if($global:FailRegisteredSnapshot) { $global:FailRegisteredSnapshot=$false; $global:FailNextXmlRead=$true }
  if($global:FailRegisteredEnabled) { $global:FailRegisteredEnabled=$false; $global:FailNextEnabledRead=$true }
  return $task
}
$global:Folder | Add-Member ScriptMethod RegisterTask {
  param($name,$xml,$flags,$user,$password,$logon)
  Assert ($flags -eq 6 -and $user -ceq 'fixture-user' -and $null -eq $password -and $logon -eq 3) 'Unexpected rollback credentials/flags'
  $data=([xml]$xml).FixtureTask | ConvertFrom-Json
  $definition=New-Definition
  $definition.RegistrationInfo.Description=$data.RegistrationInfo.Description
  $definition.Settings.Enabled=$data.Settings.Enabled
  $action=$definition.Actions.Create($data.Actions.Value.Type)
  $action.Path=$data.Actions.Value.Path; $action.Arguments=$data.Actions.Value.Arguments
  $task=New-Registered $definition $xml
  $global:Tasks[$name]=$task
  $global:MutationCount++
  return $task
}
$global:Folder | Add-Member ScriptMethod DeleteTask { param($name,$flags) $global:Tasks.Remove($name); $global:MutationCount++ }
$global:Scheduler=[pscustomobject]@{}
$global:Scheduler | Add-Member ScriptMethod Connect {}
$global:Scheduler | Add-Member ScriptMethod GetFolder { param($path) Assert ($path -eq '\') 'Unexpected scheduler folder'; return $global:Folder }
$global:Scheduler | Add-Member ScriptMethod NewTask { param($flags) return New-Definition }
function New-Object {
  [CmdletBinding(DefaultParameterSetName='Net')]
  param(
    [Parameter(ParameterSetName='COM',Mandatory=$true)][string]$ComObject,
    [Parameter(ParameterSetName='Net',Position=0,Mandatory=$true)][string]$TypeName,
    [Parameter(ParameterSetName='Net',Position=1)][object[]]$ArgumentList
  )
  if($PSCmdlet.ParameterSetName -eq 'COM') { Assert ($ComObject -eq 'Schedule.Service') 'Unexpected COM API'; return $global:Scheduler }
  return Microsoft.PowerShell.Utility\New-Object @PSBoundParameters
}
function Encode($value) { return [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $value -Compress -Depth 8))) }
function Invoke-Session($operation,$spec,$saved,$enabled,$before=$null,$after=$null) {
  $env:CRW_TASK_OPERATION=$operation
  $env:CRW_TASK_SPEC=Encode $spec; $env:CRW_TASK_PREVIOUS=Encode $saved
  $env:CRW_TASK_ENABLED=if($enabled){'1'}else{'0'}
  $env:CRW_TASK_BEFORE=Encode $before; $env:CRW_TASK_AFTER=Encode $after
  # Production writes Console stdout directly; capture it separately from the
  # PowerShell pipeline so an unexpected helper output cannot be ignored.
  $writer=[IO.StringWriter]::new()
  $original=[Console]::Out
  try { [Console]::SetOut($writer); $unexpected=@(& $Source); Assert ($unexpected.Count -eq 0) 'Unexpected pipeline output' }
  finally { [Console]::SetOut($original) }
  return $writer.ToString() | ConvertFrom-Json
}
function Reject($operation,$message) {
  $caught=$false
  try { & $operation } catch { Assert ($_.ToString().Contains($message)) ('Unexpected failure: '+$_); $caught=$true }
  Assert $caught ('Expected failure: '+$message)
}
$a=@{name='fixture-task';executable='C:\fixture\应用 App.exe';arguments='"--background-agent" "quote\"value"'}
$b=@{name=$a.name;executable='C:\fixture\New App.exe';arguments=$a.arguments}

# Absent task creates, and missing/disabled actual tasks are reconciled even
# when the private definition has not changed.
$before=Invoke-Session 'inspect' $a $null $true
Assert ($null -eq $before) 'Initial inspect must be absent'
$after=Invoke-Session 'apply' $a $null $true $before
Assert ($after.enabled -and $global:Tasks.Count -eq 1) 'Create failed'
$null=$global:Tasks.Remove($a.name)
$before=Invoke-Session 'inspect' $a $a $true
$after=Invoke-Session 'apply' $a $a $true $before
Assert ($after.enabled -and $global:Tasks.Count -eq 1) 'Missing task was not repaired'
$global:Tasks[$a.name].Enabled=$false
$before=Invoke-Session 'inspect' $a $a $true
Assert (!$before.enabled) 'Disabled task not observed'
$after=Invoke-Session 'apply' $a $a $true $before
Assert $after.enabled 'Disabled task not repaired'

# Same-name foreign tasks and changed action types remain untouched.
Reject { Invoke-Session 'inspect' $a $null $true } 'already exists'
$global:Tasks[$a.name].Definition.Actions.Value.Arguments='foreign'
Reject { Invoke-Session 'inspect' $a $a $true } 'changed'
Assert ($global:Tasks[$a.name].Definition.Actions.Value.Arguments -eq 'foreign') 'Foreign task overwritten'
$global:Tasks[$a.name].Definition.Actions.Value.Arguments=$a.arguments
$global:Tasks[$a.name].Definition.Actions.Value.Type=5
Reject { Invoke-Session 'inspect' $a $a $true } 'changed'
$global:Tasks[$a.name].Definition.Actions.Value.Type=0

# A foreign edit between inspect and apply must defeat a stale snapshot,
# even with an unchanged action and only an XML or enabled-state difference.
$before=Invoke-Session 'inspect' $a $a $true
$global:Tasks[$a.name].Xml+='<!--foreign-->'
Reject { Invoke-Session 'apply' $a $a $true $before } 'changed before update'
$global:Tasks[$a.name].Xml=$before.xml
$global:Tasks[$a.name].Enabled=$false
Reject { Invoke-Session 'apply' $a $a $true $before } 'changed before update'
$global:Tasks[$a.name].Enabled=$true

# Restore the actual previous task (including a preexisting disabled state),
# rather than regenerating it from the private record.
$global:Tasks[$a.name].Enabled=$false
$before=Invoke-Session 'inspect' $b $a $true
$after=Invoke-Session 'apply' $b $a $true $before
Assert ($global:Tasks[$a.name].Definition.Actions.Value.Path -ceq $b.executable) 'Update failed'
$null=Invoke-Session 'rollback' $b $a $true $before $after
Assert ($global:Tasks[$a.name].Xml -ceq $before.xml -and !$global:Tasks[$a.name].Enabled) 'Update rollback lost previous task'
$before=Invoke-Session 'inspect' $a $a $false
$after=Invoke-Session 'apply' $a $a $false $before
Assert ($null -eq $after -and $global:Tasks.Count -eq 0) 'Delete failed'
$null=Invoke-Session 'rollback' $a $a $false $before $after
Assert ($global:Tasks[$a.name].Xml -ceq $before.xml -and !$global:Tasks[$a.name].Enabled) 'Delete rollback lost previous task'

# PowerShell can silently turn a throwing property getter into null. Invalid
# XML or Enabled observations must fail before any scheduler mutation.
$before=Invoke-Session 'inspect' $a $a $true
$mutations=$global:MutationCount
$global:FailNextXmlRead=$true
Reject { Invoke-Session 'inspect' $a $a $true } 'Invalid background task snapshot'
$global:FailNextEnabledRead=$true
Reject { Invoke-Session 'inspect' $a $a $true } 'Invalid background task snapshot'
Assert ($global:MutationCount -eq $mutations) 'Invalid inspection mutated task'
Assert ($global:Tasks[$a.name].Xml -ceq $before.xml -and !$global:Tasks[$a.name].Enabled) 'Invalid inspection changed prior task'

# A post-registration snapshot read failure is handled inside production
# PowerShell, before control ever returns to the JavaScript persistence phase.
$before=Invoke-Session 'inspect' $b $a $true
$global:FailRegisteredSnapshot=$true
Reject { Invoke-Session 'apply' $b $a $true $before } 'Invalid background task snapshot'
Assert ($global:Tasks[$a.name].Xml -ceq $before.xml -and !$global:Tasks[$a.name].Enabled) 'Helper failure lost previous task'
$global:FailRegisteredEnabled=$true
Reject { Invoke-Session 'apply' $b $a $true $before } 'Invalid background task snapshot'
Assert ($global:Tasks[$a.name].Xml -ceq $before.xml -and !$global:Tasks[$a.name].Enabled) 'Enabled getter failure lost previous task'

# Failed create rollback deletes only exactly the task created by that call.
$global:Tasks.Clear()
$after=Invoke-Session 'apply' $a $null $true
$null=Invoke-Session 'rollback' $a $null $true $null $after
Assert ($global:Tasks.Count -eq 0) 'Create rollback left task behind'
$after=Invoke-Session 'apply' $a $null $true
$global:Tasks[$a.name].Xml+='<!--later edit-->'
Reject { Invoke-Session 'rollback' $a $null $true $null $after } 'changed before rollback'
Assert ($global:Tasks.Count -eq 1 -and $global:Tasks[$a.name].Xml.EndsWith('<!--later edit-->')) 'Rollback overwrote later task'
$global:Tasks[$a.name].Xml=$after.xml
$global:Tasks[$a.name].Enabled=$false
Reject { Invoke-Session 'rollback' $a $null $true $null $after } 'changed before rollback'

# Other scheduler errors must fail closed, rather than becoming absence.
$global:ReadFailure=$true
Reject { Invoke-Session 'inspect' $a $a $true } 'Fixture denied'
[Console]::WriteLine('PASS: production PowerShell registration source; missing/disabled repair, action ownership, snapshot races, create/update/delete rollback, helper failure rollback, foreign preservation and scheduler errors')
`;
try {
  const source = join(directory, 'production.ps1'), harness = join(directory, 'harness.ps1');
  await writeFile(source, windowsSessionScript.replace(identity, "'fixture-user'"));
  await writeFile(harness, fixture);
  const child = Bun.spawn([binary, '-NoLogo', '-NoProfile', '-NonInteractive', '-File', harness, '-Source', source], {
    env: { ...process.env }, stdout: 'inherit', stderr: 'inherit',
  });
  const timeout = setTimeout(() => child.kill(), 30000);
  try { assert.equal(await child.exited, 0, 'PowerShell registration offline production-source verification failed'); }
  finally { clearTimeout(timeout); }
} finally { await rm(directory, { recursive: true, force: true }); }
