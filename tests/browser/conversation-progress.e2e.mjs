import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, delimiter } from 'node:path';
import { chromium } from 'playwright';
import { root, artifact, launchOptions } from '../helpers/browser-runtime.mjs';

const temp=await mkdtemp('/tmp/crw-progress-'),home=join(temp,'home'),project=join(temp,'project'),log=join(temp,'rpc.jsonl');
await Promise.all([mkdir(home),mkdir(project)]);
const imagePath=join(project,'generated.png');
await writeFile(imagePath,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jT1sAAAAASUVORK5CYII=','base64'));
const port=await new Promise(resolve=>{const probe=createServer();probe.listen(0,'127.0.0.1',()=>{const port=probe.address().port;probe.close(()=>resolve(port));});}),base=`http://127.0.0.1:${port}`;
const server=Bun.spawn(['bun','src/server/index.ts'],{cwd:root,stdout:'ignore',stderr:'ignore',env:{...process.env,HOME:home,CODEX_HOME:home,CODEX_AUTH_PATH:join(home,'auth.json'),CODEX_WEBUI_CWD:project,CODEX_WEBUI_REVIEW_ROOT:project,CODEX_WEBUI_AUTH_MODE:'local',HOST:'127.0.0.1',PORT:String(port),CODEX_WEBUI_ENABLE_TERMINAL:'false',CODEX_WEBUI_FIXTURE_CONVERSATION_TOOLS:'true',CODEX_WEBUI_FIXTURE_PROGRESS:'true',CODEX_WEBUI_FIXTURE_LOG:log,PATH:join(root,'tests/fixtures')+delimiter+process.env.PATH}});
let browser,page,phase='startup';
try{
  for(let i=0;;i++){try{if((await(await fetch(base+'/api/health')).json()).codex)break;}catch{}if(i>100)throw Error('startup');await Bun.sleep(50);}
  browser=await chromium.launch(launchOptions());
  const context=await browser.newContext({viewport:{width:1074,height:760},colorScheme:'dark'});
  await context.addInitScript(()=>{if(window===window.top)localStorage.setItem('codex-webui-locale','en');});
  page=await context.newPage();page.setDefaultTimeout(10000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base,{waitUntil:'networkidle'});await page.waitForFunction(()=>globalThis.__codexWebuiDebug?.state.connected);
  phase='animated read loading, bounded render and work ordering';
  await page.evaluate(()=>{window.historyOpening=globalThis.__codexWebuiDebug.openThread('progress-history');});
  await page.locator('.conversation-load-spinner').waitFor();
  assert.equal(await page.locator('#conversation').getAttribute('aria-busy'),'true');
  assert.equal(await page.locator('.conversation-load-progress progress').getAttribute('value'),null);
  assert.equal(await page.locator('#sendButton').isDisabled(),true);
  await page.evaluate(()=>{
    const d=globalThis.__codexWebuiDebug,p={threadId:'progress-history',turnId:'history-replay'};
    d.notify('turn/started',{...p,turn:{id:p.turnId}});
    d.notify('item/started',{...p,item:{id:'read',type:'commandExecution',command:'cat README.md'}});
    d.notify('turn/diff/updated',{...p,diff:''});
    void d.request({id:'loading-approval',method:'item/commandExecution/requestApproval',params:{...p,itemId:'read',command:'cat README.md'}});
  });
  assert.equal(await page.locator('#conversation .runtime-progress').count(),0);
  assert.equal(await page.locator('#conversation .activity-group').count(),0);
  assert.equal(await page.locator('#conversation .approval-card').count(),0);
  await page.evaluate(()=>globalThis.__codexWebuiDebug.notify('serverRequest/resolved',{requestId:'loading-approval'}));
  await page.screenshot({path:artifact('conversation-history-loading.png')});
  // Record the real item counts while the browser gets rendering opportunities.
  await page.evaluate(()=>{window.renderCounts=[];new MutationObserver(()=>{const p=document.querySelector('.conversation-load-progress progress[value]');if(p)window.renderCounts.push([p.value,p.max]);}).observe(document.querySelector('#conversation'),{subtree:true,childList:true,attributes:true});});
  assert.equal(await page.evaluate(()=>window.historyOpening),true);
  assert.equal(await page.locator('#conversation').getAttribute('aria-busy'),null);
  assert.equal(await page.locator('#conversation .runtime-progress').count(),0);
  await page.evaluate(()=>{
    const d=globalThis.__codexWebuiDebug,p={threadId:'progress-history',turnId:'history-24'};
    d.notify('turn/diff/updated',{...p,diff:''});
    d.notify('item/completed',{...p,item:{id:'completed-read',type:'commandExecution',command:'cat README.md',aggregatedOutput:'historical'}});
    d.notify('turn/completed',{...p,turn:{id:p.turnId,status:'completed',items:[]}});
  });
  assert.equal(await page.locator('#conversation .runtime-progress').count(),0);
  assert.equal(await page.locator('.native-turn-timeline').count(),20);
  assert.match(await page.locator('.load-older').innerText(),/5/);
  assert(await page.evaluate(()=>window.renderCounts.some(([value,max])=>value>0&&value<max)), 'rendering must yield and expose actual progress');
  const last=page.locator('[data-turn-id=history-24]');
  await last.locator('.turn-work-toggle').click();
  const positions=await last.evaluate(el=>{const d=el.querySelector('.worked-for-divider').getBoundingClientRect(),b=el.querySelector('.assistant-body').getBoundingClientRect(),f=el.querySelector('.turn-final-slot').getBoundingClientRect();return {divider:d.bottom,body:b.top,end:b.bottom,final:f.top};});
  assert(positions.body>=positions.divider&&positions.final>=positions.end,'expanded details belong below their disclosure and above the answer');
  assert.equal(await last.locator('.turn-work-toggle').getAttribute('aria-controls'),await last.locator('.assistant-body').getAttribute('id'));
  await page.screenshot({path:artifact('conversation-work-below-disclosure.png')});
  await page.locator('.load-older').click();assert.equal(await page.locator('.native-turn-timeline').count(),25);

  phase='context summaries stay in collapsible work details';
  await page.evaluate(()=>{
    const d=globalThis.__codexWebuiDebug;
    const summary={id:'msg-compaction',type:'agentMessage',phase:'final_answer',text:'**Current Objective**\n\nContinue the fixture.'};
    const turn={id:'compaction-fixture',status:'inProgress',items:[summary]};
    d.syncTurnSnapshot(turn);
    d.syncTurnSnapshot({...turn,items:[{...summary,phase:'context_summary'}]});
    d.syncTurnSnapshot({...turn,status:'completed',items:[
      {...summary,id:'item-compaction'},
      {id:'item-answer',type:'agentMessage',phase:'final_answer',text:'The work is complete.'},
    ]});
  });
  const compacted=page.locator('[data-turn-id=compaction-fixture]');
  assert.equal(await compacted.locator('.turn-final-slot').innerText(),'The work is complete.');
  await compacted.getByRole('button',{name:'Show work'}).click();
  const summary=compacted.locator('.context-compaction-summary');
  assert.equal(await summary.count(),1);
  assert.equal(await summary.locator('.message-text').isVisible(),false);
  await summary.locator('summary').click();
  assert.equal(await summary.locator('.message-text').isVisible(),true);
  await summary.locator('summary').click();
  await compacted.screenshot({path:artifact('conversation-context-summary.png')});

  phase='a genuinely running history resumes its indicator only after loading';
  await page.evaluate(()=>{window.activeOpening=globalThis.__codexWebuiDebug.openThread('progress-active');});
  await page.locator('.conversation-load-spinner').waitFor();
  assert.equal(await page.locator('#conversation .runtime-progress').count(),0);
  assert.equal(await page.evaluate(()=>window.activeOpening),true);
  await page.locator('[data-turn-id=history-active] .runtime-heading strong').filter({hasText:'Working'}).waitFor();
  assert.equal(await page.locator('#conversation').getAttribute('aria-busy'),null);

  phase='safe failed-read retry and navigation cancellation';
  await page.clock.install();
  await page.locator('#prompt').fill('Keep this draft');
  assert.equal(await page.evaluate(()=>globalThis.__codexWebuiDebug.openThread('progress-fail')),false);
  assert.equal(await page.getByRole('button',{name:'Retry loading',exact:true}).isVisible(),false);
  await page.clock.fastForward(60000);
  await page.evaluate(()=>globalThis.__codexWebuiI18n.setPreference('zh-CN'));
  await page.getByRole('button',{name:'重新加载',exact:true}).waitFor();
  await page.evaluate(()=>globalThis.__codexWebuiI18n.setPreference('en'));
  await page.getByRole('button',{name:'Retry loading',exact:true}).click();
  await page.locator('.conversation-load-progress').waitFor({state:'detached'});
  await page.clock.resume();
  assert.equal(await page.evaluate(()=>globalThis.__codexWebuiDebug.state.active.id),'progress-fail');
  await page.evaluate(()=>{void globalThis.__codexWebuiDebug.openThread('progress-history');});
  await page.locator('#conversationRefresh').waitFor();
  await page.evaluate(()=>globalThis.__codexWebuiDebug.openThread('thread-B'));
  await page.waitForTimeout(1400);
  assert.equal(await page.evaluate(()=>globalThis.__codexWebuiDebug.state.active.id),'thread-B');
  assert.equal(await page.locator('[data-turn-id=history-24]').count(),0);
  await page.evaluate(()=>{void globalThis.__codexWebuiDebug.openThread('progress-history');globalThis.__codexWebuiDebug.startNewTask();});
  await page.waitForTimeout(1400);assert.equal(await page.locator('#emptyState').count(),1);
  assert.equal(await page.locator('#conversation').getAttribute('aria-busy'),null);

  phase='large history opens a recent page and keeps its cursor when cached';
  const pagedIds = () => page.locator('#conversation .native-turn-timeline').evaluateAll(turns => turns.map(turn => turn.dataset.turnId));
  const pagedRange = (start, length) => Array.from({length}, (_, index) => `paged-${start + index}`);
  const openPaged = () => page.evaluate(() => globalThis.__codexWebuiDebug.openThread('progress-paged'));
  assert.equal(await openPaged(), true);
  assert.deepEqual(await pagedIds(), pagedRange(7, 5));
  await page.evaluate(() => globalThis.__codexWebuiDebug.openThread('thread-B'));
  assert.equal(await openPaged(), true);
  const older = page.getByRole('button', {name:'Load earlier messages', exact:true});
  await older.click();
  await page.locator('[data-turn-id=paged-2]').waitFor();
  assert.deepEqual(await pagedIds(), pagedRange(2, 10));
  await older.click();
  await page.locator('[data-turn-id=paged-0]').waitFor();
  assert.deepEqual(await pagedIds(), pagedRange(0, 12));
  assert.equal(await older.count(), 0);

  phase='native running events, plan, approvals, connection and completion';
  await page.evaluate(()=>{const d=globalThis.__codexWebuiDebug;d.state.active={id:'runtime-thread',cwd:d.state.config.defaultCwd,turns:[]};d.notify('turn/started',{threadId:'runtime-thread',turn:{id:'runtime'}});});
  const status=page.locator('[data-turn-id=runtime] .runtime-progress');
  await status.locator('.runtime-heading strong').getByText('Working',{exact:true}).waitFor();
  const disclosure=status.locator('.runtime-heading');
  const workBody=page.locator('[data-turn-id=runtime] .assistant-body');
  assert.equal(await status.getAttribute('open'),null);
  const notify=async(method,params)=>page.evaluate(({method,params})=>globalThis.__codexWebuiDebug.notify(method,{threadId:'runtime-thread',turnId:params.turn?.id||'runtime',...params}),{method,params});
  await notify('item/reasoning/summaryTextDelta',{itemId:'reason',delta:'Inspecting source',summaryIndex:0});
  await disclosure.getByText('Thinking',{exact:true}).waitFor();
  await notify('item/completed',{item:{id:'reason',type:'reasoning',summary:['Inspecting source']}});
  await notify('item/started',{item:{id:'note',type:'agentMessage',phase:'commentary',text:''}});
  await notify('item/agentMessage/delta',{itemId:'note',delta:'I will run the focused checks.'});
  const commentary=workBody.getByText('I will run the focused checks.',{exact:true});
  await commentary.waitFor();
  await notify('item/completed',{item:{id:'note',type:'agentMessage',phase:'commentary',text:'I will run the focused checks.'}});
  await notify('item/started',{item:{id:'read',type:'commandExecution',command:'cat README.md'}});
  await disclosure.getByText('Reading',{exact:true}).waitFor();
  assert.equal(await workBody.locator('[data-item-id=read]').isVisible(),true);
  await disclosure.press('Enter');
  await status.locator('.runtime-detail').getByText('README.md',{exact:true}).waitFor();
  await notify('item/completed',{item:{id:'read',type:'commandExecution',command:'cat README.md'}});
  await notify('item/started',{item:{id:'cmd',type:'commandExecution',command:'bun test'}});
  await disclosure.getByText('Running command',{exact:true}).waitFor();
  await notify('item/commandExecution/outputDelta',{itemId:'cmd',delta:'starting tests\n'});
  await notify('turn/plan/updated',{plan:[{step:'Inspect source',status:'completed'},{step:'Run tests',status:'inProgress'},{step:'Report',status:'pending'}]});
  assert.equal(await status.locator('progress').getAttribute('value'),'1');
  assert.equal(await status.locator('progress').getAttribute('max'),'3');
  await status.locator('.runtime-plan summary').click();
  await status.getByText('• Run tests',{exact:true}).waitFor();
  await disclosure.press('Space');
  assert.equal(await workBody.locator('[data-item-id=read]').isVisible(),false);
  await workBody.getByText('starting tests',{exact:true}).waitFor();
  await commentary.waitFor();
  await page.screenshot({path:artifact('conversation-running-command.png')});
  await disclosure.click();
  await page.screenshot({path:artifact('conversation-running-expanded.png')});
  await disclosure.click();
  await page.evaluate(()=>globalThis.__codexWebuiDebug.request({id:'runtime-approval',method:'item/commandExecution/requestApproval',params:{threadId:'runtime-thread',turnId:'runtime',itemId:'cmd',command:'bun test',availableDecisions:['accept','acceptForSession','decline']}}));
  await disclosure.getByText('Waiting for approval',{exact:true}).waitFor();
  assert(await page.locator('[data-turn-id=runtime] .approval-card').isVisible());
  await commentary.waitFor();
  for(const width of [390,768,1280]){
    await page.setViewportSize({width,height:580});
    const approval=page.getByRole('button',{name:'Approval options'});
    await approval.click();
    const option=page.getByRole('menuitem',{name:'Allow this conversation'});
    await option.waitFor();
    assert(await option.evaluate(el=>{const r=el.getBoundingClientRect();return el.closest('.workspace-popup').parentElement===document.body&&r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight&&el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}));
    await page.screenshot({path:artifact(`approval-options-${width}.png`)});
    await page.keyboard.press('Escape');
    await option.waitFor({state:'detached'});
    assert(await approval.evaluate(el=>document.activeElement===el));
  }
  await page.evaluate(()=>{globalThis.__codexWebuiDebug.state.connected=false;});
  await notify('turn/plan/updated',{plan:[]});
  await disclosure.getByText('Connection interrupted',{exact:true}).waitFor();
  await page.evaluate(()=>{globalThis.__codexWebuiDebug.state.connected=true;});
  await notify('serverRequest/resolved',{requestId:'runtime-approval'});
  await disclosure.getByText('Running command',{exact:true}).waitFor();
  assert.equal(await page.locator('.activity-group.waiting-approval').count(),0);
  await notify('item/completed',{item:{id:'cmd',type:'commandExecution',command:'bun test'}});
  assert.equal(await workBody.locator('[data-item-id=cmd]').isVisible(),false);
  await disclosure.click();
  const commandGroup=workBody.locator('.activity-group').filter({has:page.locator('[data-item-id=cmd]')});
  if(!await workBody.locator('[data-item-id=cmd]').isVisible())await commandGroup.locator('.activity-summary').click();
  assert(await workBody.locator('[data-item-id=cmd]').isVisible());
  await disclosure.click();
  await notify('item/started',{item:{id:'edit',type:'fileChange',changes:[{path:'main.ts',diff:'@@ -1 +1 @@\n-old\n+new'}]}});
  await disclosure.getByText('Editing files',{exact:true}).waitFor();
  assert.equal(await status.locator('.runtime-detail').textContent(),'main.ts');
  await notify('item/completed',{item:{id:'edit',type:'fileChange',changes:[]}});
  await notify('item/started',{item:{id:'search',type:'webSearch',query:'fixture search'}});
  await disclosure.getByText('Searching the web',{exact:true}).waitFor();
  assert(await workBody.locator('.web-search-terms').isVisible());
  await notify('item/completed',{item:{id:'search',type:'webSearch',query:'fixture search'}});
  await notify('item/started',{item:{id:'image',type:'imageGeneration'}});
  await disclosure.getByText('Generating image',{exact:true}).waitFor();
  await page.locator('[data-turn-id=runtime] .generated-image-pending').waitFor();
  await notify('item/completed',{item:{id:'image',type:'imageGeneration',src:imagePath}});
  const generated=page.locator('[data-turn-id=runtime] .generated-image-reveal .message-image-button');
  await generated.waitFor();
  await page.waitForFunction(()=>document.querySelector('.generated-image-reveal img')?.naturalWidth>0);
  await commentary.waitFor();
  await notify('item/agentMessage/delta',{itemId:'reply',delta:'Ready to review'});
  await disclosure.getByText('Writing response',{exact:true}).waitFor();
  const answer=page.locator('[data-turn-id=runtime] .turn-final-slot.is-streaming');
  await answer.getByText('Ready to review',{exact:true}).waitFor();
  await disclosure.focus();
  await notify('turn/completed',{turn:{id:'runtime',status:'completed',items:[]}});
  assert.equal(await status.count(),0);
  assert.equal(await answer.count(),0);
  assert.equal(await page.locator('[data-turn-id=runtime] .turn-work-toggle').evaluate(el=>el===document.activeElement),true);

  phase='mobile, Chinese and reduced motion';
  await page.setViewportSize({width:390,height:844});
  await page.emulateMedia({reducedMotion:'reduce',colorScheme:'light'});
  await page.evaluate(()=>globalThis.__codexWebuiI18n.setPreference('zh-CN'));
  await notify('turn/started',{turn:{id:'mobile'}});
  await notify('item/started',{turnId:'mobile',item:{id:'mobile-cmd',type:'commandExecution',command:'bun test '+ 'long-argument '.repeat(30)}});
  await page.locator('[data-turn-id=mobile] .runtime-heading strong').filter({hasText:'运行命令'}).waitFor();
  assert.equal(await page.locator('[data-turn-id=mobile] .runtime-glyph').evaluate(el=>getComputedStyle(el).animationName),'none');
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:artifact('conversation-progress-mobile-zh.png')});
  await notify('turn/completed',{turn:{id:'mobile',status:'failed'}});
  await page.locator('[data-turn-id=mobile] .runtime-heading strong').filter({hasText:'工作执行失败'}).waitFor();
  await page.evaluate(()=>globalThis.__codexWebuiI18n.setPreference('en'));
  await page.locator('[data-turn-id=mobile] .runtime-heading strong').filter({hasText:'Work failed'}).waitFor();

  phase='read-only timeout clears a lost WebSocket request';
  await page.evaluate(()=>{
    const d=globalThis.__codexWebuiDebug,send=d.state.ws.send.bind(d.state.ws);
    d.state.ws.send=raw=>{const message=JSON.parse(raw);if(message.method==='thread/read'&&message.params.threadId==='dropped-history'){window.droppedRead=message.id;return;}send(raw);};
    window.timeoutOpening=d.openThread('dropped-history');
  });
  await page.clock.fastForward(8500);
  assert.equal(await page.getByRole('button',{name:'Retry loading',exact:true}).isVisible(),false);
  await page.clock.fastForward(50500);
  assert.equal(await page.getByRole('button',{name:'Retry loading',exact:true}).isVisible(),false);
  await page.clock.fastForward(1000);
  await page.getByText(/History is taking longer to load/).waitFor();
  await page.getByRole('button',{name:'Retry loading',exact:true}).waitFor();
  await page.clock.fastForward(30001);
  assert.equal(await page.evaluate(()=>window.timeoutOpening),false);
  await page.getByText('Could not load conversation',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>globalThis.__codexWebuiDebug.state.pending.has(window.droppedRead)),false);

  phase='history loading over SSE';
  const sseContext=await browser.newContext({viewport:{width:1074,height:760}});
  await sseContext.addInitScript(()=>{
    if(window!==window.top)return;
    localStorage.setItem('codex-webui-locale','en');
    const Native=globalThis.WebSocket;
    globalThis.WebSocket=class extends Native{constructor(url,...rest){if(new URL(url,location.href).pathname==='/ws')throw Error('Fixture: force SSE');super(url,...rest);}};
  });
  const ssePage=await sseContext.newPage();ssePage.on('pageerror',error=>errors.push(error.message));
  await ssePage.goto(base,{waitUntil:'domcontentloaded'});
  await ssePage.waitForFunction(()=>globalThis.__codexWebuiDebug?.state.transport==='sse'&&globalThis.__codexWebuiDebug.state.connected);
  assert.equal(await ssePage.evaluate(()=>globalThis.__codexWebuiDebug.openThread('progress-history')),true);
  assert.equal(await ssePage.locator('.native-turn-timeline').count(),20);
  assert.equal(await ssePage.locator('#conversation').getAttribute('aria-busy'),null);

  phase='cached turn displayed with the refresh response held';
  await ssePage.evaluate(()=>globalThis.__codexWebuiDebug.openThread('thread-B'));
  let releaseRead, readStarted, readCount=0;
  const pendingRead=new Promise(resolve=>{readStarted=resolve});
  const release=new Promise(resolve=>{releaseRead=resolve});
  await ssePage.route('**/api/rpc',async route=>{
    const {method,params}=route.request().postDataJSON();
    if(method==='thread/read'&&params?.threadId==='progress-history'&&params.includeTurns&&++readCount===1){
      readStarted();
      await release;
    }
    await route.continue();
  });
  const reopen=()=>ssePage.evaluate(()=>{window.reopening=globalThis.__codexWebuiDebug.openThread('progress-history');});
  await reopen();
  await pendingRead;
  const cachedTurn=ssePage.locator('[data-turn-id=history-24]'), refresh=ssePage.locator('#conversationRefresh');
  await cachedTurn.waitFor();
  assert.equal(await ssePage.locator('.conversation-load-progress').count(),0);
  assert.equal(await refresh.innerText(),'Updating conversation…');
  await ssePage.locator('#prompt').fill('Keep this while revalidating');
  await ssePage.locator('#prompt').press('Enter');
  assert.equal(await ssePage.locator('#sendButton').isDisabled(),true);
  await ssePage.evaluate(()=>globalThis.__codexWebuiDebug.openThread('thread-B'));
  await reopen();
  await cachedTurn.waitFor();
  await cachedTurn.evaluate(el=>{el.dataset.fixturePreserved='true';});
  releaseRead();
  assert.equal(await ssePage.evaluate(()=>window.reopening),true);
  assert.equal(readCount,1,'rapid revisits share the same read');
  assert.equal(await cachedTurn.getAttribute('data-fixture-preserved'),'true','unchanged history is not rebuilt');
  assert.equal(await ssePage.locator('#prompt').inputValue(),'Keep this while revalidating');
  assert.equal(await ssePage.locator('#sendButton').isDisabled(),false);
  assert.equal(await ssePage.locator('.load-older').count(),1);

  phase='offline cached revisit';
  await ssePage.evaluate(()=>globalThis.__codexWebuiDebug.openThread('thread-B'));
  await sseContext.setOffline(true);
  await ssePage.waitForFunction(()=>!navigator.onLine);
  const beforeOffline=readCount;
  await reopen();
  await cachedTurn.waitFor();
  assert.match(await refresh.innerText(),/Offline · Showing previously loaded messages/);
  assert.equal(await ssePage.locator('#sendButton').isDisabled(),true);
  assert.equal(readCount,beforeOffline,'offline revisit does not try to read the network');
  await sseContext.setOffline(false);
  await refresh.waitFor({state:'hidden'});
  assert.equal(await ssePage.locator('#prompt').inputValue(),'Keep this while revalidating');
  assert.equal(await ssePage.locator('#sendButton').isDisabled(),false);

  phase='listed history paginates across recent-list refreshes';
  let releasePage;
  const holdOlderPage=new Promise(resolve=>{releasePage=resolve;});
  let newTurns=[];
  const historyRoute=async route=>{
    const {method,params}=route.request().postDataJSON();
    if(method==='thread/list'&&!params.cwd){
      const response=await route.fetch(),json=await response.json();
      json.result.data.push({id:'progress-paged',cwd:project,name:'Listed paged history'});
      await route.fulfill({response,json});return;
    }
    if(method==='thread/turns/list'&&params.threadId==='progress-paged'){
      if(params.cursor)await holdOlderPage;
      const response=await route.fetch(),json=await response.json();
      if(!params.cursor)json.result.data=[...newTurns,...json.result.data].slice(0,params.limit);
      await route.fulfill({response,json});return;
    }
    await route.fallback();
  };
  await ssePage.route('**/api/rpc',historyRoute);
  await ssePage.waitForFunction(()=>globalThis.__codexWebuiDebug.state.threads.some(thread=>thread.id==='progress-paged'));
  await ssePage.evaluate(async()=>{
    const d=globalThis.__codexWebuiDebug;
    await d.openThread('progress-paged');
    window.beforeListRefresh=d.state.active;
  });
  const waitForListRefresh=()=>ssePage.waitForFunction(()=>globalThis.__codexWebuiDebug.state.active!==window.beforeListRefresh);
  await waitForListRefresh();
  await Promise.all([
    ssePage.waitForRequest(req=>req.url().endsWith('/api/rpc')&&req.postDataJSON()?.method==='thread/turns/list'&&req.postDataJSON()?.params?.cursor),
    ssePage.locator('.load-older').click(),
  ]);
  assert.equal(await ssePage.locator('.load-older').isDisabled(),true);
  await ssePage.evaluate(()=>{window.beforeListRefresh=globalThis.__codexWebuiDebug.state.active;});
  await waitForListRefresh();
  releasePage();
  await ssePage.locator('[data-turn-id=paged-2]').waitFor();
  assert.equal(await ssePage.locator('#conversation .native-turn-timeline').count(),10);

  phase='recent cache reconciles turns missed between visits';
  await ssePage.evaluate(()=>globalThis.__codexWebuiDebug.openThread('thread-B'));
  newTurns=['latest','middle'].map(id=>({id,status:'completed',items:[{id:'answer-'+id,type:'agentMessage',phase:'final_answer',text:'Missed reply '+id}]}));
  assert.equal(await ssePage.evaluate(()=>globalThis.__codexWebuiDebug.openThread('progress-paged')),true);
  await ssePage.locator('[data-turn-id=middle]').waitFor();
  await ssePage.locator('[data-turn-id=latest]').waitFor();
  await ssePage.unroute('**/api/rpc',historyRoute);
  await sseContext.close();

  phase='preloaded pins and background streaming';
  const pinnedContext=await browser.newContext({viewport:{width:1074,height:760}});
  await pinnedContext.addInitScript(()=>{
    localStorage.setItem('codex-remote-web-pins',JSON.stringify(['thread-A','progress-active']));
    const Native=globalThis.WebSocket;
    globalThis.WebSocket=class extends Native{constructor(url,...rest){if(new URL(url,location.href).pathname==='/ws')throw Error('Fixture: force SSE');super(url,...rest);}};
  });
  const pinnedPage=await pinnedContext.newPage(), reads=[];
  pinnedPage.on('request',req=>{
    if(!req.url().endsWith('/api/rpc'))return;
    const request=req.postDataJSON();
    if(request.method==='thread/read'&&request.params.includeTurns)reads.push(request.params.threadId);
  });
  await pinnedPage.goto(base);
  const pinned=pinnedPage.locator('[data-section=pinned]');
  await pinned.locator('[data-id=progress-active] .thread-open').waitFor();
  assert.deepEqual(reads,['thread-A','progress-active'],'only pinned chats preload, including a chat outside Recents');
  await pinned.locator('[data-id=thread-A] .thread-open').click();
  await pinnedPage.waitForFunction(()=>globalThis.__codexWebuiDebug.state.active?.id==='thread-A');
  const delta=text=>pinnedPage.evaluate(delta=>globalThis.__codexWebuiDebug.notify('item/agentMessage/delta',{
    threadId:'progress-active',turnId:'history-active',itemId:'active-stream',phase:'final_answer',delta,
  }),text);
  await delta('Background');
  await pinned.locator('[data-id=progress-active] .thread-open').click();
  const pinnedAnswer=pinnedPage.locator('[data-turn-id=history-active] .turn-final-slot .message-text');
  await pinnedAnswer.filter({hasText:'Background'}).waitFor();
  assert.equal(await pinnedAnswer.getAttribute('data-raw'),'Background');
  await pinned.locator('[data-id=thread-A] .thread-open').click();
  await delta(' stream');
  await pinned.locator('[data-id=progress-active] .thread-open').click();
  await pinnedAnswer.filter({hasText:'Background stream'}).waitFor();
  await delta(' retained.');
  await pinnedAnswer.filter({hasText:'Background stream retained.'}).waitFor();
  assert.equal(await pinnedAnswer.getAttribute('data-raw'),'Background stream retained.');
  await pinnedPage.locator('#conversationRefresh').waitFor({state:'hidden'});
  assert(reads.filter(id=>id==='progress-active').length>1,'pinned chats revalidate after showing the cached stream');
  await pinnedPage.evaluate(()=>{
    window.refreshPinned=globalThis.__codexWebuiDebug.openThread('progress-active',null,true);
  });
  await pinnedPage.locator('#conversationRefresh').waitFor();
  await delta(' While refreshing.');
  await pinnedAnswer.filter({hasText:'While refreshing.'}).waitFor();
  assert.equal(await pinnedPage.evaluate(()=>window.refreshPinned),true);
  assert.equal(await pinnedAnswer.getAttribute('data-raw'),'Background stream retained. While refreshing.');
  await pinnedPage.screenshot({path:artifact('pinned-stream-cache.png')});
  await pinnedContext.close();
  assert.deepEqual(errors,[]);
  const records=(await readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(records.filter(record=>['turn/start','turn/steer'].includes(record.method)).length,0,'reads, retries and runtime presentation must never execute a message');
  console.log('PASS conversation progress: WS/SSE loading, measured render counts, slow read/timeout/retry, navigation, work order, native activity, plan, waiting, disconnect, completion, mobile/i18n/reduced motion; zero executions');
}catch(error){console.error('FAIL phase:',phase);if(page)await page.screenshot({path:artifact('conversation-progress-failure.png')}).catch(()=>{});throw error;}
finally{await browser?.close();server.kill();await server.exited;await rm(temp,{recursive:true,force:true});}
