import { describe, expect, it } from 'vitest';
import { parseBookMetadata } from './metadata';

const valid = {
  title: '罪与罚',
  authors: ['陀思妥耶夫斯基'],
  language: 'zh',
  cover_path: 'assets/cover.jpeg',
  identifiers: { isbn: '9787020024759' },
  publisher: '人民文学出版社',
  published_date: '2003',
  source_filename: 'crime.epub',
};

describe('parseBookMetadata', () => {
  it('accepts a fully-populated metadata object', () => {
    expect(parseBookMetadata(valid)).toEqual(valid);
  });

  it('accepts nullable fields set to null', () => {
    const parsed = parseBookMetadata({
      ...valid,
      cover_path: null,
      publisher: null,
      published_date: null,
      identifiers: {},
    });
    expect(parsed.cover_path).toBeNull();
    expect(parsed.publisher).toBeNull();
  });

  it.each([
    ['null value', null],
    ['a string', 'nope'],
    ['a missing metadata block (undefined)', undefined],
  ])('rejects %s', (_label, value) => {
    expect(() => parseBookMetadata(value)).toThrow(/metadata\.json is missing/);
  });

  it('rejects an empty title', () => {
    expect(() => parseBookMetadata({ ...valid, title: '   ' })).toThrow(/title is invalid/);
  });

  it('rejects non-string authors', () => {
    expect(() => parseBookMetadata({ ...valid, authors: ['ok', 3] })).toThrow(/authors are invalid/);
  });

  it('rejects non-string identifier values', () => {
    expect(() => parseBookMetadata({ ...valid, identifiers: { isbn: 123 } })).toThrow(
      /identifiers must contain only strings/,
    );
  });

  it('rejects a missing source_filename', () => {
    const { source_filename: _omit, ...withoutFilename } = valid;
    expect(() => parseBookMetadata(withoutFilename)).toThrow(/source_filename is invalid/);
  });
});
