// Only these reviewed, synthetic-data UI captures may enter public artifacts.
// Personal screenshots and arbitrary image directories remain excluded.
export const documentationImages = new Set([
  'docs/images/workspace.png',
  'docs/images/files.png',
  'docs/images/remote-access.png',
  'docs/images/mobile.png',
  'docs/images/tablet.png',
  'docs/images/customize.png',
]);

// Original code-drawn installer assets from scripts/macos-artwork.ts. This is
// an exact file allowlist; arbitrary desktop images remain excluded/scanned.
export const installerImages = new Set([
  'desktop/assets/app-icon.png',
  'desktop/assets/dmg-background.png',
  'desktop/assets/dmg-background@2x.png',
  'desktop/assets/guide-icon.png',
]);

// These files only create or exercise the local documentation captures. They
// are useful in the development checkout, but are not part of the public
// source snapshot or production archive.
export const publicSourceExcluded = new Set([
  'docs/images/README.md',
  'scripts/capture-docs.ts',
  'tests/browser/readme-screenshot.mjs',
  'tests/fixtures/showcase-codex.mjs',
]);
