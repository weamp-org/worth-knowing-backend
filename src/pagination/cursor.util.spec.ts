import { BadRequestException } from '@nestjs/common';

import { decodeCursor, encodeCursor } from './cursor.util';

describe('encodeCursor', () => {
  it('round-trips an id', () => {
    const id = 'ckq8f2a1b0000abcdefghijkl';

    expect(decodeCursor(encodeCursor(id))).toBe(id);
  });

  it('is opaque rather than the raw id', () => {
    const id = 'ckq8f2a1b0000abcdefghijkl';

    expect(encodeCursor(id)).not.toContain(id);
    expect(encodeCursor(id)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('is url-safe, so it needs no escaping in a query string', () => {
    const encoded = encodeCursor('ckq8f2a1b0000abcdefghijkl');

    expect(encoded).not.toMatch(/[+/=]/);
    expect(encodeURIComponent(encoded)).toBe(encoded);
  });
});

describe('decodeCursor', () => {
  it('rejects a cursor that is not base64url', () => {
    expect(() => decodeCursor('!!!not base64!!!')).toThrow(BadRequestException);
  });

  it('rejects base64 that decodes to something that is not an id', () => {
    for (const payload of ['', '../../etc/passwd', 'a b c', '"; DROP TABLE']) {
      const cursor = Buffer.from(payload, 'utf8').toString('base64url');

      expect(() => decodeCursor(cursor)).toThrow(BadRequestException);
    }
  });

  it('rejects a cursor carrying SQL', () => {
    const cursor = Buffer.from("' OR 1=1 --", 'utf8').toString('base64url');

    expect(() => decodeCursor(cursor)).toThrow(BadRequestException);
  });

  // Regression: an earlier version validated the decoded id against cuid's own
  // alphabet, which wrongly rejected any id containing an underscore.
  it('accepts ids beyond the cuid alphabet', () => {
    for (const id of ['res_013', 'a-b-c', 'a.b', 'a+b', 'a:b', 'a@b']) {
      expect(decodeCursor(encodeCursor(id))).toBe(id);
    }
  });

  it('rejects characters that could never be in an id', () => {
    for (const id of ['a b', 'a"b', "a'b", 'a/b', 'a\\b', 'a#b', 'a\nb']) {
      const cursor = encodeCursor(id);

      expect(() => decodeCursor(cursor)).toThrow(BadRequestException);
    }
  });

  it('rejects an over-long cursor', () => {
    const cursor = encodeCursor('a'.repeat(500));

    expect(() => decodeCursor(cursor)).toThrow(BadRequestException);
  });
});
