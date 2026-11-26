import assert from 'node:assert/strict';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { artifacts, launchOptions } from '../helpers/browser-runtime.mjs';
import { isolatedWorkspace } from '../helpers/isolated-workspace.mjs';

const fixture = await isolatedWorkspace();
const output = process.env.CODEX_COMPONENT_SCREENSHOTS || artifacts;
let browser;
const screenshot = (page, name) => page.screenshot({path:join(output, `${name}.png`),animations:'disabled'});
try {
  browser = await chromium.launch(launchOptions());
  for (const [name, width, height, mobile, colorScheme] of [
    ['desktop', 1280, 850, false, 'dark'], ['tablet', 768, 1024, true, 'light'], ['phone', 390, 844, true, 'light'], ['narrow', 320, 740, true, 'dark'],
  ]) {
    const context = await browser.newContext({viewport:{width,height},isMobile:mobile,hasTouch:mobile,colorScheme,permissions:['clipboard-read','clipboard-write'],reducedMotion:mobile?'reduce':'no-preference'});
    await context.addInitScript(()=>{if(window===window.top)localStorage.setItem('codex-webui-locale','zh-CN');});
    const page = await context.newPage(), errors=[];
    page.setDefaultTimeout(8000);
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(fixture.base);
    await page.waitForFunction(()=>globalThis.__codexWebuiDebug?.state.models.length>=2);
    await page.evaluate(async()=>{
      const d=globalThis.__codexWebuiDebug;
      await d.openThread('thread-A');
      d.state.threads.find(thread=>thread.id==='thread-A').name='移动端布局优化';
      d.state.active.name='移动端布局优化';d.renderHeader();
      d.notify('thread/name/updated',{threadId:'thread-B',name:'发布前检查'});
      d.notify('thread/name/updated',{threadId:'input-thread',name:'调整文件预览'});
      d.notify('thread/status/changed',{threadId:'thread-B',status:{type:'idle'}});
      d.syncTurnSnapshot({id:'design-example',status:'completed',items:[
        {id:'design-question',type:'userMessage',content:[{type:'text',text:'检查手机上的布局，并给出代码示例。'}]},
        {id:'design-answer',type:'agentMessage',phase:'final_answer',text:'### 手机布局检查\n\n已核对会话、输入框和设置。长代码可以在代码块内横向滚动。\n\n```ts\nconst widths = [320, 390, 768];\nfor (const width of widths) {\n  await checkLayout(width);\n}\n```\n\n下一步：验证深色主题和键盘操作。'},
      ]});
    });
    const copy = page.getByRole('button',{name:'复制代码',exact:true});
    await copy.waitFor();
    const keyword=page.locator('.markdown-code-block .tok-keyword').first();
    await keyword.waitFor();
    assert(await keyword.evaluate(el=>getComputedStyle(el).color!==getComputedStyle(el.closest('code')).color));
    assert.equal(await page.locator('.markdown-code-language').textContent(),'ts');
    await copy.click();
    assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),'const widths = [320, 390, 768];\nfor (const width of widths) {\n  await checkLayout(width);\n}\n');
    await page.locator('#modelButton').click();
    await page.locator('#modelSubmenuButton').click();
    const search=page.locator('#modelMenu input[type=search]');
    await search.waitFor();
    assert.equal(await search.evaluate(el=>el===document.activeElement),!mobile);
    assert.equal(await page.locator('#modelMenu [aria-pressed=true]').count(),1);
    if(name==='desktop'||name==='phone') {
      await page.locator('#toast.show').waitFor({state:'hidden'});
      await screenshot(page,`${name}-model-picker`);
    }
    await search.fill('missing-model');
    await page.getByText('没有匹配的模型',{exact:true}).waitFor();
    await search.press('Escape');assert.equal(await search.inputValue(),'');
    await search.fill('second');
    await search.press('ArrowDown');
    await page.keyboard.press('Enter');
    await search.waitFor({state:'hidden'});
    assert.equal(await page.evaluate(()=>globalThis.__codexWebuiDebug.state.selectedModel),'gpt-second-fixture');
    assert.equal(await page.locator('#modelButton').evaluate(el=>el===document.activeElement),true);
    await page.evaluate(()=>{
      const app=globalThis.__codexWebuiDebug;
      app.state.models.find(model=>model.model===app.state.selectedModel).displayName='GPT-6.2 Sol';
      app.renderModels();
      app.setPermissionMode('guardian-approvals');
    });
    assert.equal(await page.locator('#modelLabel').textContent(),'6.2 Sol');
    assert(await page.locator('#effortLabel').isVisible());
    await page.locator('#prompt').focus();
    assert.equal(await page.locator('#modelButton').evaluate(el=>getComputedStyle(el).borderTopWidth),'0px');
    for(const selector of ['#modelLabel','#modeButton .control-label']){
      const bounds=await page.locator(selector).evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth,overflow:getComputedStyle(el).textOverflow}));
      assert(bounds.scroll<=bounds.width+1,`${name} ${selector} ${JSON.stringify(bounds)}`);
    }
    await page.locator('#toast.show').waitFor({state:'hidden'});
    await screenshot(page,`${name}-composer-controls`);

    {
      await page.evaluate(()=>globalThis.__codexWebuiI18n.setPreference('en'));
      const toolbar=page.locator('#composer');
      const connection=page.locator('#composerConnectionStatus');
      await connection.evaluate(el=>el.textContent='Reconnecting to Codex · Draft editing is available');
      if(!mobile)await toolbar.evaluate(el=>el.style.maxWidth='450px');
      const label=page.locator('#modeButton .control-label');
      assert.equal(await label.textContent(),'Approve for me');
      const layout=await label.evaluate(el=>{
        const range=document.createRange();
        range.selectNodeContents(el);
        const footer=el.closest('.composer-footer');
        return {
          lines:range.getClientRects().length,
          wraps:getComputedStyle(el).whiteSpace!=='nowrap',
          labelFits:el.scrollWidth<=el.clientWidth+1,
          footerFits:footer.scrollWidth<=footer.clientWidth+1,
        };
      });
      assert.deepEqual(layout,{lines:1,wraps:false,labelFits:true,footerFits:true},`${name} approval button fits on one line`);
      await toolbar.screenshot({path:join(output,`${name}-approve-for-me.png`),animations:'disabled'});
      if(!mobile)await toolbar.evaluate(el=>el.style.removeProperty('max-width'));
      await connection.evaluate(el=>el.textContent='');
      await page.evaluate(()=>globalThis.__codexWebuiI18n.setPreference('zh-CN'));
    }

    if(!mobile){
      const badge=page.locator('#sidebarNotificationsButton .notification-count');
      assert.equal(await badge.textContent(),'1');
      const remove=page.locator('[data-section=recents] [data-id="thread-B"] .thread-delete');
      await remove.focus();await page.keyboard.press('Enter');
      const modal=page.locator('#threadDeleteDialog[open]');await modal.waitFor();
      assert.equal(await modal.locator('[value=cancel]').evaluate(el=>el===document.activeElement),true);
      await page.keyboard.press('Escape');await modal.waitFor({state:'hidden'});
      assert.equal(await remove.evaluate(el=>el===document.activeElement),true);
      assert.equal((await fixture.executions()).length,0);
    }
    await page.evaluate(()=>globalThis.__codexWebuiDebug.openSettings('appearance'));
    const theme=page.locator('#themeSelect');await theme.waitFor();
    assert.equal(await theme.locator('[value=system]').isChecked(),true);
    await theme.locator('label:has([value=light])').click();
    assert.equal(await page.locator('html').getAttribute('data-theme'),'light');
    await theme.locator('[value=light]').press('ArrowRight');
    assert.equal(await theme.locator('[value=dark]').isChecked(),true);
    await theme.locator('label:has([value=system])').click();
    assert.equal(await page.locator('html').getAttribute('data-theme'),colorScheme);
    assert(await theme.evaluate(el=>el.scrollWidth<=el.clientWidth));
    if(name!=='narrow') {
      await page.locator('#toast.show').waitFor({state:'hidden'});
      await screenshot(page,`${name}-appearance`);
    }
    await page.evaluate(()=>globalThis.__codexWebuiDebug.closeSettings());
    await page.locator('#settingsDialog').waitFor({state:'hidden'});

    await page.evaluate(()=>{
      const d=globalThis.__codexWebuiDebug;
      d.syncTurnSnapshot({id:'design-stream',status:'inProgress',items:[{id:'stream-answer',type:'agentMessage',phase:'final_answer',text:'进度详情\n\n'+'正在核对界面各状态。\n\n'.repeat(60)}]});
      d.scrollOpenedThreadToBottom();
    });
    const conversation=page.locator('#conversation'),latest=page.locator('#conversationLatest');
    await page.waitForFunction(()=>{const el=document.querySelector('#conversation');return el.scrollTop>200;});
    await conversation.evaluate(el=>{el.scrollTop=0;});await latest.waitFor();
    await page.evaluate(()=>globalThis.__codexWebuiDebug.notify('item/agentMessage/delta',{threadId:'thread-A',turnId:'design-stream',itemId:'stream-answer',delta:'\n\n流式更新。'}));
    await page.locator('[data-turn-id=design-stream] .message-text').filter({hasText:'流式更新。'}).waitFor();
    assert.equal(await conversation.evaluate(el=>el.scrollTop),0);
    await latest.click();await latest.waitFor({state:'hidden'});
    await page.waitForFunction(()=>{const el=document.querySelector('#conversation');return el.scrollHeight-el.scrollTop-el.clientHeight<2;});
    assert.equal(await conversation.evaluate(el=>el===document.activeElement),true);
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    assert.deepEqual(errors,[]);
    await context.close();
    console.log(`${name} (${width}px): model, theme, code copy, conversation scrolling`);
  }
  const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  await page.route('**/api/auth/status',route=>route.fulfill({json:{mode:'password',passwordRequired:true}}));
  await page.goto(fixture.base);
  const password=page.locator('#passwordInput'), visibility=page.locator('#passwordVisibility');
  await password.fill('fixture-password');
  await visibility.click();assert.equal(await password.getAttribute('type'),'text');
  await visibility.press('Space');assert.equal(await password.getAttribute('type'),'password');
  assert.equal(await password.inputValue(),'fixture-password');
  await password.clear();
  await screenshot(page,'phone-sign-in');
  assert.deepEqual(await fixture.executions(),[]);
} finally { await browser?.close();await fixture.close(); }
