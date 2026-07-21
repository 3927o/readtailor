import { Value } from '@sinclair/typebox/value';
import { ReaderContractError } from './errors';
import {
  READING_MANIFEST_VERSION,
  ReadingManifestSchema,
  type ReadingManifest,
} from './manifest-schema';

function semanticError(message: string, path: string): never {
  throw new ReaderContractError('invalid_manifest_semantics', message, path);
}

export function validateReadingManifest(manifest: ReadingManifest): void {
  if (manifest.nodeCount !== manifest.nodes.length) {
    semanticError('nodeCount does not match nodes length', 'nodeCount');
  }

  const nodeKeys = new Set<string>();
  let absoluteStart = 0;
  manifest.nodes.forEach((node, nodeIndex) => {
    const nodePath = `nodes[${nodeIndex}]`;
    if (node.order !== nodeIndex + 1) semanticError('node order does not match array position', `${nodePath}.order`);
    const key = `${node.sectionId}\0${node.segment}`;
    if (nodeKeys.has(key)) semanticError('duplicate sectionId and segment', `${nodePath}.segment`);
    nodeKeys.add(key);
    if (node.blockCount !== node.blocks.length) semanticError('blockCount does not match blocks length', `${nodePath}.blockCount`);
    if (node.nodeAbsoluteStart !== absoluteStart) semanticError('nodeAbsoluteStart is inconsistent', `${nodePath}.nodeAbsoluteStart`);

    let characterCount = 0;
    node.blocks.forEach((block, blockIndex) => {
      const blockPath = `${nodePath}.blocks[${blockIndex}]`;
      if (block.blockIndex !== blockIndex + 1) semanticError('blockIndex does not match array position', `${blockPath}.blockIndex`);
      if (block.blockAbsoluteStart !== absoluteStart + characterCount) {
        semanticError('blockAbsoluteStart is inconsistent', `${blockPath}.blockAbsoluteStart`);
      }
      characterCount += block.blockUtf16Length;
    });
    if (node.characterCount !== characterCount) semanticError('characterCount does not match block lengths', `${nodePath}.characterCount`);
    if (node.tailoringEligible !== (node.exclusionReason === null)) {
      semanticError('tailoringEligible and exclusionReason are inconsistent', `${nodePath}.tailoringEligible`);
    }
    absoluteStart += node.characterCount;
  });
  if (manifest.bookTotalCharacters !== absoluteStart) {
    semanticError('bookTotalCharacters does not match node character counts', 'bookTotalCharacters');
  }

  const outlineById = new Map<string, (typeof manifest.outline)[number]>();
  manifest.outline.forEach((item, index) => {
    const path = `outline[${index}]`;
    if (outlineById.has(item.sectionId)) semanticError('duplicate outline sectionId', `${path}.sectionId`);
    outlineById.set(item.sectionId, item);
    if (!manifest.nodes[item.firstNodeOrder - 1]) semanticError('firstNodeOrder points to an unknown node', `${path}.firstNodeOrder`);
  });
  manifest.outline.forEach((item, index) => {
    if (item.parentSectionId !== null && !outlineById.has(item.parentSectionId)) {
      semanticError('parentSectionId points to an unknown outline item', `outline[${index}].parentSectionId`);
    }
    const visited = new Set<string>([item.sectionId]);
    let current = item;
    while (current.parentSectionId !== null) {
      if (visited.has(current.parentSectionId)) semanticError('outline parent relationship contains a cycle', `outline[${index}].parentSectionId`);
      visited.add(current.parentSectionId);
      const parent = outlineById.get(current.parentSectionId);
      if (!parent) break;
      current = parent;
    }
  });

  if (manifest.validation.isValid !== (manifest.validation.errorCount === 0)) {
    semanticError('validation.isValid and validation.errorCount are inconsistent', 'validation.isValid');
  }
}

export function parseReadingManifest(value: unknown): ReadingManifest {
  if (
    typeof value === 'object'
    && value !== null
    && 'version' in value
    && (value as { version?: unknown }).version !== READING_MANIFEST_VERSION
  ) {
    throw new ReaderContractError(
      'unsupported_manifest_version',
      `unsupported reading manifest version: ${String((value as { version?: unknown }).version)}`,
      'version',
    );
  }
  if (!Value.Check(ReadingManifestSchema, value)) {
    const issue = Value.Errors(ReadingManifestSchema, value).First();
    throw new ReaderContractError(
      'invalid_manifest_shape',
      issue ? `invalid reading manifest: ${issue.message}` : 'invalid reading manifest shape',
      issue?.path || undefined,
    );
  }
  validateReadingManifest(value);
  return value;
}

export function parseReadingManifestJson(json: string): ReadingManifest {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    throw new ReaderContractError(
      'invalid_manifest_shape',
      `invalid reading manifest JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseReadingManifest(value);
}
