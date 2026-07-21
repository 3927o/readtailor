import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';
import {
  BookReaderProfileSchema,
  BriefingSchema,
  GenerationResultSchema,
  StrategySchema,
} from '@readtailor/contracts';
import { getPresetBookTemplate } from './preset-book-templates';

describe('zarathustra preset template', () => {
  it('contains valid setup data and every generated node result', () => {
    const template = getPresetBookTemplate({
      title: '查拉图斯特拉如是说',
      epubSha256: '5814044076bd72c553087c0166b65b635897b54499187f787036569abb81a6f6',
      packageVersion: 'nb-1.0-v3-reader-core-v1',
      manifestVersion: 'reading-nodes-1.0',
      readingManifestSha256:
        '615a608ddd4b0336174550dbf238d92036270d06a12d65b0197f7c515f65c52e',
    });

    expect(template).toBeDefined();
    expect(template?.source.userBookId).toBe('af778839-dea8-4e6f-89f9-31ea5e650414');
    expect(Value.Check(BookReaderProfileSchema, template?.profile)).toBe(true);
    expect(Value.Check(BriefingSchema, template?.readingBriefing)).toBe(true);
    expect(Value.Check(StrategySchema, template?.strategy)).toBe(true);
    expect(template?.trial?.segments).toHaveLength(3);
    expect(template?.formalGenerations).toHaveLength(174);
    expect(
      template?.formalGenerations.every((generation) =>
        Value.Check(GenerationResultSchema, generation.result),
      ),
    ).toBe(true);
  });
});
