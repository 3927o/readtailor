import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ObjectStorage } from '@readtailor/storage';
import {
  assertRequiredArtifacts,
  assertSafeRelativePath,
  buildArtifactInventory,
  hashArtifactInventory,
  sha256,
  type ArtifactInventory,
} from './artifacts';

const DEFAULT_REQUIRED_PACKAGE_FILES = [
  'book.normalized.html',
  'reading_manifest.json',
  'book_profile.json',
  'normalization_report.json',
  'validation_report.txt',
] as const;

function contentType(path: string): string | undefined {
  const extension = path.split('.').pop()?.toLowerCase();
  return {
    html: 'text/html; charset=utf-8',
    json: 'application/json',
    txt: 'text/plain; charset=utf-8',
    jpeg: 'image/jpeg',
    jpg: 'image/jpeg',
    png: 'image/png',
    svg: 'image/svg+xml',
    gif: 'image/gif',
    webp: 'image/webp',
  }[extension ?? ''];
}

export type ImmutablePublicationReceipt = {
  objectPrefix: string;
  inventory: ArtifactInventory;
  inventorySha256: string;
  fileHashes: Record<string, string>;
};

export async function publishImmutablePackage(options: {
  storage: ObjectStorage;
  packageDirectory: string;
  objectPrefix: string;
  requiredFiles?: readonly string[];
}): Promise<ImmutablePublicationReceipt> {
  const prefix = options.objectPrefix.replace(/^\/+|\/+$/g, '');
  if (!prefix) {
    throw new Error('immutable package object prefix is required');
  }
  const inventory = await buildArtifactInventory(options.packageDirectory);
  assertRequiredArtifacts(inventory, options.requiredFiles ?? DEFAULT_REQUIRED_PACKAGE_FILES);

  const fileHashes: Record<string, string> = {};
  for (const entry of inventory.files) {
    const path = assertSafeRelativePath(entry.path);
    const bytes = await readFile(join(options.packageDirectory, path));
    if (sha256(bytes) !== entry.sha256 || bytes.byteLength !== entry.byteSize) {
      throw new Error(`artifact changed while publishing: ${path}`);
    }
    const key = `${prefix}/${path}`;
    const put = await options.storage.putIfAbsent(key, bytes, contentType(path));
    if (!put.created) {
      const existing = await options.storage.get(key);
      if (sha256(existing) !== entry.sha256 || existing.byteLength !== entry.byteSize) {
        throw new Error(`immutable object already exists with different content: ${key}`);
      }
    }
    fileHashes[path] = entry.sha256;
  }

  for (const entry of inventory.files) {
    const bytes = await options.storage.get(`${prefix}/${entry.path}`);
    if (sha256(bytes) !== entry.sha256 || bytes.byteLength !== entry.byteSize) {
      throw new Error(`published object failed hash verification: ${entry.path}`);
    }
  }

  return {
    objectPrefix: prefix,
    inventory,
    inventorySha256: hashArtifactInventory(inventory),
    fileHashes,
  };
}
