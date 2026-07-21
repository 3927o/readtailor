import { describe, expect, it } from 'vitest';
import fixtureValue from './fixtures/reading-nodes-1.0.valid.json';
import { ReaderContractError } from './errors';
import { parseReadingManifest, parseReadingManifestJson } from './manifest';
import type { ReadingManifest } from './manifest-schema';

const fixture = (): ReadingManifest => structuredClone(fixtureValue) as ReadingManifest;

function expectFailure(
  mutate: (manifest: Record<string, any>) => void,
  code: ReaderContractError['code'],
  path?: string,
) {
  const value = fixture() as unknown as Record<string, any>;
  mutate(value);
  try {
    parseReadingManifest(value);
    throw new Error('expected manifest parsing to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(ReaderContractError);
    expect((error as ReaderContractError).code).toBe(code);
    if (path) expect((error as ReaderContractError).path).toContain(path);
  }
}

describe('reading manifest parsing', () => {
  it('accepts the complete current manifest and JSON', () => {
    expect(parseReadingManifest(fixture()).bookTotalCharacters).toBe(13);
    expect(parseReadingManifestJson(JSON.stringify(fixture())).nodes).toHaveLength(5);
  });

  it('rejects invalid JSON and old snake_case fields', () => {
    expect(() => parseReadingManifestJson('{')).toThrowError(expect.objectContaining({ code: 'invalid_manifest_shape' }));
    expectFailure((value) => {
      value.book_total_characters = value.bookTotalCharacters;
      delete value.bookTotalCharacters;
    }, 'invalid_manifest_shape');
  });

  it('rejects unknown versions and nullable firstNodeOrder', () => {
    expectFailure((value) => { value.version = 'reading-nodes-2.0'; }, 'unsupported_manifest_version', 'version');
    expectFailure((value) => { value.outline[0].firstNodeOrder = null; }, 'invalid_manifest_shape');
  });

  it.each([
    ['node count', (value: any) => { value.nodeCount += 1; }, 'nodeCount'],
    ['node order', (value: any) => { value.nodes[1].order = 7; }, 'nodes[1].order'],
    ['node key', (value: any) => { value.nodes[3].segment = 1; }, 'nodes[3].segment'],
    ['block index', (value: any) => { value.nodes[1].blocks[1].blockIndex = 3; }, 'nodes[1].blocks[1].blockIndex'],
    ['block count', (value: any) => { value.nodes[1].blockCount = 1; }, 'nodes[1].blockCount'],
    ['character count', (value: any) => { value.nodes[1].characterCount = 5; }, 'nodes[1].characterCount'],
    ['node absolute start', (value: any) => { value.nodes[2].nodeAbsoluteStart = 6; }, 'nodes[2].nodeAbsoluteStart'],
    ['block absolute start', (value: any) => { value.nodes[1].blocks[1].blockAbsoluteStart = 4; }, 'nodes[1].blocks[1].blockAbsoluteStart'],
    ['book total', (value: any) => { value.bookTotalCharacters = 99; }, 'bookTotalCharacters'],
    ['outline order', (value: any) => { value.outline[0].firstNodeOrder = 99; }, 'outline[0].firstNodeOrder'],
    ['eligibility', (value: any) => { value.nodes[1].exclusionReason = 'excluded'; }, 'nodes[1].tailoringEligible'],
    ['validation summary', (value: any) => { value.validation.errorCount = 1; }, 'validation.isValid'],
  ])('rejects inconsistent %s', (_name, mutate, path) => {
    expectFailure(mutate, 'invalid_manifest_semantics', path);
  });

  it('rejects missing outline parents and cycles', () => {
    expectFailure((value) => { value.outline[2].parentSectionId = 'missing'; }, 'invalid_manifest_semantics', 'parentSectionId');
    expectFailure((value) => { value.outline[1].parentSectionId = 'chapter-1'; }, 'invalid_manifest_semantics', 'parentSectionId');
  });
});
