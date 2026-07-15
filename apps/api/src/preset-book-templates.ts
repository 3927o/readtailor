import type {
  BookReaderProfile,
  Briefing,
  GenerationResult,
  Strategy,
} from '@readtailor/contracts';
import {
  BookReaderProfileSchema,
  BriefingSchema,
  GenerationResultSchema,
  StrategySchema,
} from '@readtailor/contracts';
import { Value } from '@sinclair/typebox/value';
import zarathustraTemplateJson from './preset-book-templates/zarathustra.v1.json';

export type PresetReadyGenerationTemplate = {
  sectionId: string;
  segment: number;
  result: GenerationResult;
  modelConfigId: string;
  promptVersion: string;
  attemptCount: number;
  maxAttempts: number;
};

export type PresetTrialSegmentTemplate = {
  ordinal: number;
  sectionId: string;
  segment: number;
  startBlockIndex: number;
  startOffset: number;
  endBlockIndex: number;
  endOffset: number;
  selectionReason: string;
  generation: PresetReadyGenerationTemplate;
};

export type PresetBookTemplate = {
  schemaVersion: 1;
  key: string;
  source: {
    userBookId: string;
    sharedBookId: string;
  };
  book: {
    title: string;
    epubSha256: string;
    packageVersion: string;
    manifestVersion: string;
    readingManifestSha256: string;
  };
  profile: BookReaderProfile;
  readingBriefing: Briefing;
  userFacingSummary: string;
  strategy: Strategy;
  trial: {
    segments: PresetTrialSegmentTemplate[];
  } | null;
  formalGenerations: PresetReadyGenerationTemplate[];
};

const zarathustraTemplate = zarathustraTemplateJson as unknown as PresetBookTemplate;

function isValidGeneration(generation: PresetReadyGenerationTemplate): boolean {
  return (
    Boolean(generation.sectionId) &&
    generation.segment >= 1 &&
    generation.attemptCount >= 0 &&
    generation.maxAttempts >= 1 &&
    generation.attemptCount <= generation.maxAttempts &&
    Boolean(generation.modelConfigId) &&
    Boolean(generation.promptVersion) &&
    Value.Check(GenerationResultSchema, generation.result)
  );
}

function assertValidTemplate(template: PresetBookTemplate): void {
  if (template.schemaVersion !== 1) {
    throw new Error(`unsupported preset book template version: ${template.schemaVersion}`);
  }
  if (
    !template.key ||
    !template.book.title ||
    !/^[0-9a-f]{64}$/.test(template.book.epubSha256) ||
    !template.book.packageVersion ||
    !template.book.manifestVersion ||
    !/^[0-9a-f]{64}$/.test(template.book.readingManifestSha256)
  ) {
    throw new Error(`invalid preset book identity in template ${template.key}`);
  }
  if (
    !Value.Check(BookReaderProfileSchema, template.profile) ||
    !Value.Check(BriefingSchema, template.readingBriefing) ||
    !Value.Check(StrategySchema, template.strategy)
  ) {
    throw new Error(`invalid profile, briefing, or strategy in template ${template.key}`);
  }
  if (template.trial && template.trial.segments.length !== 3) {
    throw new Error(`preset template ${template.key} must contain three trial segments`);
  }
  if (template.formalGenerations.length === 0) {
    throw new Error(`preset template ${template.key} has no formal generations`);
  }

  const formalKeys = new Set<string>();
  for (const generation of template.formalGenerations) {
    const key = `${generation.sectionId}:${generation.segment}`;
    if (!isValidGeneration(generation) || formalKeys.has(key)) {
      throw new Error(`invalid or duplicate formal generation ${key} in template ${template.key}`);
    }
    formalKeys.add(key);
  }

  if (template.trial) {
    const ordinals = new Set<number>();
    for (const segment of template.trial.segments) {
      if (
        segment.ordinal < 1 ||
        segment.ordinal > 3 ||
        ordinals.has(segment.ordinal) ||
        segment.generation.sectionId !== segment.sectionId ||
        segment.generation.segment !== segment.segment ||
        !isValidGeneration(segment.generation)
      ) {
        throw new Error(
          `invalid trial segment ${segment.ordinal} in preset template ${template.key}`,
        );
      }
      ordinals.add(segment.ordinal);
    }
  }
}

assertValidTemplate(zarathustraTemplate);
const templatesByEpubSha256 = new Map<string, PresetBookTemplate>([
  [zarathustraTemplate.book.epubSha256, zarathustraTemplate],
]);

export function getPresetBookTemplate(book: {
  epubSha256: string;
  title: string;
  packageVersion: string;
  manifestVersion: string;
  readingManifestSha256: string;
}): PresetBookTemplate | undefined {
  const template = templatesByEpubSha256.get(book.epubSha256);
  if (!template) return undefined;
  if (
    template.book.title !== book.title ||
    template.book.packageVersion !== book.packageVersion ||
    template.book.manifestVersion !== book.manifestVersion ||
    template.book.readingManifestSha256 !== book.readingManifestSha256
  ) {
    throw new Error(
      `preset book template package mismatch for ${template.key}; export a new template version`,
    );
  }
  return template;
}
