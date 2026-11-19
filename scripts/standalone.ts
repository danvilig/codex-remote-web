// Native portable packages share the exact staging path used by deployment archives.
import { resolve } from 'node:path';
import { command } from './distribution.ts';

const root = resolve(import.meta.dir, '..');
const args = process.argv.slice(2);
if (!args.includes('--output-dir')) args.push('--output-dir', '.artifacts/portable');
console.log(await command(['bun', 'scripts/release.ts', '--native-portable', ...args], root));
