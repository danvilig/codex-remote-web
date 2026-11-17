// Original, code-drawn artwork. Regenerate with the pinned Playwright Chromium:
// bunx playwright install chromium && bun scripts/macos-artwork.ts
// These two reviewed PNGs are build inputs, not captures of personal sessions.
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const output = resolve(import.meta.dir, '../desktop/assets');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 680, height: 480 }, deviceScaleFactor: 2 });
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>
    *{box-sizing:border-box}body{margin:0;background:#f5f5f7;color:#1d1d1f;font-family:Arial,"Noto Sans CJK SC",sans-serif}
    main{height:480px;background:radial-gradient(ellipse at 50% 12%,#fff,transparent 76%);text-align:center;padding-top:58px}
    h1{font-size:30px;letter-spacing:-1.1px;font-weight:600;margin:0}
    .arrow{position:absolute;left:317px;top:202px;color:#a1a1a6}
    .instruction{position:absolute;top:315px;left:0;right:0;font-size:17px;letter-spacing:-.25px}
    .zh{margin-top:9px;font-size:13px;color:#86868b}
    footer{position:absolute;left:44px;right:44px;top:375px;border-top:1px solid #e4e4e8;text-align:left;padding-top:30px;font-size:12px;color:#86868b}
    footer small{display:block;margin-top:8px;font-size:11px}
  </style><main><h1>Codex Remote Web</h1>
    <svg class="arrow" width="46" height="24" viewBox="0 0 46 24" fill="none"><path d="M2 12h40M33 3l9 9-9 9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
    <div class="instruction">Drag to Applications<div class="zh">拖入“应用程序”即可安装</div></div>
    <footer>macOS 15+ · Apple Silicon<small>First launch? Open Install Guide. / 首次打开请查看安装指南。</small></footer>
  </main>`);
  await page.screenshot({ path: join(output, 'dmg-background.png'), scale: 'css' });
  await page.setViewportSize({ width: 1024, height: 1024 });
  await page.setContent(`<!doctype html><style>body{margin:0;background:transparent}svg{display:block}</style>
    <svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
      <defs><linearGradient id="bg" x2="1" y2="1"><stop stop-color="#f6faf9"/><stop offset="1" stop-color="#d5e8e2"/></linearGradient></defs>
      <rect x="42" y="42" width="940" height="940" rx="215" fill="url(#bg)"/>
      <rect x="206" y="246" width="612" height="532" rx="88" fill="#1c3030"/>
      <path d="M206 386h612" stroke="#42615c" stroke-width="24"/>
      <circle cx="284" cy="318" r="16" fill="#86b2a5"/><circle cx="340" cy="318" r="16" fill="#86b2a5"/>
      <path d="m320 484 100 90-100 90m202 0h160" fill="none" stroke="#edf6f2" stroke-width="38" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`);
  // iconutil expects a 1024px source.
  await page.screenshot({ path: join(output, 'app-icon.png'), scale: 'css', omitBackground: true });
} finally { await browser.close(); }
