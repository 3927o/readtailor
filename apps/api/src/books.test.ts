import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { SharedBook } from '@readtailor/contracts';
import { FileSystemObjectStorage } from '@readtailor/storage';
import { createBookService, type ReadyBookRecord } from './books';

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

const publicBook: SharedBook = {
  id: 'a3bb189e-8bf9-3888-9912-ace4e6543002',
  epubSha256: 'a'.repeat(64),
  status: 'ready',
  title: 'Book',
  authors: ['Author'],
  language: 'zh',
  coverPath: null,
  identifiers: {},
  publisher: null,
  publishedDate: null,
  sourceFilename: 'book.epub',
  package: {
    id: 'd08c8fca-8c88-485f-b674-9a332c00abf8',
    version: 'v1',
    contractVersion: 'nb-1.0',
    manifestVersion: 'reading-nodes-1.0',
    createdAt: '2026-07-13T00:00:00.000Z',
  },
};

const artifacts = {
  'reading_manifest.json': '{"version":"reading-nodes-1.0"}',
  'book_profile.json': '{"version":"book-profile-1.0"}',
  'book.normalized.html': '<main id="book"></main>',
  'assets/cover.jpg': 'image',
};

function readyRecord(): ReadyBookRecord {
  return {
    ...publicBook,
    objectPrefix: 'books/hash/packages/v1',
    fileHashes: Object.fromEntries(
      Object.entries(artifacts).map(([path, value]) => [path, hash(value)]),
    ),
    profileObjectKey: 'books/hash/packages/v1/book_profile.json',
    profileSha256: hash(artifacts['book_profile.json']),
  };
}

function createMemoryStorage(values: Record<string, string>) {
  return {
    async get(key: string) {
      const value = values[key];
      if (value === undefined) {
        const storage = new FileSystemObjectStorage('/unused');
        return storage.get(key);
      }
      return new TextEncoder().encode(value);
    },
    async put() {
      throw new Error('not used');
    },
    async putIfAbsent() {
      throw new Error('not used');
    },
    async head() {
      return undefined;
    },
    async delete() {},
    async list() {
      return [];
    },
  };
}

describe('createBookService', () => {
  it('reads the current immutable package through storage', async () => {
    const record = readyRecord();
    const service = createBookService({
      repository: { async getReadyBook() { return record; } },
      storage: createMemoryStorage({
        ...Object.fromEntries(
          Object.entries(artifacts).map(([path, value]) => [`${record.objectPrefix}/${path}`, value]),
        ),
      }),
    });

    await expect(service.getBook(record.id)).resolves.toEqual(publicBook);
    await expect(service.getManifest(record.id)).resolves.toEqual({ version: 'reading-nodes-1.0' });
    await expect(service.getProfile(record.id)).resolves.toEqual({ version: 'book-profile-1.0' });
    await expect(service.getContent(record.id)).resolves.toBeInstanceOf(Uint8Array);
    await expect(service.getAsset(record.id, 'cover.jpg')).resolves.toBeInstanceOf(Uint8Array);
  });

  it('rejects asset paths that can leave the package asset directory', async () => {
    const record = readyRecord();
    const service = createBookService({
      repository: { async getReadyBook() { return record; } },
      storage: createMemoryStorage({}),
    });
    await expect(service.getAsset(record.id, '../book.normalized.html')).resolves.toBeNull();
    await expect(service.getAsset(record.id, '%2e%2e/book.normalized.html')).resolves.toBeNull();
  });

  it('rejects objects that are absent from or differ from the package inventory', async () => {
    const record = readyRecord();
    const service = createBookService({
      repository: { async getReadyBook() { return record; } },
      storage: createMemoryStorage({
        [`${record.objectPrefix}/assets/cover.jpg`]: 'tampered',
        [`${record.objectPrefix}/assets/injected.jpg`]: 'injected',
      }),
    });

    await expect(service.getAsset(record.id, 'injected.jpg')).resolves.toBeNull();
    await expect(service.getAsset(record.id, 'cover.jpg')).rejects.toThrow('integrity check');
  });
});
