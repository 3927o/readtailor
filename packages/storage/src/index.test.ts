import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createObjectStorage,
  FileSystemObjectStorage,
  ObjectNotFoundError,
  S3ObjectStorage,
} from './index';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('FileSystemObjectStorage', () => {
  it('stores, reads, lists and deletes objects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'readtailor-storage-'));
    roots.push(root);
    const storage = new FileSystemObjectStorage(root);
    const body = new TextEncoder().encode('book');

    const stored = await storage.put('books/a/content.txt', body, 'text/plain');
    expect(stored.size).toBe(4);
    expect(new TextDecoder().decode(await storage.get(stored.key))).toBe('book');
    expect(await storage.list('books/a')).toEqual([
      { key: 'books/a/content.txt', size: 4 },
    ]);

    await storage.delete(stored.key);
    expect(await storage.head(stored.key)).toBeUndefined();
    await expect(storage.get(stored.key)).rejects.toBeInstanceOf(ObjectNotFoundError);
  });

  it('atomically preserves the first immutable object', async () => {
    const root = await mkdtemp(join(tmpdir(), 'readtailor-storage-'));
    roots.push(root);
    const storage = new FileSystemObjectStorage(root);

    const [first, second] = await Promise.all([
      storage.putIfAbsent('books/a/immutable.txt', new TextEncoder().encode('first')),
      storage.putIfAbsent('books/a/immutable.txt', new TextEncoder().encode('second')),
    ]);

    expect([first.created, second.created].sort()).toEqual([false, true]);
    const value = new TextDecoder().decode(await storage.get('books/a/immutable.txt'));
    expect(['first', 'second']).toContain(value);
  });

  it('rejects keys that can escape the configured root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'readtailor-storage-'));
    roots.push(root);
    const storage = new FileSystemObjectStorage(root);
    await expect(storage.put('../outside', new Uint8Array())).rejects.toThrow('invalid object key');
    await expect(storage.put('books/./alias', new Uint8Array())).rejects.toThrow('invalid object key');
  });
});

describe('createObjectStorage', () => {
  it('rejects ambiguous backends and partial static credentials', () => {
    expect(() => createObjectStorage({ localRoot: '/tmp/books', bucket: 'books' })).toThrow(
      'either OBJECT_STORAGE_LOCAL_ROOT or OBJECT_STORAGE_BUCKET',
    );
    expect(() => createObjectStorage({ bucket: 'books', accessKeyId: 'key' })).toThrow(
      'must be configured together',
    );
  });

  it('allows virtual-host style when an endpoint is configured', () => {
    const storage = createObjectStorage({
      bucket: 'books',
      endpoint: 'https://s3.example.com',
      forcePathStyle: false,
    });
    const client = (
      storage as unknown as { client: { config: { forcePathStyle: boolean } } }
    ).client;

    expect(client.config.forcePathStyle).toBe(false);
  });
});

describe('S3ObjectStorage', () => {
  it('falls back when the provider rejects If-None-Match on PutObject', async () => {
    const storage = new S3ObjectStorage('books', { region: 'test' });
    const client = (storage as unknown as { client: { send: ReturnType<typeof vi.fn> } }).client;
    client.send = vi.fn().mockRejectedValueOnce(
      Object.assign(new Error('conditional writes are unsupported'), {
        name: 'NotImplemented',
        Code: 'NotImplemented',
        Header: 'If-None-Match',
        $metadata: { httpStatusCode: 400 },
      }),
    );
    vi.spyOn(storage, 'head').mockResolvedValue(undefined);
    const put = vi.spyOn(storage, 'put').mockResolvedValue({
      key: 'books/a/immutable.txt',
      size: 4,
    });

    const result = await storage.putIfAbsent(
      'books/a/immutable.txt',
      new TextEncoder().encode('book'),
      'text/plain',
    );

    expect(result.created).toBe(true);
    expect(put).toHaveBeenCalledOnce();
  });

  it('does not overwrite an existing object in the compatibility fallback', async () => {
    const storage = new S3ObjectStorage('books', { region: 'test' });
    const client = (storage as unknown as { client: { send: ReturnType<typeof vi.fn> } }).client;
    client.send = vi.fn().mockRejectedValueOnce(
      Object.assign(new Error('conditional writes are unsupported'), {
        name: 'NotImplemented',
        Code: 'NotImplemented',
        Header: 'If-None-Match',
        $metadata: { httpStatusCode: 400 },
      }),
    );
    vi.spyOn(storage, 'head').mockResolvedValue({ key: 'books/a/immutable.txt', size: 4 });
    const put = vi.spyOn(storage, 'put');

    const result = await storage.putIfAbsent(
      'books/a/immutable.txt',
      new TextEncoder().encode('book'),
    );

    expect(result.created).toBe(false);
    expect(put).not.toHaveBeenCalled();
  });
});
