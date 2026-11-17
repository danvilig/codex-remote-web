// Shared by native menus and the renderer. Respect language priority rather
// than selecting Chinese merely because it appears anywhere in the list.
export function desktopLocale(preference = 'system', languages = []) {
  if (preference === 'zh' || preference === 'zh-CN') return 'zh-CN';
  if (preference === 'en') return 'en';
  const preferred = languages.find(value => /^(en|zh)(-|$)/i.test(value)) || 'en';
  return /^zh/i.test(preferred) ? 'zh-CN' : 'en';
}
const chinese = {
  Settings: '设置', 'Open workspace': '打开工作区', 'Start gateway': '启动网关', 'Stop gateway': '停止网关',
  'Quit tray (gateway continues)': '退出托盘（网关继续运行）',
  'Stop and remove the background component?': '停止并移除后台组件？',
  'Your projects, credentials and remote deployment records will be preserved.': '项目、凭据与远程部署记录将保留。',
  'Clean up and quit?': '清理并退出？',
  'Remove app settings, caches, logs and saved management tokens. Projects and your Codex account are preserved.': '移除应用设置、缓存、日志与已保存的管理令牌，保留项目和 Codex 账户。',
  'The application will move to the Trash.': '应用将移至废纸篓。',
  'Then uninstall the application using your system package manager.': '随后请通过系统的软件包管理器卸载应用。',
  'Clean up': '清理',
  Cancel: '取消', Remove: '移除', Edit: '编辑', View: '显示', Window: '窗口',
  Undo: '撤销', Redo: '重做', Cut: '剪切', Copy: '复制', Paste: '粘贴', 'Select All': '全选',
  Minimize: '最小化', Zoom: '缩放', 'Toggle Full Screen': '切换全屏', Close: '关闭窗口',
  'Hide Codex Remote Web': '隐藏 Codex Remote Web', 'Hide Others': '隐藏其他应用', 'Show All': '显示全部',
};
export const nativeTranslations = { en: {}, 'zh-CN': chinese };
export function nativeText(message, locale) { return locale === 'zh-CN' ? chinese[message] || message : message; }
export function trayTemplate(locale, { openSettings, openWorkspace, start, stop, quit }) {
  const t = message => nativeText(message, locale);
  return [
    { id: 'settings', label: t('Settings'), click: openSettings },
    { id: 'workspace', label: t('Open workspace'), click: openWorkspace },
    { type: 'separator' },
    { id: 'start', label: t('Start gateway'), click: start },
    { id: 'stop', label: t('Stop gateway'), click: stop },
    { type: 'separator' },
    { id: 'quit', label: t('Quit tray (gateway continues)'), click: quit },
  ];
}
