import { open } from 'node:fs/promises';

// Windows does not expose directory fsync via Node/Bun (EPERM). File contents
// are still flushed before atomic rename. Sudden power-loss durability of the
// directory entry is not guaranteed there; keep receipts and reconcile unknown
// results, never replay on recovery. Unix retains the directory flush as well.
export async function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  const handle = await open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
