// Standalone, offline guide. Show one language at a time, with an explicit
// switch; the mounted Finder background itself cannot run interactive content.
export const installationHelp = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Install Codex Remote Web</title>
<style>
*{box-sizing:border-box}body{margin:0;color:#1d1d1f;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
.language{position:absolute;right:28px;top:24px;font:inherit;font-size:13px;color:#515154;background:transparent;border:1px solid #d2d2d7;border-radius:8px;padding:7px 10px}
main{max-width:880px;margin:auto;padding:80px 28px 48px;text-align:center;animation:enter .85s ease-out both}.eyebrow{font-size:12px;color:#6e6e73}h1{font-size:44px;font-weight:600;margin:16px 0 12px}p{color:#515154;font-size:16px;line-height:1.65}.intro{max-width:560px;margin:0 auto 24px}.install{font-weight:600;color:#1d1d1f}
.flow{display:flex;align-items:center;justify-content:center;gap:clamp(24px,6vw,70px);margin:54px 0 48px}.tile{width:120px;transition:transform .3s ease}.tile:hover{transform:translateY(-6px)}.tile svg{width:104px;height:104px;filter:drop-shadow(0 10px 14px #0000000e)}.tile span{display:block;font-size:13px;margin-top:16px}.arrow{width:48px;height:24px;color:#6e6e73;animation:drift 2.8s ease-in-out infinite}
.note,.features{max-width:580px;margin:0 auto;border-top:1px solid #dedee3;padding-top:22px}h2{font-size:18px;font-weight:600;margin:0 0 12px}.note p,.features p{font-size:14px}.features{margin-top:34px;text-align:left}.features dl{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px;margin:16px 0 0}.features dt{font-size:14px;font-weight:600}.features dd{margin:5px 0 0;color:#515154;font-size:13px;line-height:1.55}details{text-align:left;margin:26px auto 0;max-width:580px;border-top:1px solid #dedee3;padding-top:18px}summary{cursor:pointer;font-size:13px;color:#515154;padding:6px 0}details p{font-size:13px}a{color:#0066cc;text-decoration:none}a:hover{text-decoration:underline}a:focus-visible,summary:focus-visible,select:focus-visible{outline:3px solid #0071e3;outline-offset:5px;border-radius:3px}footer{font-size:12px;color:#6e6e73;margin-top:36px}
@keyframes enter{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}@keyframes drift{0%,100%{transform:translateX(-3px);opacity:.5}50%{transform:translateX(3px);opacity:1}}@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}@media(max-width:500px){h1{font-size:32px}.tile{width:92px}.tile svg{width:80px;height:80px}.flow{gap:20px}.tile span{font-size:11px}.features dl{grid-template-columns:1fr;gap:14px}}
</style>
<select class="language" id="language" aria-label="Language"><option value="en">English</option><option value="zh">简体中文</option></select>
<main><div class="eyebrow">macOS · Apple Silicon</div><h1>Codex Remote Web</h1><p class="intro" data-copy="intro"></p><p class="install" data-copy="instruction"></p>
<div class="flow" aria-label="Drag the app to Applications"><div class="tile"><svg aria-hidden="true" viewBox="0 0 128 128"><rect x="4" y="4" width="120" height="120" rx="28" fill="#e4efeb"/><rect x="25" y="29" width="78" height="68" rx="11" fill="#1c3030"/><path d="M25 47h78" stroke="#42615c" stroke-width="3"/><circle cx="35" cy="38" r="2" fill="#86b2a5"/><circle cx="43" cy="38" r="2" fill="#86b2a5"/><path d="m40 59 14 12-14 12m28 0h20" stroke="#edf6f2" stroke-width="5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Codex Remote Web</span></div>
<svg class="arrow" aria-hidden="true" viewBox="0 0 48 24" fill="none"><path d="M2 12h42M35 3l9 9-9 9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
<div class="tile"><svg aria-hidden="true" viewBox="0 0 128 128"><path d="M8 35a8 8 0 0 1 8-8h35l12 12h49a8 8 0 0 1 8 8v59H8z" fill="#70b9ec"/><rect x="8" y="44" width="112" height="66" rx="9" fill="#8bcaf3"/><path d="m51 64 24 32m2-32-24 32m-9-8h43" fill="none" stroke="#e7f5ff" stroke-width="6" stroke-linecap="round"/></svg><span data-copy="applications"></span></div></div>
<section class="note"><h2 data-copy="welcome"></h2><p data-copy="launch"></p><p><b data-copy="allow"></b></p></section>
<section class="features"><h2 data-copy="what"></h2><dl><div><dt data-copy="browser"></dt><dd data-copy="browserDetail"></dd></div><div><dt data-copy="gateway"></dt><dd data-copy="gatewayDetail"></dd></div><div><dt data-copy="remote"></dt><dd data-copy="remoteDetail"></dd></div></dl></section>
<details><summary data-copy="before"></summary><p data-copy="requirements"></p></details>
<details><summary data-copy="about"></summary><p data-copy="signing"></p><p><a href="https://support.apple.com/102445" data-copy="apple"></a></p><p data-copy="damaged"></p></details>
<footer>Codex Remote Web · macOS 15+ · Apple Silicon</footer></main>
<script>
(() => {
const copy = {
  en: { intro: 'Run Codex on your Mac. Open its workspace in a browser.', instruction: 'Drag Codex Remote Web into Applications.', applications: 'Applications', welcome: 'First launch', launch: 'Copy first, then eject the installer disk. If macOS blocks this test build, open:', allow: 'System Settings → Privacy & Security → Open Anyway.', what: 'What you can do', browser: 'Work in a browser', browserDetail: 'Use Codex sessions, browse project files and review changes on desktop or mobile.', gateway: 'Keep it running', gatewayDetail: 'Start the gateway from the menu bar. It stays available after you close or quit the app.', remote: 'Connect remotely', remoteDetail: 'Start with local access. Set up protected remote access separately when you need it.', before: 'Before you start', requirements: 'Requires macOS 15+ and an Apple Silicon Mac (M-series). Intel Macs are not supported. Install and configure Codex CLI and Git before gateway setup; cloudflared is only needed for public remote access.', about: 'About this test build', signing: 'This build has an ad-hoc integrity signature, with no Apple Developer ID or notarization. After attempting to open it, you may need to explicitly allow it in System Settings. Only approve a build whose source you trust.', apple: "Apple's instructions", damaged: 'If macOS still says the app is damaged, stop and report the warning, macOS version and package SHA-256. Do not disable Gatekeeper or remove quarantine attributes to bypass that error.' },
  zh: { intro: '在 Mac 上运行 Codex，在浏览器里继续工作。', instruction: '将 Codex Remote Web 拖入“应用程序”。', applications: '应用程序', welcome: '首次打开', launch: '复制后推出安装磁盘。若系统阻止此测试包，请前往：', allow: '系统设置 → 隐私与安全性 → 仍要打开。', what: '你可以用它做什么', browser: '在浏览器里工作', browserDetail: '在电脑或手机上使用 Codex 会话、浏览项目文件、查看代码改动。', gateway: '让网关保持运行', gatewayDetail: '从菜单栏启动网关。关闭窗口或退出应用后，网关仍可使用。', remote: '从其他设备连接', remoteDetail: '默认在本机访问。有需要时，再单独配置受保护的远程访问。', before: '开始之前', requirements: '需要 macOS 15+ 与 Apple 芯片（M 系列），不支持 Intel Mac。初始化前请安装并配置 Codex CLI 和 Git；公网访问才需要 cloudflared。', about: '关于测试包', signing: '本包完成本地完整性签名，尚无 Apple 开发者签名及公证。首次尝试打开后可能需要手动允许；仅允许来源可信的构建。', apple: 'Apple 操作说明', damaged: '若仍提示“已损坏”，请停止并反馈原始提示、系统版本与 SHA-256；不要关闭 Gatekeeper 或清除隔离属性来绕过错误。' }
};
const picker = document.getElementById('language');
const preferred = (navigator.languages || [navigator.language]).find(value => /^(en|zh)(-|$)/i.test(value)) || 'en';
let saved; try { saved = localStorage.getItem('codex-install-language'); } catch {}
picker.value = ['en', 'zh'].includes(saved) ? saved : /^zh/i.test(preferred) ? 'zh' : 'en';
function render() {
  const language = picker.value;
  document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
  document.title = language === 'zh' ? '安装 Codex Remote Web' : 'Install Codex Remote Web';
  picker.setAttribute('aria-label', language === 'zh' ? '语言' : 'Language');
  for (const node of document.querySelectorAll('[data-copy]')) node.textContent = copy[language][node.dataset.copy];
  document.querySelector('.flow').setAttribute('aria-label', copy[language].instruction);
}
picker.addEventListener('change', () => { try { localStorage.setItem('codex-install-language', picker.value); } catch {} render(); });
render();
})();
</script></html>`;
