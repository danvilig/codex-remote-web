export const demoThreadId = 'product-preview';
export const demoName = '移动端布局检查';

const answer = [
  '## 移动端布局检查',
  '',
  '检查了 320、390 和 768 像素三种视口。**会话保持单列，长代码只在代码框内滚动。**',
  '',
  '设备尺寸参考 [Playwright 设备模拟](https://playwright.dev/docs/emulation)，视口配置参考 [MDN 的 viewport 指南](https://developer.mozilla.org/en-US/docs/Web/HTML/Guides/Viewport_meta_element)。',
  '',
  '```ts',
  'const widths = [320, 390, 768] as const;',
  '',
  'for (const width of widths) {',
  '  await page.setViewportSize({ width, height: 844 });',
  '  await expect(page.getByRole("button", { name: "复制代码" })).toBeVisible();',
  '}',
  '```',
  '',
  '<details><summary>查看检查范围</summary><p>覆盖会话正文、代码块及复制按钮。</p></details>',
  '',
  '<table><thead><tr><th>视口</th><th>检查项</th></tr></thead><tbody><tr><td>320 px</td><td>代码块独立滚动</td></tr><tr><td>768 px</td><td>会话正文对齐</td></tr></tbody></table>',
  '',
  '```html',
  '<figure><figcaption>阅读区域对比</figcaption><div>',
  '<section><h4>手机</h4><p>390 px 视口</p>',
  '<meter min="0" max="100" value="42" aria-label="手机阅读区相对宽度">42%</meter>',
  '<small>单列阅读，代码框独立滚动。</small></section>',
  '<section><h4>桌面</h4><p>840 px 阅读区</p>',
  '<meter min="0" max="100" value="92" aria-label="桌面阅读区相对宽度">92%</meter>',
  '<small>限制行长，保持段落易读。</small></section>',
  '</div><details><summary>验收结果</summary><p>代码框和表格均在窄屏内显示。</p></details></figure>',
  '```',
].join('\n');

export const demoTurns = [{
  id: 'product-preview-turn',
  status: 'completed',
  durationMs: 18400,
  items: [
    { id: 'preview-question', type: 'userMessage', content: [{ type: 'text', text: '请检查手机上的布局，并给出 TypeScript 示例和参考资料。' }] },
    { id: 'preview-search', type: 'webSearch', query: 'Playwright viewport emulation', action: { type: 'search', queries: ['Playwright viewport emulation', 'MDN viewport meta element'] } },
    { id: 'preview-open-page', type: 'webSearch', query: '', action: { type: 'openPage', url: 'https://playwright.dev/docs/emulation' } },
    { id: 'preview-answer', type: 'agentMessage', phase: 'final_answer', text: answer },
  ],
}];
