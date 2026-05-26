// Atomic file write — write to a sibling temp file, then rename.
// Rename is atomic on the same filesystem, so a mid-write crash leaves the
// destination either as the previous valid contents or untouched.

import { writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function writeAtomic(filePath: string, content: string | Uint8Array): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, filePath);
}
