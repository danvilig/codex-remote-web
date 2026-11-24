import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { artifact, launchOptions } from '../helpers/browser-runtime.mjs';
import { isolatedWorkspace } from '../helpers/isolated-workspace.mjs';

const workspace = await isolatedWorkspace();
const { base, project, home, directory } = workspace;
const name = "agent's result.txt", file = join(project,name);
const report = join(home,'live progress.html'), picture = join(project,'result.png');
const body = 'first line\nsecond line\nthird line\n';
let browser;
try {
  await Promise.all([
    writeFile(file,body),
    writeFile(report,'<h1>Live progress</h1><meter max="100" value="42"></meter><script>window.untrustedScript=true</script><img src="https://example.invalid/image.png">'),
    writeFile(picture,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jT1sAAAAASUVORK5CYII=','base64')),
    writeFile(join(project,'.env'),'DUMMY_SECRET=not-a-real-credential'),
    writeFile(join(directory,'outside.txt'),'outside'),
  ]);
  const downloadUrl = (path,cwd=project) => base+'/api/files/download?'+new URLSearchParams({path,cwd});
  const direct=await fetch(downloadUrl(file));
  assert.equal(await direct.text(),body);
  assert.match(direct.headers.get('content-disposition'),/filename\*=UTF-8''agent%27s%20result.txt/);
  assert.equal(direct.headers.get('cache-control'),'no-store');
  assert.equal(direct.headers.get('x-content-type-options'),'nosniff');
  for(const [path,cwd] of [[join(directory,'outside.txt'),directory],[join(project,'.env'),project]]){
    assert.equal((await fetch(downloadUrl(path,cwd))).status,404);
  }
  browser=await chromium.launch(launchOptions());
  for(const width of [1280,768,390]){
    const page=await browser.newPage({acceptDownloads:true,viewport:{width,height:844},hasTouch:width<900,isMobile:width<900});
    let downloads=0, downloadRequests=0;
    page.on('download',()=>downloads++);
    page.on('request',request=>{if(new URL(request.url()).pathname==='/api/files/download')downloadRequests++;});
    await page.addInitScript(()=>{if(window===window.top)localStorage.setItem('codex-webui-locale','en');});
    await page.goto(base);
    await page.waitForFunction(()=>globalThis.__codexWebuiDebug?.state.connected);
    await page.evaluate(({file,report,picture})=>{
      const app=globalThis.__codexWebuiDebug;
      app.state.active={id:'file-link-fixture',cwd:app.state.config.defaultCwd,source:'local'};
      const text=`:codex-file-citation{path="${file}" purpose="output"}\n\n[Live progress](sandbox:${encodeURI(report)})\n\n[Source line](<${file}:2-3>)\n\n[Result image](${picture})\n\n[Unsupported](<${file}.pdf>)`;
      app.notify('item/completed',{turnId:'fixture-turn',item:{id:'answer',type:'agentMessage',phase:'final_answer',text}});
    },{file,report,picture});
    const panel=page.locator('#utilityPanelContent'), preview=panel.locator('.explorer-preview');
    const close=()=>page.locator('#closeSidePanel').click();

    const progress=page.getByRole('link',{name:'Live progress',exact:true});
    await progress.press('Enter');
    await preview.getByRole('heading',{name:'Live progress'}).waitFor();
    assert.equal(await preview.locator('script,img').count(),0);
    assert.equal(await preview.getByRole('button',{name:'Edit file'}).isDisabled(),true);
    assert.equal(await preview.getByRole('button',{name:'Close preview'}).evaluate(el=>el===document.activeElement),true);
    assert.equal(await page.locator('#sidePanelTitle').textContent(),'Files');
    if(width!==768)await page.screenshot({path:artifact(`file-citation-preview-${width}.png`)});
    await close();
    await page.waitForFunction(()=>document.activeElement?.textContent==='Live progress');
    assert.equal(await progress.evaluate(el=>el===document.activeElement),true);

    await page.getByRole('link',{name:'Source line'}).click();
    await preview.locator('.explorer-cited-lines').waitFor();
    assert.equal(await preview.locator('.explorer-cited-lines').textContent(),'2\n3');
    await close();

    await page.getByRole('link',{name:'Result image'}).click();
    await preview.locator('img').waitFor();
    await page.waitForFunction(()=>document.querySelector('.explorer-preview img')?.naturalWidth===1);
    assert.equal(await page.locator('#imageViewer').evaluate(el=>el.open),false);
    await close();

    await page.getByRole('link',{name:'Unsupported'}).click();
    await preview.getByText('Preview unavailable. Download this file to open it.').waitFor();
    await close();
    await page.getByRole('link',{name,exact:true}).click();
    await preview.locator('.explorer-code').filter({hasText:'second line'}).waitFor();
    assert.equal(downloads,0);
    assert.equal(downloadRequests,0);
    const downloadEvent=page.waitForEvent('download');
    await preview.getByRole('link',{name:'Download'}).click();
    const download=await downloadEvent;
    assert.equal(download.suggestedFilename(),name);
    assert.equal(await readFile(await download.path(),'utf8'),body);
    await page.close();
  }
  console.log('PASS: file links open Files at desktop, tablet and phone widths; HTML, images, line references, explicit download, and file boundaries');
}finally{
  await browser?.close();
  await workspace.close();
}
