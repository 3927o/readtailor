import { describe, expect, it } from 'vitest';
import { positionMatchesManifest, type ManifestMeta } from './user-books';

// §2.2/§4.3: a position must agree with the manifest node its `order` points at, or it was spliced
// from two different nodes and the server must not persist it (but a corrupt/unreadable manifest must
// never block the read). This locks the pure guard; the conditional client_observed_at upsert and the
// migration backfill are exercised at the SQL layer, which needs a Postgres integration harness.
function meta(entries: Array<[number, { sectionId: string; segment: number }]>): ManifestMeta {
  return {
    version: 'v1',
    language: null,
    bookTotalChars: null,
    charCountByOrder: new Map(),
    nodesByOrder: new Map(entries.map(([order, node]) => [order, {
      ...node,
      region: null,
      dataType: null,
      nodeStart: 0,
      charCount: 0,
      blocks: [],
    }])),
  };
}

describe('positionMatchesManifest', () => {
  const known = meta([
    [3, { sectionId: 'chapter-3', segment: 1 }],
    [4, { sectionId: 'chapter-3', segment: 2 }],
  ]);

  it('accepts an anchor whose order matches its section/segment', () => {
    expect(positionMatchesManifest(known, 3, 'chapter-3', 1)).toBe(true);
    expect(positionMatchesManifest(known, 4, 'chapter-3', 2)).toBe(true);
  });

  it('rejects an anchor whose section/segment do not belong to that order', () => {
    expect(positionMatchesManifest(known, 3, 'chapter-3', 2)).toBe(false); // wrong segment
    expect(positionMatchesManifest(known, 3, 'chapter-9', 1)).toBe(false); // wrong section
  });

  it('rejects an order absent from a known manifest', () => {
    expect(positionMatchesManifest(known, 99, 'chapter-3', 1)).toBe(false);
  });

  it('allows the write best-effort when the manifest is unreadable', () => {
    expect(positionMatchesManifest(meta([]), 3, 'chapter-3', 1)).toBe(true);
  });
});
