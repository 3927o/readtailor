import type { ReadingManifest } from '@readtailor/reader-core';

// Published packages have already passed the normalization publication gate.
// Keep the single trusted JSON assertion at this resource boundary.
export function readPublishedReadingManifestJson(json: string): ReadingManifest {
  return JSON.parse(json) as ReadingManifest;
}
