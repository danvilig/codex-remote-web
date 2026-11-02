// Explicit opt-in: calls the configured real provider, at most two turns.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import WebSocket from 'ws';
import { spawnSync } from 'node:child_process';
import { artifact, launchOptions } from '../helpers/browser-runtime.mjs';

if (process.env.CODEX_WEBUI_RUN_LIVE !== '1') throw new Error('Set CODEX_WEBUI_RUN_LIVE=1 to allow two real provider turns');
const base = process.env.CODEX_WEBUI_TEST_URL || 'http://127.0.0.1:8899';
const root = resolve(import.meta.dirname, '../..');
mkdirSync(artifact('environment'), { recursive: true });
const fixture = mkdtempSync(join(root, '.artifacts', 'runtime-tools-'));
const workspace = join(fixture, 'workspace'), outside = join(fixture, 'approval-target');
mkdirSync(workspace); mkdirSync(outside);
const notifications = [], requests = [], threads = [], summary = { checks: {}, turns: [] };
let browser, socket, activeTurn, sequence = 0;
const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));
async function rpc(method, params = {}) {
  const response = await fetch(`${base}/api/rpc`, { signal: AbortSignal.timeout(45_000), method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: ++sequence, method, params }) });
  const payload = await response.json();
  if (!response.ok || payload.type === 'rpc/error') throw new Error(`${method}: ${typeof payload.error === 'string' ? payload.error : JSON.stringify(payload.error)}`);
  return payload.result;
}
async function until(check, label, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await sleep(100); }
  throw new Error(`Timed out: ${label}`);
}
async function startThread(page) {
  const result = await rpc('thread/start', { cwd: workspace, runtimeWorkspaceRoots: [workspace], sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user', ephemeral: true, sessionStartSource: 'startup' });
  const id = result.thread.id; threads.push(id);
  summary.model = result.model; summary.modelProvider = result.modelProvider;
  await page.evaluate(id => globalThis.__codexWebuiDebug.openThread(id), id);
  return id;
}
async function startTurn(id, text) {
  const result = await rpc('turn/start', { threadId: id, cwd: workspace, input: [{ type: 'text', text }], approvalPolicy: 'on-request', approvalsReviewer: 'user', sandboxPolicy: { type: 'workspaceWrite', writableRoots: [workspace], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true } });
  activeTurn = { threadId: id, turnId: result.turn.id };
  summary.turns.push({ threadId: id, turnId: result.turn.id });
  return result.turn.id;
}
async function completed(threadId, turnId) {
  const event = await until(() => notifications.find(event => event.method === 'turn/completed' && event.params?.threadId === threadId && event.params?.turn?.id === turnId), 'turn completion');
  activeTurn = null;
  if (event.params.turn.status !== 'completed') throw new Error(`Turn failed: ${JSON.stringify(event.params.turn.error || event.params.turn)}`);
  return notifications.filter(event => event.method === 'item/completed' && event.params?.threadId === threadId && event.params?.turnId === turnId).map(event => event.params.item);
}
try {
  assert.equal((await (await fetch(`${base}/api/health`)).json()).codex, true);
  socket = new WebSocket(`${base.replace(/^http/, 'ws')}/ws`);
  socket.on('message', raw => {
    const message = JSON.parse(String(raw));
    const event = message.payload;
    if (!threads.includes(event?.params?.threadId)) return;
    if (message.type === 'codex/notification') notifications.push(event);
    if (message.type === 'codex/request') requests.push(event);
  });
  await new Promise((resolveOpen, reject) => { socket.once('open', resolveOpen); socket.once('error', reject); });
  browser = await chromium.launch(launchOptions());
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'dark' });
  await context.addInitScript(() => { if (window === window.top) localStorage.setItem('codex-webui-locale', 'en'); });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => globalThis.__codexWebuiDebug?.state.connected);
  const threadId = await startThread(page);
  const turnId = await startTurn(threadId, `This is a bounded WebUI tool verification in an isolated test folder. Do exactly these two actions, then say TOOL_CHECK_OK:
1. Use the terminal tool to execute: printf 'SHELL_TOOL_OK\\n' > shell-proof.txt; cat shell-proof.txt
2. Use the apply_patch tool to add patch-proof.txt containing exactly PATCH_TOOL_OK and a newline.
Use the real tools, not a description. Do not use subagents or network access, and do not touch any other files. Do not retry a failed tool.`);
  const items = await completed(threadId, turnId);
  assert.equal(readFileSync(join(workspace, 'shell-proof.txt'), 'utf8'), 'SHELL_TOOL_OK\n');
  assert.equal(readFileSync(join(workspace, 'patch-proof.txt'), 'utf8'), 'PATCH_TOOL_OK\n');
  assert(items.some(item => item.type === 'commandExecution' && item.exitCode === 0));
  assert(items.some(item => item.type === 'fileChange' && item.status === 'completed'));
  summary.checks.shell = true; summary.checks.applyPatch = true;
  summary.turns[0].items = items.map(item => ({ type: item.type, status: item.status, exitCode: item.exitCode }));
  await page.screenshot({ path: artifact('runtime-tools-shell-patch.png') });
  console.log('PASS: real Shell and apply_patch through WebUI gateway');

  const approvedFile = join(outside, 'approved-proof.txt');
  const approvalCommand = `printf 'APPROVAL_TOOL_OK\\n' > '${approvedFile}'`;
  const approvalThread = await startThread(page);
  const approvalTurn = await startTurn(approvalThread, `This is the second and final bounded verification. Use the terminal tool to execute exactly this command:\n${approvalCommand}\nThis path is an isolated verification file outside the writable workspace. Request sandbox escalation/approval for this command so the user can approve it in the WebUI. If you first try in the sandbox and it is denied, request approval once. Do not use apply_patch, another path, subagents, or any unrelated command. After success, say APPROVAL_CHECK_OK.`);
  const request = await until(() => requests.find(request => request.params?.threadId === approvalThread), 'approval request');
  assert.equal(request.method, 'item/commandExecution/requestApproval');
  assert.equal(existsSync(approvedFile), false, 'Command must not execute before approval');
  // Parse display quoting without executing it, and approve only the exact proof command.
  const parsed = spawnSync('python3', ['-c', 'import json,shlex,sys; print(json.dumps(shlex.split(sys.stdin.read())))'], { input: request.params.command, encoding: 'utf8' });
  assert.equal(parsed.status, 0);
  let tokens = JSON.parse(parsed.stdout);
  if (tokens.length === 3 && ['/bin/bash', '/bin/sh', '/bin/zsh', 'bash', 'sh', 'zsh'].includes(tokens[0]) && ['-lc', '-c'].includes(tokens[1])) {
    const inner = spawnSync('python3', ['-c', 'import json,shlex,sys; print(json.dumps(shlex.split(sys.stdin.read())))'], { input: tokens[2], encoding: 'utf8' });
    assert.equal(inner.status, 0); tokens = JSON.parse(inner.stdout);
  }
  assert.deepEqual(tokens, ['printf', 'APPROVAL_TOOL_OK\\n', '>', approvedFile], 'Approve only the exact isolated proof command');
  const card = page.locator('[data-codex-approval-surface]').filter({ hasText: approvedFile });
  await card.waitFor({ timeout: 15_000 });
  await page.screenshot({ path: artifact('runtime-tools-approval-waiting.png') });
  await card.locator('.approval-primary').click();
  const approvalItems = await completed(approvalThread, approvalTurn);
  assert.equal(readFileSync(approvedFile, 'utf8'), 'APPROVAL_TOOL_OK\n');
  assert(approvalItems.some(item => item.type === 'commandExecution' && item.exitCode === 0));
  await until(() => card.count().then(count => count === 0), 'approval card removal', 10_000);
  summary.checks.approvalBeforeExecution = true; summary.checks.browserApproval = true; summary.checks.approvedExecution = true;
  summary.turns[1].items = approvalItems.map(item => ({ type: item.type, status: item.status, exitCode: item.exitCode }));
  await page.screenshot({ path: artifact('runtime-tools-approval-completed.png') });
  assert.deepEqual(errors, []);
  summary.browserErrors = errors; summary.ok = true;
  console.log('PASS: native approval card, browser approval, command execution and resolution');
} catch (error) {
  summary.ok = false; summary.error = error.message;
  throw error;
} finally {
  if (activeTurn) await rpc('turn/interrupt', activeTurn).catch(() => {});
  // Store bounded metadata for our test threads only, never account/config payloads.
  writeFileSync(artifact('environment/runtime-tools-live.json'), JSON.stringify(summary, null, 2) + '\n');
  await browser?.close(); socket?.terminate(); rmSync(fixture, { recursive: true, force: true });
}
