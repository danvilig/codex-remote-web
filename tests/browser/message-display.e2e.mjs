import assert from 'node:assert/strict';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { artifacts, launchOptions } from '../helpers/browser-runtime.mjs';

const output = process.env.CODEX_MESSAGE_SCREENSHOTS || artifacts;
const preview = process.env.CODEX_MESSAGE_PREVIEW ? null : Bun.spawn(['bun','tests/helpers/product-preview.mjs'], { stdout:'pipe', stderr:'inherit' });
let browser;
try {
  const base = process.env.CODEX_MESSAGE_PREVIEW || new TextDecoder().decode((await preview.stdout.getReader().read()).value).trim();
  assert.match(base,/^http:\/\/127\.0\.0\.1:\d+\/\?demo$/);
  browser = await chromium.launch(launchOptions());
  for (const [name,width,isMobile] of [['desktop',1280,false],['tablet',768,true],['phone',390,true],['narrow',320,true]]) {
    const context = await browser.newContext({ viewport:{width,height:880}, isMobile, hasTouch:isMobile, permissions:['clipboard-read','clipboard-write'], colorScheme:isMobile?'light':'dark' });
    const page = await context.newPage(), errors=[], externalRequests=[];
    page.setDefaultTimeout(8000);
    page.on('pageerror',error=>errors.push(error.message));
    page.on('request',req=>{if(!req.url().startsWith(new URL(base).origin)&&!req.url().startsWith('about:'))externalRequests.push(req.url());});
    await page.goto(base);
    const work=page.locator('.turn-work-toggle');
    await work.waitFor();
    assert.equal(await work.getAttribute('aria-expanded'),'false');
    assert.equal(await page.locator('.web-search-timeline').isVisible(),false);
    assert.equal(await page.locator('#threadTitle').textContent(),'移动端布局检查');
    const code=page.locator('.markdown-code-block').filter({has:page.locator('.language-ts')});
    await code.locator('.tok-keyword').first().waitFor();
    await code.getByRole('button',{name:'复制代码'}).click();
    assert.match(await page.evaluate(()=>navigator.clipboard.readText()),/^const widths = \[320, 390, 768\]/);
    const plan=page.locator('#planModeButton'),permissions=await page.locator('#modeButton .control-label').textContent();
    await plan.click();
    assert.equal(await plan.getAttribute('aria-pressed'),'true');
    assert.equal(await page.locator('#modeButton .control-label').textContent(),permissions);
    await work.click();
    const queries=page.locator('[data-item-id=preview-search] .web-search-terms');
    assert.deepEqual(await queries.locator('li').allTextContents(),['Playwright viewport emulation','MDN viewport meta element']);
    assert(await queries.isVisible());
    const visited=page.locator('[data-item-id=preview-open-page] a');
    assert.equal(await visited.getAttribute('href'),'https://playwright.dev/docs/emulation');
    assert.equal(await visited.getAttribute('target'),'_blank');
    if(name==='desktop') {
      await page.locator('#toast.show').waitFor({state:'hidden'});
      await page.screenshot({path:join(output,'desktop-search-expanded.png'),animations:'disabled'});
    }
    await work.click();
    const body=page.locator('#conversation .turn-final-slot .message-text');
    const contents=body.getByText('查看检查范围',{exact:true});
    await contents.click();
    assert(await body.getByText('覆盖会话正文、代码块及复制按钮。').isVisible());
    assert(await body.getByRole('table').isVisible());
    const html=body.locator('.message-html-preview');
    assert(await html.locator('figcaption').filter({hasText:'阅读区域对比'}).isVisible());
    assert.equal(await html.locator('meter').count(),2);
    assert.equal(await html.locator('pre').isVisible(),false);
    await html.getByRole('button',{name:'源码',exact:true}).click();
    assert(await html.locator('pre').isVisible());
    assert.equal(await html.locator('.message-html-body').isVisible(),false);
    await html.getByRole('button',{name:'预览',exact:true}).click();
    await html.getByText('验收结果',{exact:true}).click();
    assert(await body.getByText('代码框和表格均在窄屏内显示。',{exact:true}).isVisible());
    const links=body.locator('a.message-web-link');
    assert.deepEqual((await links.evaluateAll(anchors=>anchors.map(link=>new URL(link.href).host))),['playwright.dev','developer.mozilla.org']);
    assert.equal(await links.first().getAttribute('rel'),'noopener noreferrer');
    const answerLinks=page.locator('.answer-links');
    await answerLinks.locator('summary').click();
    assert.deepEqual(await answerLinks.locator('small').allTextContents(),['playwright.dev','developer.mozilla.org']);
    assert(await answerLinks.locator('li').first().isVisible());
    if(!isMobile) {
      const link=links.first(), popup=page.locator('.message-link-preview');
      await link.hover(); await popup.waitFor();
      assert.equal(await popup.locator('a').getAttribute('href'),'https://playwright.dev/docs/emulation');
      await page.screenshot({path:join(output,'desktop-link-preview.png'),animations:'disabled'});
      await link.press('Alt+ArrowDown');
      await page.keyboard.press('Enter');
      assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),'https://playwright.dev/docs/emulation');
      await page.keyboard.press('Escape'); await popup.waitFor({state:'hidden'});
      assert.equal(await link.evaluate(el=>el===document.activeElement),true);
    }
    if(name!=='narrow') {
      await page.locator('#toast.show').waitFor({state:'hidden'});
      await page.locator('#conversation').evaluate(el=>{el.scrollTop=0;});
      await page.screenshot({path:join(output,`${name}-search-code.png`),animations:'disabled'});
      await html.locator('.markdown-code-header').evaluate(el=>el.scrollIntoView({block:'start'}));
      await page.screenshot({path:join(output,`${name}-html-links.png`),animations:'disabled'});
    }
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    assert.deepEqual(errors,[]);
    assert.deepEqual(externalRequests,[]);
    await context.close();
    console.log(`PASS ${name}: populated preview, search actions, code/copy, Plan mode, static HTML and citation links`);
  }
} finally {
  await browser?.close();
  if (preview) { preview.kill('SIGTERM'); await preview.exited; }
}
