import { expect, test } from 'bun:test';
import { desktopLocale, trayTemplate } from '../../desktop/localization.js';

test('desktop language follows the saved choice and ordered OS preferences', () => {
  expect(desktopLocale('en', ['zh-CN'])).toBe('en');
  expect(desktopLocale('zh', ['en-US'])).toBe('zh-CN');
  expect(desktopLocale('system', ['en-US', 'zh-CN'])).toBe('en');
  expect(desktopLocale('system', ['zh-Hans-CN', 'en-US'])).toBe('zh-CN');
  expect(desktopLocale('system', ['fr-FR', 'zh-TW'])).toBe('zh-CN');
  expect(desktopLocale('system', ['de-DE'])).toBe('en');
});
test('localized tray keeps its actions and shows one language', () => {
  const called = [];
  const actions = Object.fromEntries(['openSettings', 'openWorkspace', 'start', 'stop', 'quit'].map(name => [name, () => called.push(name)]));
  const english = trayTemplate('en', actions), chinese = trayTemplate('zh-CN', actions);
  expect(english.filter(item => item.label).map(item => item.label)).toEqual(['Settings', 'Open workspace', 'Start gateway', 'Stop gateway', 'Quit tray (gateway continues)']);
  expect(chinese.filter(item => item.label).map(item => item.label)).toEqual(['设置', '打开工作区', '启动网关', '停止网关', '退出托盘（网关继续运行）']);
  for (const menu of [english, chinese]) for (const item of menu) item.click?.();
  expect(called).toEqual([...Object.keys(actions), ...Object.keys(actions)]);
});
