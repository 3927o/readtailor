import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

export type ArtifactInventoryEntry = {
  path: string;
  sha256: string;
  byteSize: number;
};

export type ArtifactInventory = {
  version: 'artifact-inventory-1.0';
  files: ArtifactInventoryEntry[];
};

export function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

export function assertSafeRelativePath(path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/^\/+/, '');
  if (
    !normalized ||
    [...normalized].some((character) => character.charCodeAt(0) < 0x20) ||
    normalized.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error(`unsafe package path: ${path}`);
  }
  return normalized;
}

export function hashArtifactInventory(inventory: ArtifactInventory): string {
  const canonical = inventory.files
    .map((entry) => `${entry.path}\0${entry.byteSize}\0${entry.sha256}\n`)
    .join('');
  return sha256(`${inventory.version}\n${canonical}`);
}

export async function buildArtifactInventory(
  root: string,
  limits: { maxFiles?: number; maxTotalBytes?: number; maxFileBytes?: number } = {},
): Promise<ArtifactInventory> {
  const absoluteRoot = resolve(root);
  const files: ArtifactInventoryEntry[] = [];
  const maxFiles = limits.maxFiles ?? 20_000;
  const maxTotalBytes = limits.maxTotalBytes ?? 512 * 1024 * 1024;
  const maxFileBytes = limits.maxFileBytes ?? 128 * 1024 * 1024;
  let totalBytes = 0;

  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`package must not contain symbolic links: ${absolutePath}`);
      }
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`package contains unsupported filesystem entry: ${absolutePath}`);
      }
      const path = assertSafeRelativePath(relative(absoluteRoot, absolutePath).split(sep).join('/'));
      const info = await stat(absolutePath);
      if (info.size > maxFileBytes) {
        throw new Error(`artifact exceeds the ${maxFileBytes}-byte single-file limit: ${path}`);
      }
      totalBytes += info.size;
      if (totalBytes > maxTotalBytes) {
        throw new Error(`artifact inventory exceeds the ${maxTotalBytes}-byte total limit`);
      }
      if (files.length >= maxFiles) {
        throw new Error(`artifact inventory exceeds the ${maxFiles}-file limit`);
      }
      files.push({ path, sha256: await sha256File(absolutePath), byteSize: info.size });
    }
  };

  await visit(absoluteRoot);
  files.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  return { version: 'artifact-inventory-1.0', files };
}

export function assertRequiredArtifacts(
  inventory: ArtifactInventory,
  required: readonly string[],
): void {
  const paths = new Set(inventory.files.map((entry) => entry.path));
  for (const path of required) {
    const normalized = assertSafeRelativePath(path);
    if (!paths.has(normalized)) {
      throw new Error(`normalized package is missing required file: ${normalized}`);
    }
  }
}

export async function verifyArtifactInventory(
  root: string,
  expected: ArtifactInventory,
): Promise<void> {
  const actual = await buildArtifactInventory(root);
  if (hashArtifactInventory(actual) !== hashArtifactInventory(expected)) {
    throw new Error('artifact inventory does not match the expected immutable inventory');
  }
  for (const entry of expected.files) {
    const info = await stat(join(root, assertSafeRelativePath(entry.path)));
    if (!info.isFile() || info.size !== entry.byteSize) {
      throw new Error(`artifact size changed after inventory creation: ${entry.path}`);
    }
  }
}
