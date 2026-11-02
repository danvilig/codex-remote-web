import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {mkdtemp,mkdir,writeFile,readFile,rm,chmod,symlink} from 'node:fs/promises';
import {join,delimiter} from 'node:path';
import {chromium} from 'playwright';
import {root,artifact,launchOptions} from '../helpers/browser-runtime.mjs';

const temp=await mkdtemp('/tmp/crw-file-editor-'),home=join(temp,'home'),project=join(temp,'project'),codex=join(home,'.codex');
for(const dir of [home,project,codex])await mkdir(dir,{recursive:true});
const original='# Original title\n\nA **formatted** paragraph.\n\n```js\nconst answer = 42;\n```\n\n[ref]: https://example.com\n\nKeep [reference][ref].\n';
await writeFile(join(project,'README.md'),original);
await writeFile(join(project,'main.ts'),'// A TypeScript fixture\nconst answer: number = 42;\nconsole.log(answer);\n');
await writeFile(join(project,'other.json'),'{"ok":true}');
const blocksOriginal='# Heading\n\nParagraph **bold**.\n\nTail remains.\n';await writeFile(join(project,'blocks.md'),blocksOriginal);await writeFile(join(project,'empty.md'),'');
await writeFile(join(project,'locked.txt'),'Read only fixture');await chmod(join(project,'locked.txt'),0o444);
await writeFile(join(project,'.env'),'SECRET=fixture');await symlink('/etc/passwd',join(project,'linked.txt'));
const port=await new Promise(resolve=>{const s=createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});}),base=`http://127.0.0.1:${port}`;
const server=Bun.spawn(['bun','src/server/index.ts'],{cwd:root,stdout:'ignore',stderr:'ignore',env:{...process.env,HOME:home,CODEX_HOME:codex,CODEX_AUTH_PATH:join(codex,'auth.json'),CODEX_WEBUI_CWD:project,CODEX_WEBUI_REVIEW_ROOT:project,CODEX_WEBUI_AUTH_MODE:'local',HOST:'127.0.0.1',PORT:String(port),CODEX_WEBUI_ENABLE_TERMINAL:'false',PATH:join(root,'tests/fixtures')+delimiter+process.env.PATH}});
let browser,page,phase='startup';
const documentUrl=path=>base+'/api/files/document?'+new URLSearchParams({cwd:project,path});
const headers={'content-type':'application/json','x-workspace-request':'1',origin:base};
const post=(data,extra=headers)=>fetch(base+'/api/files/document',{method:'POST',headers:extra,body:JSON.stringify(data)});
const open=async path=>{await page.locator('#sideFileContent').getByRole('treeitem',{name:path,exact:true}).locator(':scope > .explorer-row-line').click();await page.locator('.explorer-preview-name').filter({hasText:path}).waitFor();};
const content=()=>page.locator('#sideFileContent .cm-content');
const replace=async text=>{await content().focus();await page.keyboard.press('ControlOrMeta+a');await page.keyboard.insertText(text);};
try{
 for(let i=0;;i++){try{if((await(await fetch(base+'/api/health')).json()).codex)break;}catch{}if(i>100)throw Error('startup');await Bun.sleep(50);}
 phase='protected document endpoint';
 const doc=await(await fetch(documentUrl('main.ts'))).json();assert(doc.revision);assert.equal(doc.writable,true);
 const payload={cwd:project,path:'main.ts',text:'UNAUTHORIZED',revision:doc.revision};
 assert.equal((await post(payload,{'content-type':'application/json',origin:base})).status,403);
 assert([401,403].includes((await post(payload,{...headers,origin:'https://untrusted.invalid'})).status));
 assert([401,403].includes((await post(payload,{...headers,'sec-fetch-site':'cross-site'})).status));
 for(const path of ['.env','linked.txt','../home/.codex/auth.json'])assert.equal((await fetch(documentUrl(path))).status,400);
 assert.equal(await readFile(join(project,'main.ts'),'utf8'),doc.text);
 assert.equal((await post({...payload,force:true})).status,400);

 browser=await chromium.launch(launchOptions());const context=await browser.newContext({viewport:{width:1440,height:1000},colorScheme:'dark'});
 await context.addInitScript(()=>{if(window===window.top)localStorage.setItem('codex-webui-locale','en');});
 page=await context.newPage();page.setDefaultTimeout(10000);const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(base,{waitUntil:'networkidle'});await page.waitForFunction(()=>globalThis.__codexWebuiDebug?.state.connected);await page.locator('#prompt').fill('Main draft stays');
 await page.locator('#toggleSidePanel').click();await page.locator('[data-side-panel-action=files]').click();await page.locator('#maximizeSidePanel').click();
 phase='syntax highlighted code and editor';
 await open('main.ts');await page.locator('.explorer-code .tok-keyword').waitFor();await page.locator('.explorer-code .tok-number').waitFor();
 await page.getByRole('button',{name:'Edit file',exact:true}).click();await content().waitFor();await page.locator('.cm-line .tok-keyword').waitFor();
 await content().focus();await page.keyboard.press('ControlOrMeta+f');await page.locator('.cm-search input[name=search]').fill('answer');await page.locator('.cm-search input[name=search]').press('Enter');await page.locator('.cm-searchMatch').first().waitFor();await page.keyboard.press('Escape');assert.equal(await page.locator('#maximizeSidePanel').getAttribute('aria-pressed'),'true');
 const updated='// 中文 edits\nconst answer: number = 84;\nconsole.log(answer);\n';await replace(updated);await page.getByRole('button',{name:'Save file',exact:true}).waitFor({state:'visible'});
 const saved=page.waitForResponse(response=>response.url().endsWith('/api/files/document')&&response.request().method()==='POST');await page.keyboard.press('ControlOrMeta+s');assert.equal((await saved).status(),200);assert.equal(await readFile(join(project,'main.ts'),'utf8'),updated);assert.equal(await page.locator('#prompt').inputValue(),'Main draft stays');
 // The editor owns Ctrl-K / Ctrl-B, leaving task navigation and sidebar alone.
 const sidebarState=await page.locator('body').getAttribute('class');await content().focus();await page.keyboard.press('Control+b');assert.equal(await page.locator('body').getAttribute('class'),sidebarState);
 await page.screenshot({path:artifact('file-editor-code-dark.png')});

 phase='preview-mode Markdown editing preserves untouched source';
 await open('README.md');await page.locator('.explorer-markdown h1').waitFor();await page.locator('.explorer-markdown code .tok-keyword').waitFor();
 await page.getByRole('button',{name:'Edit file',exact:true}).click();await page.locator('.markdown-file-block').filter({has:page.locator('h1')}).click();await content().waitFor();
 await replace('# Edited title\n');await page.locator('.markdown-block-live h1').filter({hasText:'Edited title'}).waitFor();await page.getByRole('button',{name:'Done',exact:true}).click();await page.locator('.explorer-markdown h1').filter({hasText:'Edited title'}).waitFor();
 await page.getByRole('button',{name:'Save file',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.explorer-preview-name').classList.contains('is-dirty'));assert.equal(await readFile(join(project,'README.md'),'utf8'),original.replace('# Original title','# Edited title'));
 assert.equal(await page.locator('.explorer-markdown a').evaluate(el=>el.href),'https://example.com/');
 await page.getByRole('button',{name:'View source',exact:true}).click();await content().waitFor();await replace(original.replace('Original title','Full-source edit'));
 await page.getByRole('button',{name:'Preview',exact:true}).click();await page.locator('.explorer-markdown h1').filter({hasText:'Full-source edit'}).waitFor();await page.screenshot({path:artifact('file-editor-markdown-inline.png')});
 phase='draft kept across files and explicit discard';
 await open('other.json');await page.locator('.explorer-code').waitFor();await open('README.md');await page.locator('.explorer-markdown h1').filter({hasText:'Full-source edit'}).waitFor();
 page.once('dialog',dialog=>dialog.dismiss());await page.getByRole('button',{name:'Discard changes',exact:true}).click();await page.locator('.explorer-markdown h1').filter({hasText:'Full-source edit'}).waitFor();
 page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Discard changes',exact:true}).click();await page.locator('.explorer-markdown h1').filter({hasText:'Edited title'}).waitFor();

 phase='switching active Markdown blocks and empty document';
 await open('blocks.md');await page.getByRole('button',{name:'Edit file',exact:true}).click();await page.locator('.markdown-file-block').filter({has:page.locator('h1')}).click();await content().focus();await page.keyboard.press('End');await page.keyboard.insertText(' expanded');
 await page.locator('.markdown-file-block').filter({hasText:'Paragraph bold.'}).click();assert((await content().innerText()).includes('Paragraph **bold**.'));await content().focus();await page.keyboard.press('End');await page.keyboard.insertText(' edited');await page.getByRole('button',{name:'Save file',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.explorer-preview-name').classList.contains('is-dirty'));
 assert.equal(await readFile(join(project,'blocks.md'),'utf8'),blocksOriginal.replace('# Heading','# Heading expanded').replace('Paragraph **bold**.','Paragraph **bold**. edited'));
 await open('empty.md');await page.getByRole('button',{name:'Edit file',exact:true}).click();await page.getByRole('button',{name:'Start writing Markdown',exact:true}).click();await page.keyboard.insertText('First **note**.\n');assert.equal(await page.evaluate(()=>{const e=new Event('beforeunload',{cancelable:true});dispatchEvent(e);return e.defaultPrevented;}),true);await page.getByRole('button',{name:'Save file',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.explorer-preview-name').classList.contains('is-dirty'));assert.equal(await readFile(join(project,'empty.md'),'utf8'),'First **note**.\n');

 phase='external save conflict preserves draft';
 await open('main.ts');await page.getByRole('button',{name:'Edit file',exact:true}).click();await replace('// unsaved draft\nconst value = 7;\n');
 await writeFile(join(project,'main.ts'),'// external edit\n');const conflict=page.waitForResponse(response=>response.url().endsWith('/api/files/document')&&response.request().method()==='POST');await page.getByRole('button',{name:'Save file',exact:true}).click();assert.equal((await conflict).status(),409);
 await page.locator('.explorer-document-status.is-error').filter({hasText:'changed on disk'}).waitFor();assert((await content().innerText()).includes('unsaved draft'));assert.equal(await readFile(join(project,'main.ts'),'utf8'),'// external edit\n');
 await page.evaluate(()=>globalThis.__codexWebuiI18n.setPreference('zh-CN'));await page.getByRole('button',{name:'保存文件',exact:true}).waitFor();await page.getByRole('textbox',{name:'文件编辑器',exact:true}).waitFor();
 await page.evaluate(()=>globalThis.__codexWebuiI18n.setPreference('en'));await page.getByRole('textbox',{name:'File editor',exact:true}).waitFor();assert((await content().innerText()).includes('unsaved draft'));
 await page.locator('#themeSelect').evaluate(el=>{el.value='light';el.dispatchEvent(new Event('change',{bubbles:true}));});assert.equal(await page.locator('html').getAttribute('data-theme'),'light');await page.screenshot({path:artifact('file-editor-code-light.png')});
 page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Reload file',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.cm-content')?.textContent.includes('external edit'));
 phase='read-only and narrow editing';
 await open('locked.txt');await page.locator('.explorer-code').filter({hasText:'Read only fixture'}).waitFor();assert.equal(await page.getByRole('button',{name:'Edit file',exact:true}).isDisabled(),true);
 await open('README.md');await page.getByRole('button',{name:'Edit file',exact:true}).click();await page.getByRole('button',{name:'View source',exact:true}).click();
 for(const width of [820,390]){await page.setViewportSize({width,height:844});await content().waitFor();await page.waitForTimeout(600);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);await content().click();await page.keyboard.press('ControlOrMeta+End');await page.keyboard.insertText('手机和平板编辑\n');await page.keyboard.press('ControlOrMeta+z');await page.screenshot({path:artifact(`file-editor-${width}.png`)});}
 await page.getByRole('button',{name:'Preview',exact:true}).click();await page.locator('.markdown-file-block').filter({has:page.locator('h1')}).click();await content().waitFor();await page.screenshot({path:artifact('file-editor-markdown-mobile.png')});
 phase='older backend retains read-only preview';
 const older=await context.newPage();older.on('pageerror',error=>errors.push(error.message));await older.route('**/api/files/document**',route=>route.fulfill({status:404,contentType:'application/json',body:'{}'}));await older.goto(base,{waitUntil:'networkidle'});await older.waitForFunction(()=>globalThis.__codexWebuiDebug?.state.connected);await older.locator('#toggleSidePanel').click();await older.locator('[data-side-panel-action=files]').click();await older.locator('#sideFileContent').getByRole('treeitem',{name:'main.ts',exact:true}).locator(':scope > .explorer-row-line').click();await older.locator('.explorer-code').filter({hasText:'external edit'}).waitFor();assert.equal(await older.getByRole('button',{name:'Edit file',exact:true}).isDisabled(),true);await older.locator('.explorer-document-status').filter({hasText:'Update the running WebUI service'}).waitFor();await older.close();
 assert.deepEqual(errors,[]);console.log('PASS: authenticated same-origin scoped writes, syntax highlighting, code editing/save shortcuts, exact Markdown block editing/live preview, draft/discard, external conflict, read-only, locale/theme and phone/tablet containment');
}catch(error){console.error('Failed phase:',phase);if(page){await page.screenshot({path:artifact('file-editor-failure.png')}).catch(()=>{});console.error(await page.locator('body').innerText());}throw error;}finally{await browser?.close();server.kill('SIGTERM');await server.exited;await rm(temp,{recursive:true,force:true});}
