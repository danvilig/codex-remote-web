import { test, expect } from 'bun:test';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const script = new URL('../../scripts/scan-source.ts', import.meta.url).pathname;
async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'crw-source-scan-'));
  const git = async (...args) => { const child = Bun.spawn(['git','-c','core.hooksPath=/dev/null',...args],{cwd:root,stdout:'ignore',stderr:'pipe'}); if(await child.exited)throw Error(await new Response(child.stderr).text()); };
  const commit = async () => { await git('add','.'); await git('commit','-qm','snapshot'); };
  const scan = async (args = []) => { const child=Bun.spawn(['bun',script,'--directory',root,...args],{stdout:'pipe',stderr:'pipe'});const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);return {stdout,stderr,code}; };
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
test('published scanner allows later commits only from the recorded root and remote, and scans historical content',async()=>fixture(async({root,git,commit,scan})=>{
  await writeFile(join(root,'README.md'),'Initial public files.'); await commit();
  const initialCommit = Bun.spawnSync(['git','rev-parse','HEAD'],{cwd:root,stdout:'pipe'}).stdout.toString().trim();
  const provenance = {format:1,developmentCommit:'a'.repeat(40),publicRepository:{url:'https://github.com/example/public.git',initialCommit}};
  await writeFile(join(root,'SOURCE_PROVENANCE.json'),JSON.stringify(provenance)); await commit();
  await git('remote','add','origin',provenance.publicRepository.url);
  let result = await scan(['--published']);
  expect(result.code).toBe(0); expect(JSON.parse(result.stdout)).toMatchObject({mode:'published',commits:2,remotes:1});
  await git('remote','set-url','origin',provenance.publicRepository.url.replace(/\.git$/, ''));
  expect((await scan(['--published'])).code).toBe(0);
  expect((await scan()).code).toBe(1);
  await git('remote','set-url','origin','https://github.com/example/wrong.git');
  expect((await scan(['--published'])).stderr).toContain('Unexpected published repository remote');
  await git('remote','set-url','origin',provenance.publicRepository.url);
  await git('remote','add','upstream','https://github.com/example/upstream.git');
  expect((await scan(['--published'])).stderr).toContain('only its origin');
  await git('remote','remove','upstream');
  const secret = 'sk-'+'X'.repeat(40);
  await writeFile(join(root,'README.md'),secret); await commit();
  await writeFile(join(root,'README.md'),'Clean current content.'); await commit();
  result = await scan(['--published']);
  expect(result.code).toBe(1); expect(result.stderr).toContain('provider-token'); expect(result.stderr).not.toContain(secret);
}));
test('published scanner rejects a substituted root and a shallow checkout',async()=>fixture(async({root,git,commit,scan})=>{
  await commit();
  const initialCommit = Bun.spawnSync(['git','rev-parse','HEAD'],{cwd:root,stdout:'pipe'}).stdout.toString().trim();
  const provenance = {format:1,developmentCommit:'a'.repeat(40),publicRepository:{url:'https://github.com/example/public.git',initialCommit:'b'.repeat(40)}};
  await writeFile(join(root,'SOURCE_PROVENANCE.json'),JSON.stringify(provenance)); await commit();
  await git('remote','add','origin',provenance.publicRepository.url);
  expect((await scan(['--published'])).stderr).toContain('recorded public initial commit');
  provenance.publicRepository.initialCommit=initialCommit;
  await writeFile(join(root,'SOURCE_PROVENANCE.json'),JSON.stringify(provenance)); await commit();
  const clone=join(root,'shallow');
  await git('clone','--depth=1','file://'+root,clone);
  const child=Bun.spawn(['bun',script,'--directory',clone,'--published'],{stdout:'pipe',stderr:'pipe'});
  const error=await new Response(child.stderr).text();
  expect(await child.exited).toBe(1); expect(error).toContain('full checkout');
}));
test('annotated release tag stays reachable with detached commit checkout; overwriting it is rejected',async()=>fixture(async({root,git,commit})=>{
  await commit();
  const initialCommit=Bun.spawnSync(['git','rev-parse','HEAD'],{cwd:root,stdout:'pipe'}).stdout.toString().trim();
  const origin='https://github.com/example/public.git';
  await writeFile(join(root,'SOURCE_PROVENANCE.json'),JSON.stringify({format:1,developmentCommit:'a'.repeat(40),publicRepository:{url:origin,initialCommit}}));
  await commit(); await git('tag','-a','v0.2.0-alpha.2','-m','Public alpha release');
  const checkout=join(root,'checkout');
  await git('clone','--no-hardlinks',root,checkout);
  const run=async(...args)=>{const child=Bun.spawn(['git',...args],{cwd:checkout,stdout:'pipe',stderr:'pipe'});const [output,error,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);if(code)throw Error(error);return output.trim();};
  const scan=async()=>{const child=Bun.spawn(['bun',script,'--directory',checkout,'--published'],{stdout:'pipe',stderr:'pipe'});const [output,error,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);return {output,error,code};};
  await run('remote','set-url','origin',origin);
  const sha=await run('rev-parse','HEAD');
  await run('checkout','--detach',sha);
  expect(await run('cat-file','-t','refs/tags/v0.2.0-alpha.2')).toBe('tag');
  expect((await scan()).code).toBe(0);
  // Reproduce checkout v4's fallback fetch from the failing tag-push log.
  await run('fetch','--no-tags',root,`+${sha}:refs/tags/v0.2.0-alpha.2`);
  expect(await run('cat-file','-t','refs/tags/v0.2.0-alpha.2')).toBe('commit');
  expect((await run('fsck','--full','--no-reflogs','--unreachable'))).toContain('unreachable tag');
  let result=await scan();expect(result.code).toBe(1);expect(result.error).toContain('unreachable objects');
  // Restoring the canonical fetched tag makes the same objects reachable again.
  await run('fetch','--no-tags',root,'+refs/tags/v0.2.0-alpha.2:refs/tags/v0.2.0-alpha.2');
  result=await scan();expect(result.code).toBe(0);
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
