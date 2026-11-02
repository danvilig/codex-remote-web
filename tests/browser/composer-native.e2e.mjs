import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { artifact, launchOptions } from '../helpers/browser-runtime.mjs';

const browser=await chromium.launch(launchOptions());
try{
  const page=await browser.newPage({viewport:{width:1018,height:980},colorScheme:'dark'}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(process.env.CODEX_WEBUI_TEST_URL||'http://127.0.0.1:8899',{waitUntil:'networkidle'});
  await page.waitForFunction(()=>globalThis.__codexWebuiDebug?.state.models.length);
  await page.evaluate(()=>globalThis.__codexWebuiDebug.startNewTask());
  assert.equal(await page.locator('#prompt').getAttribute('placeholder'),'Do anything');
  assert.equal(await page.locator('#modelButton').getAttribute('aria-haspopup'),'dialog');
  const support=await page.locator('#effortSelect option').evaluateAll(nodes=>nodes.map(node=>node.value));
  await page.locator('#modelButton').click();
  assert.equal(Number(await page.locator('#effortSlider').getAttribute('max')),support.length-1);
  assert.equal(await page.locator('#effortSlider').isDisabled(),support.length===1);
  if(support.length>1){
    await page.locator('#effortSlider').focus();await page.keyboard.press('End');
    assert.equal(await page.locator('#effortSelect').inputValue(),support.at(-1));
    assert.equal(await page.locator('#modelMenu').isVisible(),true);
  }
  await page.screenshot({path:artifact('composer-model-menu.png')});
  await page.locator('#modelSubmenuButton').click();
  const models=await page.evaluate(()=>globalThis.__codexWebuiDebug.state.models.map(model=>model.model));
  assert.equal(await page.locator('#modelMenu .model-option').count(),models.length);
  await page.locator('#modelMenu .model-option').last().click();
  assert.equal(await page.evaluate(()=>globalThis.__codexWebuiDebug.state.selectedModel),models.at(-1));
  assert.equal(await page.locator('#modelMenu').isVisible(),false);
  await page.locator('#modelButton').click();await page.locator('#effortReset').click();
  const reset=await page.evaluate(()=>{const state=globalThis.__codexWebuiDebug.state,model=state.models.find(model=>model.model===state.selectedModel);return{expected:model.defaultReasoningEffort,value:document.querySelector('#effortSelect').value};});
  assert.equal(reset.value,reset.expected);
  await page.keyboard.press('Escape');
  await page.setViewportSize({width:390,height:844});
  await page.locator('#modelButton').click();
  const bounds=await page.locator('#modelMenu').boundingBox();assert(bounds.x>=0&&bounds.x+bounds.width<=390);
  assert.equal(await page.locator('#modelLabel').isVisible(),true);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.deepEqual(errors,[]);
  console.log('PASS: model-supported effort slider, selection/reset/model submenu, and mobile bounds');
}finally{await browser.close();}
