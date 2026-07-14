import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Canonical structured book metadata carried by the normalized package.
 *
 * The normalizer (agent-authored `normalize.py`, or a fixture normalizer) emits
 * this as a standalone `metadata.json` artifact. It is the single source of
 * truth for the bibliographic fields that later populate the shared book
 * database record and feed the book-analysis agent.
 */
export type BookMetadata = {
  title: string;
  authors: string[];
  language: string;
  cover_path: string | null;
  identifiers: Record<string, string>;
  publisher: string | null;
  published_date: string | null;
  source_filename: string;
};

/** File name of the metadata artifact inside a normalized package. */
export const BOOK_METADATA_FILE = 'metadata.json';

/**
 * Validate an arbitrary value as {@link BookMetadata}. Throws a descriptive
 * error on the first violated constraint so the normalization agent gets an
 * actionable message from the finish gate.
 */
export function parseBookMetadata(value: unknown): BookMetadata {
  if (!value || typeof value !== 'object') throw new Error('metadata.json is missing or not an object');
  const metadata = value as Record<string, unknown>;
  const nullableString = (name: string): string | null => {
    const field = metadata[name];
    if (field === null) return null;
    if (typeof field !== 'string') throw new Error(`metadata.json ${name} is invalid`);
    return field;
  };
  if (typeof metadata.title !== 'string' || !metadata.title.trim()) {
    throw new Error('metadata.json title is invalid');
  }
  if (
    !Array.isArray(metadata.authors) ||
    !metadata.authors.every((author) => typeof author === 'string')
  ) {
    throw new Error('metadata.json authors are invalid');
  }
  if (typeof metadata.language !== 'string' || !metadata.language.trim()) {
    throw new Error('metadata.json language is invalid');
  }
  if (!metadata.identifiers || typeof metadata.identifiers !== 'object') {
    throw new Error('metadata.json identifiers are invalid');
  }
  const identifiers = metadata.identifiers as Record<string, unknown>;
  if (!Object.values(identifiers).every((identifier) => typeof identifier === 'string')) {
    throw new Error('metadata.json identifiers must contain only strings');
  }
  if (typeof metadata.source_filename !== 'string' || !metadata.source_filename) {
    throw new Error('metadata.json source_filename is invalid');
  }
  return {
    title: metadata.title,
    authors: metadata.authors as string[],
    language: metadata.language,
    cover_path: nullableString('cover_path'),
    identifiers: identifiers as Record<string, string>,
    publisher: nullableString('publisher'),
    published_date: nullableString('published_date'),
    source_filename: metadata.source_filename,
  };
}

/** Read and validate the `metadata.json` artifact from a package directory. */
export async function readBookMetadata(packageDirectory: string): Promise<BookMetadata> {
  let raw: string;
  try {
    raw = await readFile(join(packageDirectory, BOOK_METADATA_FILE), 'utf8');
  } catch {
    throw new Error(`normalized package is missing ${BOOK_METADATA_FILE}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${BOOK_METADATA_FILE} is not valid JSON: ${(error as Error).message}`);
  }
  return parseBookMetadata(parsed);
}
