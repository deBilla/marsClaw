import { describe, it, expect } from 'bun:test';
import { parseVideoId } from '../src/mcp/youtube.ts';

describe('parseVideoId', () => {
  const id = 'dQw4w9WgXcQ';

  it('extracts from a standard watch URL', () => {
    expect(parseVideoId(`https://www.youtube.com/watch?v=${id}`)).toBe(id);
  });

  it('ignores extra query params and order', () => {
    expect(parseVideoId(`https://youtube.com/watch?list=PL123&v=${id}&t=42s`)).toBe(id);
  });

  it('extracts from youtu.be short links', () => {
    expect(parseVideoId(`https://youtu.be/${id}?t=10`)).toBe(id);
  });

  it('extracts from shorts / embed / live paths', () => {
    expect(parseVideoId(`https://www.youtube.com/shorts/${id}`)).toBe(id);
    expect(parseVideoId(`https://www.youtube.com/embed/${id}?rel=0`)).toBe(id);
    expect(parseVideoId(`https://www.youtube.com/live/${id}`)).toBe(id);
  });

  it('handles m. and music. subdomains', () => {
    expect(parseVideoId(`https://m.youtube.com/watch?v=${id}`)).toBe(id);
    expect(parseVideoId(`https://music.youtube.com/watch?v=${id}`)).toBe(id);
  });

  it('accepts a bare 11-char video id', () => {
    expect(parseVideoId(id)).toBe(id);
    expect(parseVideoId(`  ${id}  `)).toBe(id);
  });

  it('returns null for non-YouTube or malformed input', () => {
    expect(parseVideoId('https://vimeo.com/123456')).toBeNull();
    expect(parseVideoId('https://www.youtube.com/watch?v=short')).toBeNull();
    expect(parseVideoId('not a url')).toBeNull();
    expect(parseVideoId('')).toBeNull();
  });
});
