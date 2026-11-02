import { expect, test } from 'bun:test';
import { changedFileRows } from '../../public/turn-presentation.js';

test('edited files use project-relative paths and aggregate repeated changes without mutating review data', () => {
  const files = [
    { path: '/workspace/app/src/main.ts', linesAdded: 3, linesDeleted: 1 },
    { path: 'src/main.ts', linesAdded: 2, linesDeleted: 4 },
    { path: '/dev/null', oldPath: '/workspace/app/old.md', linesAdded: 0, linesDeleted: 8 },
    { path: '/workspace/app-other/config.json', linesAdded: 1, linesDeleted: 0 },
  ];
  expect(changedFileRows(files, '/workspace/app/')).toEqual([
    { path: 'src/main.ts', linesAdded: 5, linesDeleted: 5 },
    { path: 'old.md', linesAdded: 0, linesDeleted: 8 },
    { path: '../app-other/config.json', linesAdded: 1, linesDeleted: 0 },
  ]);
  expect(files[0].path).toBe('/workspace/app/src/main.ts');
  expect(files[0].linesAdded).toBe(3);
});
