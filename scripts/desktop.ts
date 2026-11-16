import { cp, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { deflateSync } from 'node:zlib';

const root = resolve(import.meta.dir, '..');
// Original monochrome tray mark; generated at build time, no external artwork.
function trayPng() {
  const size = 24, raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const radius = Math.hypot(x - 11.5, y - 11.5);
    const ink = (radius > 7 && radius < 9.5 && x < 17) || (x >= 10 && x <= 18 && Math.abs(y - 11.5) < 1.5);
    const offset = y * (1 + size * 4) + 1 + x * 4; raw[offset] = raw[offset + 1] = raw[offset + 2] = 90; raw[offset + 3] = ink ? 255 : 0;
  }
  const crc = bytes => { let value = -1; for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); } return (value ^ -1) >>> 0; };
  const chunk = (type, data) => { const name = Buffer.from(type), length = Buffer.alloc(4), checksum = Buffer.alloc(4); length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc(Buffer.concat([name, data]))); return Buffer.concat([length, name, data, checksum]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
export async function buildDesktop(output = join(root, '.artifacts/desktop-dev')) {
  await mkdir(output, { recursive: true });
  // Load lifecycle hooks synchronously before Electron initializes Chromium.
  // Keep the browser renderer as ESM and the native bootstrap as CommonJS.
  for (const [entry, name, target] of [['desktop/main.js', 'main.cjs', 'node'], ['desktop/renderer.js', 'renderer.js', 'browser']]) {
    const result = await Bun.build({ entrypoints: [join(root, entry)], outdir: output, naming: name, target: target as 'node' | 'browser', format: target === 'node' ? 'cjs' : 'esm', packages: target === 'node' ? 'external' : 'bundle' });
    if (!result.success) throw new Error(result.logs.join('\n'));
  }
  for (const file of ['index.html', 'desktop.css', 'preload.cjs']) await cp(join(root, 'desktop', file), join(output, file));
  for (const file of ['style.css', 'workspace.css', 'remote-access.css']) await cp(join(root, 'public', file), join(output, file));
  await writeFile(join(output, 'tray.png'), trayPng());
  return output;
}
if (import.meta.main) {
  const output = await buildDesktop();
  if (process.argv.includes('--run')) {
    const executable = (await import('electron')).default;
    const child = Bun.spawn([executable, join(output, 'main.cjs')], { env: { ...process.env, CODEX_DESKTOP_BUN: process.execPath }, stdout: 'inherit', stderr: 'inherit' }); process.exitCode = await child.exited;
  } else console.log(output);
}
