import { mkdir, readFile, writeFile, chmod, realpath } from 'node:fs/promises';
import { resolve, join, dirname, relative } from 'node:path';
import { documentationImages, publicSourceExcluded } from './documentation-assets.ts';
const root=resolve(import.meta.dir,'..');
async function git(args:string[],cwd=root) {
  const child=Bun.spawn(['git','-c','core.hooksPath=/dev/null',...args],{cwd,stdout:'pipe',stderr:'pipe'});
  const [output,error,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  if(code)throw new Error(`Git operation failed: ${error}`);return output.trim();
}
if(await git(['status','--porcelain','--untracked-files=normal']))throw new Error('Public source export requires a clean commit');
const commit=await git(['rev-parse','HEAD']),pkg=await Bun.file(join(root,'package.json')).json();
if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(pkg.version)) throw new Error('Invalid release version');
const output=join(root,'.artifacts','public-source',`${pkg.name}-${pkg.version}-${commit.slice(0,7)}`);
await mkdir(dirname(output),{recursive:true});
const artifacts=await realpath(join(root,'.artifacts'));
if(relative(artifacts,await realpath(dirname(output))).startsWith('..'))throw new Error('Export must stay inside the local artifact directory');
// mkdir without recursive refuses an existing export. Never replace or delete it.
await mkdir(output);
const rootFiles=new Set(['.bun-version','.node-version','.dockerignore','.gitignore','.env.example','package.json','bun.lock','Dockerfile','docker-compose.yml','LICENSE','README.md','README-zh.md','CHANGELOG.md','CONTRIBUTING.md','CODE_OF_CONDUCT.md','DEVELOPMENT.md','SECURITY.md','THIRD_PARTY_NOTICES.md','SOURCE_PROVENANCE.json','AGENTS.md','.github/CODEOWNERS']);
const docs=new Set(['ARCHITECTURE.md','CONFIGURATION.md','RELEASING.md','GIT_WORKFLOW.md','ROADMAP.md','SANDBOX_SETUP.md','WORKSPACE_UI.md','deployment/CLOUDFLARE.md','deployment/SETUP.md','licenses/BUN.md',`releases/${pkg.version}.md`,`releases/${pkg.version}-acceptance.md`]);
function allowed(path:string) {
 if(publicSourceExcluded.has(path))return false;
 if(documentationImages.has(path))return true;
 if(rootFiles.has(path))return true;
 if(path.startsWith('docs/'))return docs.has(path.slice(5));
 return /^(?:src\/.+\.(?:js|ts)|public\/[^/]+\.(?:js|html|css|svg)|scripts\/[^/]+\.(?:ts|py)|tests\/(?:unit|browser|live|helpers|fixtures)\/.+\.(?:js|ts|mjs)|tests\/fixtures\/codex|\.github\/(?:workflows|ISSUE_TEMPLATE)\/[^/]+\.yml|\.github\/pull_request_template\.md|ops\/(?:apparmor\/codex-bwrap|cloudflare\/ingress\.yml\.example|systemd\/(?:environment|codex-remote-web\.service)\.example))$/.test(path);
}
const tree=await git(['ls-tree','-rz','--full-tree','HEAD']);let files=0;
for(const entry of tree.split('\0').filter(Boolean)) {
 const tab=entry.indexOf('\t'),[mode,type,oid]=entry.slice(0,tab).split(' '),path=entry.slice(tab+1);
 if(!allowed(path))continue;
 if(type!=='blob'||!['100644','100755'].includes(mode))throw new Error(`Unsupported source entry: ${path}`);
 const child=Bun.spawn(['git','cat-file','blob',oid],{cwd:root,stdout:'pipe',stderr:'pipe'});
 const [data,code]=await Promise.all([new Response(child.stdout).arrayBuffer(),child.exited]);if(code)throw new Error('Unable to export source blob');
 const target=join(output,path);await mkdir(dirname(target),{recursive:true});await writeFile(target,new Uint8Array(data));await chmod(target,mode==='100755'?0o755:0o644);files++;
}
let provenance;
try{provenance=JSON.parse(await readFile(join(root,'SOURCE_PROVENANCE.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
provenance ||= {format:1,referenceProject:{repository:'https://github.com/lezi-fun/codex-webui',commit:'332b14d2600a7e14332fae7b6032b973c8e5b198',role:'historical-reference'},developmentCommit:commit,history:'Independent Codex Remote Web source snapshot; prior development history and extracted assets are not distributed.'};
await writeFile(join(output,'SOURCE_PROVENANCE.json'),JSON.stringify(provenance,null,2)+'\n');
const name=await git(['var','GIT_AUTHOR_IDENT']);const match=name.match(/^(.*) <([^<>]+)> /);if(!match)throw new Error('A local Git author identity is required');
await git(['init','-q','-b','main',output]);
await git(['config','user.name',match[1]],output);await git(['config','user.email',match[2]],output);
await git(['add','.'],output);await git(['commit','-q','-m',`Initial public source snapshot for ${pkg.version}`],output);
if(await git(['remote'],output))throw new Error('Public snapshot must not inherit remotes');
if(await git(['rev-list','--count','HEAD'],output)!=='1')throw new Error('Public snapshot must have exactly one commit');
console.log(JSON.stringify({directory:output,commit:await git(['rev-parse','HEAD'],output),developmentCommit:provenance.developmentCommit,files,dirty:false}));
