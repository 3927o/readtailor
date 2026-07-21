import { describe, expect, it } from 'vitest';
import fixture from '../../reader-core/src/fixtures/reading-nodes-1.0.valid.json';
import { validateReadingManifestForPublication } from './reading-manifest';

describe('reading manifest publication gate', () => {
  it('accepts a fully valid manifest with the package version', () => {
    expect(validateReadingManifestForPublication(
      JSON.stringify(fixture),
      'reading-nodes-1.0',
    ).nodeCount).toBe(5);
  });

  it('reports schema paths and package version mismatches', () => {
    const invalid = structuredClone(fixture) as any;
    invalid.nodes[0].blockCount = 9;
    expect(() => validateReadingManifestForPublication(
      JSON.stringify(invalid),
      'reading-nodes-1.0',
    )).toThrowError(expect.objectContaining({
      code: 'invalid_manifest_semantics',
      path: 'nodes[0].blockCount',
    }));
    expect(() => validateReadingManifestForPublication(
      JSON.stringify(fixture),
      'reading-nodes-0.9',
    )).toThrowError(expect.objectContaining({
      code: 'invalid_manifest_semantics',
      path: 'manifestVersion',
    }));
  });
});
