import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isMachO } from '../../scripts/macos-sign.ts';
import { checkMacOSVersion, macosMinimumVersion } from '../../scripts/macos-validation.ts';

test('macOS 15 stays the minimum and OS coverage rejects a mislabeled runner', () => {
  expect(macosMinimumVersion).toBe('15.0');
  expect(() => checkMacOSVersion('14.7.1', '15')).toThrow(/15.0\+/);
  expect(checkMacOSVersion('15.7.3', '15')).toBe(15);
  expect(checkMacOSVersion('27.0.1', '27')).toBe(27);
  expect(() => checkMacOSVersion('26.1', '27')).toThrow(/actually running 26.1/);
  expect(() => checkMacOSVersion('27.0.1', '15')).toThrow(/actually running 27.0.1/);
  expect(() => checkMacOSVersion('Darwin 27', '27')).toThrow(/Invalid/);
});

test('signing detects native payloads regardless of extension and ignores scripts', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'crw-macho-'));
  try {
    for (const magic of ['cffaedfe', 'feedfacf', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca']) {
      const file = join(temp, magic); await writeFile(file, Buffer.from(magic, 'hex'));
      expect(await isMachO(file)).toBe(true);
    }
    for (const content of ['#!/bin/sh\n', '', '\xca']) {
      const file = join(temp, 'script'); await writeFile(file, content);
      expect(await isMachO(file)).toBe(false);
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
});
