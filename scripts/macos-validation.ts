import { release } from 'node:os';
import { command } from './distribution.ts';

export const macosMinimumVersion = '15.0';

export function checkMacOSVersion(version: string, expectedMajor?: string) {
  if (!/^\d+\.\d+(?:\.\d+)?$/.test(version)) throw new Error(`Invalid macOS product version: ${version}`);
  const major = Number(version.split('.')[0]);
  if (major < Number(macosMinimumVersion.split('.')[0])) throw new Error(`macOS ${macosMinimumVersion}+ required, got ${version}`);
  if (expectedMajor && (!/^\d+$/.test(expectedMajor) || major !== Number(expectedMajor))) {
    throw new Error(`Expected macOS ${expectedMajor}, actually running ${version}`);
  }
  return major;
}

export async function macOSValidationSystem(expectedMajor = process.env.CODEX_WEBUI_EXPECT_MACOS_MAJOR) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Native macOS validation requires Apple Silicon');
  const version = await command(['sw_vers', '-productVersion'], process.cwd());
  const build = await command(['sw_vers', '-buildVersion'], process.cwd());
  const major = checkMacOSVersion(version, expectedMajor);
  return { version, major, build, kernel: release(), arch: process.arch, expectedMajor: expectedMajor ? Number(expectedMajor) : null };
}
