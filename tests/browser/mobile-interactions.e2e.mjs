import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join, delimiter } from 'node:path';
import { chromium } from 'playwright';
import { root, artifact, launchOptions } from '../helpers/browser-runtime.mjs';

const home = await mkdtemp(join(root, '.artifacts/mobile-interactions-'));
const port = await new Promise(resolve => { const probe = createServer(); probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => resolve(port)); }); });
const base = `http://127.0.0.1:${port}`, log = join(home, 'rpc.jsonl');
const gateway = Bun.spawn(['bun', 'src/server/index.ts'], { cwd:root, env:{...process.env, HOME:home, CODEX_HOME:home, CODEX_AUTH_PATH:join(home,'auth.json'), HOST:'127.0.0.1', PORT:String(port), CODEX_WEBUI_AUTH_MODE:'local', CODEX_WEBUI_CWD:home, CODEX_WEBUI_REVIEW_ROOT:home, CODEX_WEBUI_ENABLE_TERMINAL:'false', CODEX_WEBUI_ENABLE_REVIEW_WRITE:'false', CODEX_WEBUI_FIXTURE_LOG:log, PATH:`${join(root,'tests/fixtures')}${delimiter}${process.env.PATH}`}, stdout:'ignore', stderr:'ignore' });
let browser, activePage, progress='startup';
async function swipe(cdp, x, y, dx, dy) {
  const point = (x,y) => ({x,y,id:1});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point(x,y)]});
  for(let i=1;i<=10;i++) { await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[point(x+dx*i/10,y+dy*i/10)]}); await new Promise(resolve=>setTimeout(resolve,16)); }
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
}
async function stableLayout(page) {
  const metrics = await page.evaluate(() => {
    const chat = document.querySelector('#conversation');
    return {viewport:innerWidth,document:document.documentElement.scrollWidth,chat:chat.clientWidth,content:chat.scrollWidth,appRight:document.querySelector('#app').getBoundingClientRect().right};
  });
  assert.ok(metrics.document<=metrics.viewport+1 && metrics.content<=metrics.chat+1 && metrics.appRight<=metrics.viewport+1,JSON.stringify(metrics));
}
try {
  for(let i=0;;i++){ try {if((await (await fetch(base+'/api/health')).json()).codex)break;}catch{} if(i>100)throw new Error('Mobile fixture startup failed');await Bun.sleep(50); }
  browser = await chromium.launch(launchOptions());
  for(const width of [320,390,720,980]) {
    progress=`${width}px: load conversation`;
    const context=await browser.newContext({viewport:{width,height:844},isMobile:true,hasTouch:true,colorScheme:'dark'});
    await context.addInitScript(()=>{if(window===window.top)localStorage.setItem('codex-webui-locale','en');});
    const page=await context.newPage();activePage=page;page.setDefaultTimeout(8000);
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    const cdp=await context.newCDPSession(page);
    await page.goto(base,{waitUntil:'networkidle'});
    await page.evaluate(()=>globalThis.__codexWebuiDebug.openThread('thread-A'));
    await page.waitForFunction(()=>globalThis.__codexWebuiDebug.state.active?.id==='thread-A');
    await page.locator('#prompt').fill('Keep this draft');
    await page.evaluate(()=>{
      const debug=globalThis.__codexWebuiDebug;
      debug.syncTurnSnapshot({id:'overflow-turn',status:'completed',items:[
        {id:'long-user',type:'userMessage',content:[{type:'text',text:'x'.repeat(700)}]},
        {id:'wide-answer',type:'agentMessage',phase:'final_answer',text:'A long path: /'+ 'project/'.repeat(100)+'\n\n```text\n'+ 'very_long_code_'.repeat(100)+'\n```\n\n| '+Array.from({length:12},(_,i)=>'Column '+i).join(' | ')+' |\n| '+Array(12).fill('---').join(' | ')+' |\n| '+Array(12).fill('Long table value').join(' | ')+' |\n\n'+'A scrollable conversation.\n\n'.repeat(50)}]});
    });
    await stableLayout(page);
    const chat=await page.locator('#conversation').boundingBox();
    await swipe(cdp,Math.min(width-40,chat.x+chat.width-40),chat.y+100,-180,0);
    assert.equal(await page.locator('#conversation').evaluate(el=>el.scrollLeft),0,'Chat must not pan sideways');
    const code=page.locator('.message-text pre').first();
    await code.scrollIntoViewIfNeeded();
    assert.ok(await code.evaluate(el=>el.scrollWidth>el.clientWidth),'Wide code must retain its local scroll area');
    const box=await code.boundingBox();await swipe(cdp,Math.min(box.x+box.width-20,width-20),box.y+35,-120,0);
    assert.ok(await code.evaluate(el=>el.scrollLeft>0),'Code remains horizontally readable by touch');
    assert.equal(await page.locator('#conversation').evaluate(el=>el.scrollLeft),0);
    const table=page.locator('.markdown-table-scroll').first();await table.scrollIntoViewIfNeeded();
    assert.ok(await table.evaluate(el=>el.scrollWidth>el.clientWidth),'Wide tables keep usable column widths in a local scroll area');
    const tableBox=await table.boundingBox();await swipe(cdp,Math.min(tableBox.x+tableBox.width-20,width-20),tableBox.y+30,-130,0);
    assert.ok(await table.evaluate(el=>el.scrollLeft>0));
    assert.equal(await page.locator('#conversation').evaluate(el=>el.scrollLeft),0);
    progress=`${width}px: right panel`;
    await page.locator('#toggleSidePanel').click();
    await page.locator('#sidePanel:visible').waitFor();
    assert.equal(await page.locator('#toggleSidePanel').getAttribute('aria-expanded'),'true');
    assert.equal(await page.evaluate(()=>globalThis.__codexWebuiDebug.state.active.id),'thread-A');
    assert.equal(await page.locator('#prompt').inputValue(),'Keep this draft');
    assert.equal(await page.locator('.conversation-shell').evaluate(el=>el.inert),width<=720);
    await page.locator('#closeSidePanel').click();
    if(width<=720)await page.waitForFunction(()=>document.activeElement?.id==='toggleSidePanel');
    assert.equal(await page.locator('#sidebar').evaluate(el=>el.inert),true,'Hidden sidebar stays inert after closing a right overlay');
    progress=`${width}px: open left drawer`;
    await page.locator('#toggleSidebar').click();
    await page.waitForFunction(()=>Math.abs(document.querySelector('#sidebar').getBoundingClientRect().x)<1);
    assert.equal(await page.locator('.conversation-shell').evaluate(el=>el.inert),true,'Drawer isolates the background');
    await page.evaluate(()=>{const root=document.querySelector('#threadList');for(let i=0;i<60;i++){const row=document.createElement('div');row.className='thread-item';row.textContent='Scrollable thread '+i;root.append(row);}});
    const scroll=await page.locator('.sidebar-scroll').boundingBox();
    await swipe(cdp,scroll.x+150,Math.min(scroll.y+250,650),0,-160);
    assert.equal(await page.locator('#sidebar').evaluate(el=>el.classList.contains('mobile-open')),true,'Vertical scroll must not dismiss the drawer');
    progress=`${width}px: drawer vertical scroll`;
    await page.waitForFunction(()=>document.querySelector('.sidebar-scroll').scrollTop>0);
    await swipe(cdp,220,scroll.y+60,-25,0);
    assert.equal(await page.locator('#sidebar').evaluate(el=>el.classList.contains('mobile-open')),true,'Short gestures cancel');
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:220,y:scroll.y+70,id:1}]});
    await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:160,y:scroll.y+70,id:1}]});
    await cdp.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});
    assert.equal(await page.locator('#sidebar').evaluate(el=>el.classList.contains('mobile-open')&&!el.hasAttribute('data-swiping')),true,'Cancelled gestures restore the open drawer');
    await page.waitForFunction(()=>Math.abs(document.querySelector('#sidebar').getBoundingClientRect().x)<1);
    progress=`${width}px: dismiss after cancelled gesture`;
    await swipe(cdp,240,scroll.y+70,-180,5);
    await page.waitForFunction(()=>!document.querySelector('#sidebar').classList.contains('mobile-open'));
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('#sidebar')).visibility==='hidden');
    assert.equal(await page.locator('#sidebarBackdrop').isVisible(),false);
    assert.equal(await page.locator('.conversation-shell').evaluate(el=>el.inert),false);
    assert.equal(await page.locator('#prompt').inputValue(),'Keep this draft');
    assert.equal(await page.evaluate(()=>globalThis.__codexWebuiDebug.state.active.id),'thread-A','Swiping must not select a thread');
    await stableLayout(page);
    if(width===390)await page.screenshot({path:artifact('mobile-chat-contained.png')});
    assert.deepEqual(errors,[]);
    await context.close();
  }
  // The same visible rightmost button toggles the desktop panel too.
  const desktop=await browser.newPage({viewport:{width:1440,height:1000}});
  await desktop.goto(base,{waitUntil:'networkidle'});
  assert.equal(await desktop.locator('.top-actions > button').last().getAttribute('id'),'toggleSidePanel');
  await desktop.locator('#toggleSidePanel').click();await desktop.locator('#sidePanel:visible').waitFor();
  await desktop.locator('[data-side-panel-action=files]').click();
  await desktop.locator('#toggleSidePanel').click();assert.equal(await desktop.locator('#sidePanel').isVisible(),false);
  await desktop.locator('#toggleSidePanel').click();await desktop.locator('#utilityPanelContent:visible').waitFor();
  assert.equal(await desktop.locator('#filesTab').getAttribute('aria-selected'),'true','Reopening preserves the selected Files tab');
  assert.equal((await readFile(log,'utf8').catch(()=>'' )).includes('turn/start'),false);
  console.log('PASS: phone/tablet content containment, local code scrolling, right panel actions, drawer gestures, vertical scrolling, draft preservation and focus isolation');
}catch(error){console.error('Mobile regression failed:',progress);await activePage?.screenshot({path:artifact('mobile-interactions-failure.png')}).catch(()=>{});throw error;}
finally{await browser?.close();gateway.kill('SIGTERM');await gateway.exited;await rm(home,{recursive:true,force:true});}
