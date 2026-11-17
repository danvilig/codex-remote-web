import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isMachO } from '../../scripts/macos-sign.ts';

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
