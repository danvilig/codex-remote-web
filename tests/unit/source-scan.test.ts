import { test, expect } from 'bun:test';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const script = new URL('../../scripts/scan-source.ts', import.meta.url).pathname;
async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'crw-source-scan-'));
  const git = async (...args) => { const child = Bun.spawn(['git','-c','core.hooksPath=/dev/null',...args],{cwd:root,stdout:'ignore',stderr:'pipe'}); if(await child.exited)throw Error(await new Response(child.stderr).text()); };
  const commit = async () => { await git('add','.'); await git('commit','-qm','snapshot'); };
  const scan = async () => { const child=Bun.spawn(['bun',script,'--directory',root],{stdout:'pipe',stderr:'pipe'});const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);return {stdout,stderr,code}; };
  try { await git('init','-q');await git('config','user.name','Fixture');await git('config','user.email','fixture@example.invalid'); await writeFile(join(root,'SOURCE_PROVENANCE.json'),JSON.stringify({format:1,developmentCommit:'a'.repeat(40)}));await fn({root,git,commit,scan}); }
  finally { await rm(root,{recursive:true,force:true}); }
}
test('source scanner verifies complete independent history and reports metadata only',async()=>fixture(async({root,commit,scan})=>{
  await writeFile(join(root,'README.md'),'Public source.');await writeFile(join(root,'.env.example'),'TOKEN=');await commit();
  const result=await scan();expect(result.code).toBe(0);expect(JSON.parse(result.stdout)).toMatchObject({ok:true,commits:1,blobs:3,remotes:0,unreachableObjects:0});
}));
test('source scanner refuses private paths, token contents and inherited Git history',async()=>fixture(async({root,commit,scan})=>{
  await mkdir(join(root,'docs'));const secret='sk-'+'X'.repeat(40);await writeFile(join(root,'docs','guide.md'),secret);await commit();
  let result=await scan();expect(result.code).toBe(1);expect(result.stderr).toContain('provider-token');expect(result.stderr).not.toContain(secret);
  await writeFile(join(root,'docs','guide.md'),'cleaned');await commit();result=await scan();expect(result.code).toBe(1);expect(result.stderr).toContain('exactly one reachable commit');
}));
test('source scanner refuses a snapshot with a remote before content scan',async()=>fixture(async({git,commit,scan})=>{
  await commit();await git('remote','add','origin','https://example.invalid/reference.git');const result=await scan();expect(result.code).toBe(1);expect(result.stderr).toContain('must not have a remote');
}));
test('source scanner permits only reviewed documentation image paths and still scans their contents',async()=>{
  await fixture(async({root,commit,scan})=>{
    await mkdir(join(root,'docs/images'),{recursive:true});
    await writeFile(join(root,'docs/images/workspace.png'),'Synthetic image fixture');await commit();
    expect((await scan()).code).toBe(0);
  });
  await fixture(async({root,commit,scan})=>{
    await mkdir(join(root,'docs/images'),{recursive:true});
    await writeFile(join(root,'docs/images/personal.png'),'Personal screenshot');await commit();
    const result=await scan();expect(result.code).toBe(1);expect(result.stderr).toContain('forbidden-path');
  });
  await fixture(async({root,commit,scan})=>{
    await mkdir(join(root,'docs/images'),{recursive:true});
    await writeFile(join(root,'docs/images/workspace.png'),'sk-'+'X'.repeat(40));await commit();
    const result=await scan();expect(result.code).toBe(1);expect(result.stderr).toContain('provider-token');
  });
});
