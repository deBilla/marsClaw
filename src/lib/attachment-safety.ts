// Is `name` safe to use as the last segment of a path inside an attachment
// staging directory? Filenames originate from untrusted sources (chat
// participants), and land in `path.join(dir, name)` sinks on the host.
// Without this guard, a `..`-laden name escapes the inbox and writes
// anywhere the host process has filesystem permission.
//
// Rejects:
//   - non-string / empty
//   - `.` / `..` traversal sentinels (path.basename returns them as-is)
//   - anything containing a path separator (`/` or `\`) or NUL byte
//   - any value where path.basename(name) !== name (covers OS-specific
//     separators and drive prefixes on Windows runtimes)

import path from 'node:path';

export function isSafeAttachmentName(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0) return false;
  if (name === '.' || name === '..') return false;
  if (/[\\/\0]/.test(name)) return false;
  return path.basename(name) === name;
}
