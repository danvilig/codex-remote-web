#!/usr/bin/env node
// No native Codex or model calls: a tool deliberately retains stdio and ignores
// TERM to expose cleanup that waits for `close` or kills only the direct child.
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const tool = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});console.log('tool-ready');if(process.env.FIXTURE_CLOSE_PIPES==='1'){process.stdout.end();process.stderr.end()}setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'inherit'] });
tool.stdout.once('data', () => {
  appendFileSync(process.env.FIXTURE_PIDS, JSON.stringify({ native: process.pid, tool: tool.pid, group: process.ppid }) + '\n');
  tool.stdout.pipe(process.stderr, { end: false });
  createInterface({ input: process.stdin }).on('line', line => {
    const request = JSON.parse(line);
    if (request.id) process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + '\n');
    if (request.method === 'fixture/crash') process.exit(7);
  });
});
