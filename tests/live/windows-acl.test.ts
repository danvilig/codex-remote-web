import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, lstatSync, rmSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { privateAccess } from '../../src/server/config/private-access.js';

test.skipIf(process.platform !== 'win32')('NTFS private state rejects broad access and junctions on the native host', () => {
  const directory=mkdtempSync(join(tmpdir(),'crw-acl-')),file=join(directory,'state.json');
  try {
    writeFileSync(file,'{}');
    expect(privateAccess(lstatSync(file),file)).toBe(true);
    execFileSync('icacls',[file,'/grant','*S-1-1-0:R'],{stdio:'pipe'});
    expect(privateAccess(lstatSync(file),file)).toBe(false);
    const target=join(directory,'target'),link=join(directory,'link');mkdirSync(target);symlinkSync(target,link,'junction');
    expect(privateAccess(lstatSync(target),link)).toBe(false);
  } finally {rmSync(directory,{recursive:true,force:true});}
},30000);
