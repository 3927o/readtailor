import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { FileSystemObjectStorage } from '@readtailor/storage';
import {
  assertRequiredArtifacts,
  buildArtifactInventory,
  hashArtifactInventory,
  publishImmutablePackage,
} from './index';

const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('artifact inventory', () => {
  it('is deterministic and includes path, size and content hash', async () => {
    const root = await temporaryDirectory('readtailor-inventory-');
    await mkdir(join(root, 'assets'));
    await writeFile(join(root, 'book.normalized.html'), '<html></html>');
    await writeFile(join(root, 'assets', 'cover.jpg'), 'image');

    const first = await buildArtifactInventory(root);
    const second = await buildArtifactInventory(root);

    expect(second).toEqual(first);
    expect(hashArtifactInventory(second)).toBe(hashArtifactInventory(first));
    expect(first.files.map((entry) => entry.path)).toEqual([
      'assets/cover.jpg',
      'book.normalized.html',
    ]);
  });

  it('matches the sandbox inventory for mixed Unicode and case-sensitive paths', async () => {
    const root = await temporaryDirectory('readtailor-cross-inventory-');
    const output = join(root, 'output', 'current');
    await mkdir(output, { recursive: true });
    for (const name of ['a.txt', 'A.txt', 'é.txt', '中.txt']) {
      await writeFile(join(output, name), name);
    }
    const nodeInventory = await buildArtifactInventory(output);
    const { stdout } = await execFileAsync(
      'python3',
      [join(process.cwd(), 'tools/normalization_sandbox.py'), 'inventory'],
      { env: { ...process.env, READTAILOR_SANDBOX_ROOT: root } },
    );
    const sandboxInventory = JSON.parse(stdout) as { sha256: string };

    expect(sandboxInventory.sha256).toBe(hashArtifactInventory(nodeInventory));
  });

  it('rejects a missing required artifact', async () => {
    const root = await temporaryDirectory('readtailor-required-');
    await writeFile(join(root, 'book.normalized.html'), '<html></html>');
    const inventory = await buildArtifactInventory(root);

    expect(() => assertRequiredArtifacts(inventory, ['reading_manifest.json'])).toThrow(
      'missing required file',
    );
  });
});

describe('immutable publisher', () => {
  async function makePackage(): Promise<string> {
    const root = await temporaryDirectory('readtailor-package-');
    const files: Array<[string, string]> = [
      ['book.normalized.html', '<html></html>'],
      ['reading_manifest.json', '{}'],
      ['book_profile.json', '{}'],
      ['normalization_report.json', '{}'],
      ['validation_report.txt', '0 errors'],
    ];
    for (const [path, content] of files) {
      await writeFile(join(root, path), content);
    }
    return root;
  }

  it('publishes idempotently and verifies every stored hash', async () => {
    const packageDirectory = await makePackage();
    const storageRoot = await temporaryDirectory('readtailor-storage-');
    const storage = new FileSystemObjectStorage(storageRoot);

    const first = await publishImmutablePackage({
      storage,
      packageDirectory,
      objectPrefix: 'books/hash/packages/v1',
    });
    const second = await publishImmutablePackage({
      storage,
      packageDirectory,
      objectPrefix: 'books/hash/packages/v1',
    });

    expect(second.inventorySha256).toBe(first.inventorySha256);
    expect(second.fileHashes).toEqual(first.fileHashes);
  });

  it('rejects an existing immutable key with different bytes', async () => {
    const packageDirectory = await makePackage();
    const storageRoot = await temporaryDirectory('readtailor-storage-conflict-');
    const storage = new FileSystemObjectStorage(storageRoot);
    await storage.put('books/hash/packages/v1/book.normalized.html', new TextEncoder().encode('bad'));

    await expect(
      publishImmutablePackage({
        storage,
        packageDirectory,
        objectPrefix: 'books/hash/packages/v1',
      }),
    ).rejects.toThrow('different content');
  });
});
