import { type Static, Type } from '@sinclair/typebox';

export const READING_MANIFEST_VERSION = 'reading-nodes-1.0' as const;
export const TAILORING_ELIGIBILITY_VERSION = 'tailoring-eligibility-1.0' as const;

const strict = { additionalProperties: false } as const;

export const ReadingManifestBlockSchema = Type.Object({
  blockIndex: Type.Integer({ minimum: 1 }),
  kind: Type.String({ minLength: 1 }),
  blockAbsoluteStart: Type.Integer({ minimum: 0 }),
  blockUtf16Length: Type.Integer({ minimum: 0 }),
}, strict);
export type ReadingManifestBlock = Static<typeof ReadingManifestBlockSchema>;

export const ReadingManifestNodeSchema = Type.Object({
  sectionId: Type.String({ minLength: 1 }),
  segment: Type.Integer({ minimum: 1 }),
  order: Type.Integer({ minimum: 1 }),
  region: Type.String({ minLength: 1 }),
  dataType: Type.String({ minLength: 1 }),
  title: Type.String(),
  parentSectionId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  characterCount: Type.Integer({ minimum: 0 }),
  blockCount: Type.Integer({ minimum: 0 }),
  tailoringEligible: Type.Boolean(),
  exclusionReason: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  nodeAbsoluteStart: Type.Integer({ minimum: 0 }),
  blocks: Type.Array(ReadingManifestBlockSchema),
}, strict);
export type ReadingManifestNode = Static<typeof ReadingManifestNodeSchema>;

export const ReadingManifestOutlineItemSchema = Type.Object({
  sectionId: Type.String({ minLength: 1 }),
  dataType: Type.String({ minLength: 1 }),
  title: Type.String(),
  parentSectionId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  firstNodeOrder: Type.Integer({ minimum: 1 }),
}, strict);
export type ReadingManifestOutlineItem = Static<typeof ReadingManifestOutlineItemSchema>;

export const ReadingManifestSchema = Type.Object({
  version: Type.Literal(READING_MANIFEST_VERSION),
  tailoringEligibilityVersion: Type.Literal(TAILORING_ELIGIBILITY_VERSION),
  document: Type.Object({
    title: Type.String(),
    language: Type.String({ minLength: 1 }),
  }, strict),
  outline: Type.Array(ReadingManifestOutlineItemSchema),
  bookTotalCharacters: Type.Integer({ minimum: 0 }),
  nodeCount: Type.Integer({ minimum: 0 }),
  nodes: Type.Array(ReadingManifestNodeSchema),
  warnings: Type.Array(Type.String()),
  validation: Type.Object({
    isValid: Type.Boolean(),
    errorCount: Type.Integer({ minimum: 0 }),
    warningCount: Type.Integer({ minimum: 0 }),
  }, strict),
}, strict);
export type ReadingManifest = Static<typeof ReadingManifestSchema>;
