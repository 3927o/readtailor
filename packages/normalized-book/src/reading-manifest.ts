import {
  ReaderContractError,
  parseReadingManifestJson,
  type ReadingManifest,
} from '@readtailor/reader-core';

export function validateReadingManifestForPublication(
  json: string,
  packageManifestVersion: string,
): ReadingManifest {
  const manifest = parseReadingManifestJson(json);
  if (manifest.version !== packageManifestVersion) {
    throw new ReaderContractError(
      'invalid_manifest_semantics',
      `reading manifest version ${manifest.version} does not match package manifest version ${packageManifestVersion}`,
      'manifestVersion',
    );
  }
  return manifest;
}
