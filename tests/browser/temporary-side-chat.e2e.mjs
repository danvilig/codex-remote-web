import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join,delimiter} from 'node:path';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright';
import {root,artifact,launchOptions} from '../helpers/browser-runtime.mjs';
const temp=await mkdtemp('/tmp/crw-temporary-side-'),home=join(temp,'home'),project=join(temp,'project'),codex=join(home,'.codex'),log=join(temp,'rpc.jsonl');
for(const dir of [home,project,codex])await mkdir(dir,{recursive:true});await writeFile(join(project,'README.md'),'Fixture');
const port=await new Promise(resolve=>{const s=createServer();s.listen(0,'127.0.0.1',()=>{const n=s.address().port;s.close(()=>resolve(n));});}),base=`http://127.0.0.1:${port}`;
const server=Bun.spawn(['bun','src/server/index.ts'],{cwd:root,stdout:'ignore',stderr:'ignore',env:{...process.env,HOME:home,CODEX_HOME:codex,CODEX_AUTH_PATH:join(codex,'auth.json'),CODEX_WEBUI_CWD:project,CODEX_WEBUI_REVIEW_ROOT:project,CODEX_WEBUI_AUTH_MODE:'local',HOST:'127.0.0.1',PORT:String(port),CODEX_WEBUI_ENABLE_TERMINAL:'false',CODEX_WEBUI_FIXTURE_CONVERSATION_TOOLS:'true',CODEX_WEBUI_FIXTURE_LOG:log,PATH:join(root,'tests/fixtures')+delimiter+process.env.PATH}});
const records=async()=>{try{return(await readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch{return[];}};
let browser,page,phase='startup';
try{
 for(let i=0;;i++){try{if((await(await fetch(base+'/api/health')).json()).codex)break;}catch{}if(i>100)throw Error('startup');await Bun.sleep(50);}
 for(const headers of [{'content-type':'application/json'},{origin:'https://evil.example','x-workspace-request':'1','content-type':'application/json'}])assert([401,403].includes((await fetch(base+'/api/conversation/side-chat',{method:'POST',headers,body:JSON.stringify({action:'create',sessionId:randomUUID(),cwd:project})})).status));
 browser=await chromium.launch(launchOptions());const context=await browser.newContext({viewport:{width:1280,height:900},colorScheme:'dark'});await context.addInitScript(()=>{if(window===window.top)localStorage.setItem('codex-webui-locale','en');});
 page=await context.newPage();page.setDefaultTimeout(10000);const errors=[];page.on('pageerror',error=>errors.push(error.message));
 const open=async()=>{await page.locator('#toggleSidePanel').click();await page.locator('[data-side-panel-action=side-chat]').click();};
 const side=page.locator('#sideChatPanel'),send=async text=>{await side.getByRole('textbox',{name:'Side chat message',exact:true}).fill(text);await side.getByRole('button',{name:'Send',exact:true}).click();};
 await page.goto(base,{waitUntil:'networkidle'});await page.waitForFunction(()=>globalThis.__codexWebuiDebug?.state.connected);await page.evaluate(()=>globalThis.__codexWebuiDebug.openThread('thread-A'));await page.locator('#prompt').fill('Main draft');
 phase='ephemeral source and independent history';await open();await send('Temporary question');await side.locator('.side-chat-answer').filter({hasText:'Side reply'}).waitFor();
 let calls=await records();const fork=calls.find(r=>r.method==='thread/fork');assert.deepEqual(fork.params,{threadId:'thread-A',lastTurnId:'second-turn',ephemeral:true,excludeTurns:true});
 const temporaryId=calls.find(r=>r.method==='turn/start').params.threadId;
 assert.equal(await page.evaluate(id=>globalThis.__codexWebuiDebug.state.threads.some(t=>t.id===id),temporaryId),false);assert.equal(await page.locator('#prompt').inputValue(),'Main draft');
 assert(!calls.some(r=>['thread/resume','thread/turns/list'].includes(r.method)&&r.params.threadId===temporaryId));
 phase='inline native approvals and questions';
 await send('[approval] Side approval');await side.locator('.approval-card .approval-deny').waitFor();assert.equal(await page.locator('#conversation .approval-card').count(),0);await side.getByRole('button',{name:'Deny',exact:true}).click();await side.locator('.approval-card').waitFor({state:'hidden'});await side.getByRole('button',{name:'Stop',exact:true}).waitFor({state:'hidden'});
 await send('[question] Side question');await side.getByRole('textbox',{name:'Which approach?',exact:true}).fill('Use the simple approach');await side.getByRole('button',{name:'Send answers',exact:true}).click();await side.locator('.user-input-card').waitFor({state:'hidden'});await side.getByRole('button',{name:'Stop',exact:true}).waitFor({state:'hidden'});
 await page.locator('#closeSidePanel').click();await page.locator('#toggleSidePanel').click();await side.locator('.side-chat-answer').first().waitFor();
 phase='explicit native context transfer without execution replay';calls=await records();const starts=calls.filter(r=>r.method==='turn/start').length;
 await side.getByRole('button',{name:'Save as regular chat',exact:true}).click();
 await page.waitForFunction(()=>globalThis.__codexWebuiDebug.state.active.id.startsWith('fork-'));
 calls=await records();assert.equal(calls.filter(r=>r.method==='turn/start').length,starts);
 const injection=calls.find(r=>r.method==='thread/inject_items');assert(injection);assert(injection.params.items.some(i=>i.role==='user'&&i.content.some(c=>c.text==='Temporary question')));assert(injection.params.items.some(i=>i.role==='assistant'&&i.content.some(c=>c.text==='Side reply')));
 assert.equal(await page.locator('#sideChatTab').count(),0);
 phase='discard active side tab and start a fresh branch';await page.locator('#openSidePanelTab').click();await page.locator('[data-side-panel-action=side-chat]').click();await send('[wait] Discard me');await side.getByRole('button',{name:'Stop',exact:true}).waitFor();
 const activeId=(await records()).filter(r=>r.method==='turn/start').at(-1).params.threadId;
 await page.locator('[data-close-tab=side-chat]').click();
 for(let i=0;;i++){if((await records()).some(r=>r.method==='thread/unsubscribe'&&r.params.threadId===activeId))break;if(i>100)throw Error('close did not release');await Bun.sleep(20);}
 assert((await records()).some(r=>r.method==='turn/interrupt'&&r.params.threadId===activeId));
 await page.locator('#openSidePanelTab').click();await page.locator('[data-side-panel-action=side-chat]').click();assert.equal(await side.getByRole('textbox',{name:'Side chat message',exact:true}).inputValue(),'');assert.equal(await side.locator('.side-chat-answer').count(),0);
 phase='reload releases temporary session';await send('Before reload');await side.locator('.side-chat-answer').first().waitFor();const reloadId=(await records()).filter(r=>r.method==='turn/start').at(-1).params.threadId;await page.reload({waitUntil:'networkidle'});
 for(let i=0;;i++){if((await records()).some(r=>r.method==='thread/unsubscribe'&&r.params.threadId===reloadId))break;if(i>100)throw Error('reload did not release');await Bun.sleep(20);}
 assert.equal(await page.locator('#sideChatTab').count(),0);assert.equal(await page.evaluate(id=>globalThis.__codexWebuiDebug.state.threads.some(t=>t.id===id),reloadId),false);
 phase='selected text and slash entry prepare without execution';
 await page.evaluate(()=>globalThis.__codexWebuiDebug.openThread('thread-A'));
 const countBefore=(await records()).filter(r=>r.method==='turn/start').length;
 await page.locator('#conversation .user-message').first().evaluate(node=>{const range=document.createRange();range.selectNodeContents(node);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);});
 await page.locator('#conversation .user-message').first().click({button:'right'});await page.getByRole('menuitem',{name:'Ask in side chat',exact:true}).click();assert.match(await side.getByRole('textbox',{name:'Side chat message',exact:true}).inputValue(),/First question/);
 await page.locator('#closeSidePanel').click();await page.locator('#prompt').fill('/side Explain this change');await page.locator('#composer').evaluate(form=>form.requestSubmit());await side.getByRole('textbox',{name:'Side chat message',exact:true}).waitFor();assert.equal(await side.getByRole('textbox',{name:'Side chat message',exact:true}).inputValue(),'Explain this change');assert.equal((await records()).filter(r=>r.method==='turn/start').length,countBefore);
 assert.deepEqual(errors,[]);await page.screenshot({path:artifact('temporary-side-chat.png')});
 console.log('PASS: protected memory-only native side branches, stable source prefix, no ephemeral history/resume, hidden-panel retention, explicit context import without execution, active-tab discard and page reload cleanup');
}catch(error){console.error('Failed phase:',phase);if(page){await page.screenshot({path:artifact('temporary-side-failure.png')}).catch(()=>{});console.error(await page.locator('body').innerText());}throw error;}finally{await browser?.close();server.kill('SIGTERM');await server.exited;await rm(temp,{recursive:true,force:true});}
