import {afterEach,describe,expect,test} from 'bun:test';
import {chmodSync,linkSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync,statSync,symlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {readDocument,saveDocument,DOCUMENT_MAX_BYTES} from '../../src/server/files/documents.js';

const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(){const root=mkdtempSync('/tmp/crw-documents-');roots.push(root);const project=join(root,'project'),outside=join(root,'outside');mkdirSync(project);mkdirSync(outside);return {root,project,outside,options:{browseRoots:[project],home:root,privateRoot:join(project,'.codex'),deniedPaths:[join(project,'login-store.json')]}};}

describe('project document editing',()=>{
 test('preserves UTF-8 BOM, CRLF, executable mode and exact Markdown source in atomic replacement',()=>{
  const {project,options}=fixture(),path='build.sh',file=join(project,path);writeFileSync(file,'\uFEFF#!/bin/sh\r\nprintf "中文"\r\n');chmodSync(file,0o755);
  const before=readDocument({cwd:project,path},options);expect(before.text.startsWith('\uFEFF')).toBe(true);expect(before.writable).toBe(true);
  const text=before.text.replace('中文','编辑');const saved=saveDocument({cwd:project,path,text,revision:before.revision},options);
  expect(readFileSync(file,'utf8')).toBe(text);expect(saved.revision).not.toBe(before.revision);expect(statSync(file).mode&0o777).toBe(0o755);expect(readdirSync(project)).toEqual([path]);
 });
 test('stale or concurrent saves reject with conflict and preserve external contents',()=>{
  const {project,options}=fixture(),path='README.md',file=join(project,path);writeFileSync(file,'# original\n');const before=readDocument({cwd:project,path},options);
  saveDocument({cwd:project,path,revision:before.revision,text:'# first\n'},options);
  expect(()=>saveDocument({cwd:project,path,revision:before.revision,text:'# stale\n'},options)).toThrow('FILE_CONFLICT');expect(readFileSync(file,'utf8')).toBe('# first\n');
  const next=readDocument({cwd:project,path},options);writeFileSync(file,'external change\n');expect(()=>saveDocument({cwd:project,path,revision:next.revision,text:'draft'},options)).toThrow('FILE_CONFLICT');expect(readFileSync(file,'utf8')).toBe('external change\n');
 });
 test('rejects parent/sibling escapes, credentials, symlink files and symlink directories',()=>{
  const {project,outside,options}=fixture();writeFileSync(join(outside,'out.txt'),'outside');writeFileSync(join(project,'.env'),'secret');mkdirSync(join(project,'.codex'));writeFileSync(join(project,'.codex','config.toml'),'private');writeFileSync(join(project,'login-store.json'),'secret');
  symlinkSync(join(outside,'out.txt'),join(project,'linked.txt'));symlinkSync(outside,join(project,'alias'));symlinkSync(join(project,'.codex'),join(project,'private-alias'));
  for(const path of ['../outside/out.txt',join(outside,'out.txt'),'.env','.codex/config.toml','login-store.json','linked.txt','alias/out.txt','private-alias/config.toml'])expect(()=>readDocument({cwd:project,path},options)).toThrow();
  expect(()=>readDocument({cwd:outside,path:'out.txt'},options)).toThrow();expect(readFileSync(join(outside,'out.txt'),'utf8')).toBe('outside');
 });
 test('symlink substitution after read never modifies its target',()=>{
  const {project,outside,options}=fixture(),file=join(project,'app.js'),target=join(outside,'app.js');writeFileSync(file,'original');writeFileSync(target,'outside');const before=readDocument({cwd:project,path:'app.js'},options);rmSync(file);symlinkSync(target,file);
  expect(()=>saveDocument({cwd:project,path:'app.js',revision:before.revision,text:'draft'},options)).toThrow();expect(readFileSync(target,'utf8')).toBe('outside');
 });
 test('binary, invalid UTF-8, oversized files and unknown fields fail without mutation',()=>{
  const {project,options}=fixture();for(const [path,data] of [['binary.txt',Buffer.from([65,0,66])],['invalid.txt',Buffer.from([0xff])],['large.txt',Buffer.alloc(DOCUMENT_MAX_BYTES+1,65)]] as const){writeFileSync(join(project,path),data);expect(()=>readDocument({cwd:project,path},options)).toThrow();}
  writeFileSync(join(project,'a.txt'),'original');const before=readDocument({cwd:project,path:'a.txt'},options),base={cwd:project,path:'a.txt',revision:before.revision,text:'new'};
  expect(()=>saveDocument({...base,force:true},options)).toThrow('FILE_INVALID');expect(()=>saveDocument({...base,text:'A'.repeat(DOCUMENT_MAX_BYTES+1)},options)).toThrow('FILE_TOO_LARGE');expect(()=>saveDocument({...base,text:'a\0b'},options)).toThrow();expect(readFileSync(join(project,'a.txt'),'utf8')).toBe('original');
 });
 test('read-only and multiply linked files remain read-only; literal percent filenames work',()=>{
  const {project,options}=fixture(),path='a%20b.txt',file=join(project,path);writeFileSync(file,'literal path');const before=readDocument({cwd:project,path},options);expect(before.text).toBe('literal path');
  chmodSync(file,0o444);expect(readDocument({cwd:project,path},options).writable).toBe(false);expect(()=>saveDocument({cwd:project,path,text:'changed',revision:before.revision},options)).toThrow('FILE_READ_ONLY');chmodSync(file,0o644);linkSync(file,join(project,'hard.txt'));expect(readDocument({cwd:project,path},options).writable).toBe(false);
 });
});
