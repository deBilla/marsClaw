import { describe, it, expect } from 'bun:test';
import { isSafeAttachmentName } from '../src/lib/attachment-safety.ts';

describe('isSafeAttachmentName', () => {
  it('accepts plain filenames', () => {
    expect(isSafeAttachmentName('report.pdf')).toBe(true);
    expect(isSafeAttachmentName('My Doc - v2.docx')).toBe(true);
    expect(isSafeAttachmentName('image_123.jpg')).toBe(true);
  });

  it('rejects empty / non-string', () => {
    expect(isSafeAttachmentName('')).toBe(false);
    // @ts-expect-error covering runtime misuse
    expect(isSafeAttachmentName(null)).toBe(false);
    // @ts-expect-error covering runtime misuse
    expect(isSafeAttachmentName(undefined)).toBe(false);
  });

  it('rejects traversal sentinels', () => {
    expect(isSafeAttachmentName('.')).toBe(false);
    expect(isSafeAttachmentName('..')).toBe(false);
  });

  it('rejects separators and NUL', () => {
    expect(isSafeAttachmentName('../etc/passwd')).toBe(false);
    expect(isSafeAttachmentName('a/b.txt')).toBe(false);
    expect(isSafeAttachmentName('a\\b.txt')).toBe(false);
    expect(isSafeAttachmentName('a\0b.txt')).toBe(false);
  });

  it('rejects values where path.basename differs', () => {
    expect(isSafeAttachmentName('foo/bar')).toBe(false);
    expect(isSafeAttachmentName('/absolute')).toBe(false);
  });
});
