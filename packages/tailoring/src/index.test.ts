import { describe, expect, it, vi } from 'vitest';
import {
  TAILORING_PROMPT_VERSION,
  TailoringError,
  buildTailoringPrompt,
  createTailoringCacheKey,
  generateTailoredContent,
  parseTailoringModelResponse,
  validateGenerationInput,
  type FormalGenerationInput,
  type TailoringGenerationInput,
  type TailoringModelClient,
  type TrialGenerationInput,
} from './index';

function trialInput(): TrialGenerationInput {
  return {
    userId: 'user-1',
    packageId: 'package-1',
    packageVersion: 'package-v3',
    generationScope: 'trial',
    fragmentRange: {
      start: { blockIndex: 2, offset: 2 },
      end: { blockIndex: 3, offset: 4 },
    },
    profiles: {
      book: { version: 'book-profile-1', value: { themes: ['language'] } },
      reader: { version: 'reader-profile-2', value: { expertise: 'newcomer' } },
      bookReader: { version: 'book-reader-profile-4', value: { goal: 'understand' } },
    },
    strategy: {
      kind: 'strategy_draft',
      version: 'draft-5',
      status: 'approved_for_trial',
      value: { annotation_style: 'explain concepts' },
    },
    source: {
      sectionId: 'chapter-1',
      segment: 1,
      nodeOrder: 7,
      title: 'The opening',
      ancestorTitles: ['Part I'],
      range: {
        start: { blockIndex: 2, offset: 2 },
        end: { blockIndex: 3, offset: 4 },
      },
      structuredHtml: '<p>😀语言和世界</p><p>下一段文字</p>',
      blocks: [
        { blockIndex: 2, kind: 'p', text: '甲😀语言和世界', utf16Length: 9, html: '<p>甲😀语言和世界</p>' },
        { blockIndex: 3, kind: 'p', text: '下一段文字', utf16Length: 6, html: '<p>下一段文字</p>' },
      ],
      originalNotes: [{ id: 'note-1', text: 'original note' }],
      previousContext: 'previous excerpt',
      nextContext: 'next excerpt',
    },
    model: { modelId: 'model-a', configVersion: 'temperature-0-v1' },
  };
}

function formalInput(): FormalGenerationInput {
  const trial = trialInput();
  const lastBlock = trial.source.blocks[trial.source.blocks.length - 1];
  if (!lastBlock) throw new Error('test fixture requires a last block');
  return {
    ...trial,
    generationScope: 'formal',
    strategy: {
      kind: 'strategy',
      version: 'strategy-1',
      status: 'active',
      value: { annotation_style: 'explain concepts' },
    },
    source: {
      ...trial.source,
      range: {
        start: { blockIndex: 1, offset: 0 },
        end: { blockIndex: 3, offset: lastBlock.text.length },
      },
      structuredHtml: '<p>第一段</p><p>甲😀语言和世界</p><p>下一段文字</p>',
      blocks: [
        { blockIndex: 1, kind: 'p', text: '第一段', utf16Length: 3, html: '<p>第一段</p>' },
        ...trial.source.blocks,
      ],
    },
  };
}

function expectTailoringError(fn: () => unknown, code: TailoringError['code']): void {
  try {
    fn();
    throw new Error('expected function to throw');
  } catch (error) {
    expect(error).toBeInstanceOf(TailoringError);
    expect((error as TailoringError).code).toBe(code);
  }
}

describe('generateTailoredContent', () => {
  it.each([
    ['trial', trialInput()],
    ['formal', formalInput()],
  ] as const)('uses the same entry point and model contract for %s generation', async (_, input) => {
    const generate = vi.fn(async () =>
      JSON.stringify({ guide: 'A guide', annotations: [], afterReading: null }),
    );
    const modelClient: TailoringModelClient = { generate };

    await expect(generateTailoredContent(input, modelClient)).resolves.toEqual({
      guide: 'A guide',
      annotations: [],
      afterReading: null,
    });
    expect(generate).toHaveBeenCalledOnce();
    expect(generate).toHaveBeenCalledWith({
      prompt: expect.stringContaining(`"promptVersion":"${TAILORING_PROMPT_VERSION}"`),
      model: input.model,
      responseFormat: 'json',
    });
  });

  it('validates input before calling the model', async () => {
    const input = trialInput();
    input.fragmentRange.end.offset = 3;
    const generate = vi.fn(async () => '{}');

    await expect(generateTailoredContent(input, { generate })).rejects.toMatchObject({
      code: 'invalid_scope',
    });
    expect(generate).not.toHaveBeenCalled();
  });
});

describe('buildTailoringPrompt', () => {
  it('uses one versioned instruction template and includes all bounded inputs', () => {
    const trialPrompt = buildTailoringPrompt(trialInput());
    const formalPrompt = buildTailoringPrompt(formalInput());

    for (const prompt of [trialPrompt, formalPrompt]) {
      expect(prompt).toContain('同一套质量标准');
      expect(prompt).toContain('guide、annotations、afterReading');
      expect(prompt).toContain(`"promptVersion":"${TAILORING_PROMPT_VERSION}"`);
      expect(prompt).toContain('"profiles"');
      expect(prompt).toContain('"strategy"');
      expect(prompt).toContain('"adjacentContext"');
      expect(prompt).toContain('"originalNotes"');
      expect(prompt).toContain('"structuredHtml"');
    }
    expect(trialPrompt).toContain('"generationScope":"trial"');
    expect(formalPrompt).toContain('"generationScope":"formal"');
  });
});

describe('input validation', () => {
  it('requires trial source and fragment ranges to match exactly', () => {
    const input = trialInput();
    input.fragmentRange.start.offset = 3;
    expectTailoringError(() => validateGenerationInput(input), 'invalid_scope');
  });

  it('requires trial to reference an approved strategy draft at runtime', () => {
    const input = trialInput() as unknown as Record<string, unknown>;
    input.strategy = {
      kind: 'strategy',
      version: 'strategy-1',
      status: 'active',
      value: {},
    };
    expectTailoringError(
      () => validateGenerationInput(input as unknown as TailoringGenerationInput),
      'invalid_strategy_reference',
    );
  });

  it('requires formal generation to reference an active formal strategy at runtime', () => {
    const input = formalInput() as unknown as Record<string, unknown>;
    input.strategy = {
      kind: 'strategy_draft',
      version: 'draft-1',
      status: 'approved_for_trial',
      value: {},
    };
    expectTailoringError(
      () => validateGenerationInput(input as unknown as TailoringGenerationInput),
      'invalid_strategy_reference',
    );
  });

  it('requires formal source to cover the full node', () => {
    const input = formalInput();
    input.source.range.start.offset = 1;
    expectTailoringError(() => validateGenerationInput(input), 'invalid_scope');
  });

  it('rejects invalid UTF-16 offsets and unordered ranges', () => {
    const pastEnd = trialInput();
    pastEnd.source.range.start.offset = 99;
    pastEnd.fragmentRange.start.offset = 99;
    expectTailoringError(() => validateGenerationInput(pastEnd), 'invalid_input');

    const unordered = trialInput();
    unordered.source.range.start = { blockIndex: 3, offset: 5 };
    unordered.fragmentRange.start = { blockIndex: 3, offset: 5 };
    expectTailoringError(() => validateGenerationInput(unordered), 'invalid_input');
  });

  it('requires an ordered continuous source block range', () => {
    const input = trialInput();
    input.source.blocks[1] = {
      blockIndex: 4,
      kind: 'p',
      text: 'gap',
      utf16Length: 3,
      html: '<p>gap</p>',
    };
    input.source.range.end.blockIndex = 4;
    input.fragmentRange.end.blockIndex = 4;
    expectTailoringError(() => validateGenerationInput(input), 'invalid_input');
  });

  it('requires the source range to cover every supplied block', () => {
    const input = trialInput();
    input.source.range.end.blockIndex = 2;
    input.source.range.end.offset = input.source.blocks[0]?.text.length ?? 0;
    input.fragmentRange = structuredClone(input.source.range);
    expectTailoringError(() => validateGenerationInput(input), 'invalid_input');
  });
});

describe('parseTailoringModelResponse', () => {
  it('accepts the fixed JSON shape, including a JSON code fence', () => {
    const result = parseTailoringModelResponse(
      '```json\n{"guide":"**Read first**","annotations":[],"afterReading":"Reflect."}\n```',
      formalInput(),
    );
    expect(result).toEqual({
      guide: '**Read first**',
      annotations: [],
      afterReading: 'Reflect.',
    });
  });

  it('rejects malformed JSON, missing fields, extra fields, and invalid annotations', () => {
    const input = formalInput();
    expectTailoringError(() => parseTailoringModelResponse('{bad', input), 'invalid_model_json');
    expectTailoringError(
      () => parseTailoringModelResponse('{"guide":null,"annotations":[]}', input),
      'invalid_model_output',
    );
    expectTailoringError(
      () =>
        parseTailoringModelResponse(
          '{"guide":null,"annotations":[],"afterReading":null,"extra":true}',
          input,
        ),
      'invalid_model_output',
    );
    expectTailoringError(
      () =>
        parseTailoringModelResponse(
          '{"guide":null,"annotations":[{"blockIndex":2,"quote":"语言"}],"afterReading":null}',
          input,
        ),
      'invalid_model_output',
    );
  });

  it('resolves an exact unique quote to UTF-16 offsets', () => {
    const result = parseTailoringModelResponse(
      JSON.stringify({
        guide: null,
        annotations: [{ blockIndex: 2, quote: '语言', content: 'The key term.' }],
        afterReading: null,
      }),
      formalInput(),
    );

    expect(result.annotations).toEqual([
      {
        range: {
          start: { blockIndex: 2, offset: 3 },
          end: { blockIndex: 2, offset: 5 },
        },
        content: 'The key term.',
      },
    ]);
  });

  it('uses exact matching without trimming or normalization', () => {
    expectTailoringError(
      () =>
        parseTailoringModelResponse(
          JSON.stringify({
            guide: null,
            annotations: [{ blockIndex: 2, quote: ' 语言', content: 'No fuzzy match.' }],
            afterReading: null,
          }),
          formalInput(),
        ),
      'invalid_anchor',
    );
  });

  it('rejects a missing, ambiguous, or out-of-source quote', () => {
    const missing = formalInput();
    expectTailoringError(
      () =>
        parseTailoringModelResponse(
          JSON.stringify({
            guide: null,
            annotations: [{ blockIndex: 2, quote: '不存在', content: 'Bad.' }],
            afterReading: null,
          }),
          missing,
        ),
      'invalid_anchor',
    );

    const ambiguous = formalInput();
    ambiguous.source.blocks[1] = {
      blockIndex: 2,
      kind: 'p',
      text: '语言与语言',
      utf16Length: 5,
      html: '<p>语言与语言</p>',
    };
    expectTailoringError(
      () =>
        parseTailoringModelResponse(
          JSON.stringify({
            guide: null,
            annotations: [{ blockIndex: 2, quote: '语言', content: 'Ambiguous.' }],
            afterReading: null,
          }),
          ambiguous,
        ),
      'invalid_anchor',
    );

    expectTailoringError(
      () =>
        parseTailoringModelResponse(
          JSON.stringify({
            guide: null,
            annotations: [{ blockIndex: 99, quote: '语言', content: 'Wrong block.' }],
            afterReading: null,
          }),
          formalInput(),
        ),
      'invalid_anchor',
    );
  });

  it('rejects a trial annotation outside a partial first or last block', () => {
    const input = trialInput();
    expectTailoringError(
      () =>
        parseTailoringModelResponse(
          JSON.stringify({
            guide: null,
            annotations: [{ blockIndex: 2, quote: '甲', content: 'Before fragment.' }],
            afterReading: null,
          }),
          input,
        ),
      'invalid_anchor',
    );
    expectTailoringError(
      () =>
        parseTailoringModelResponse(
          JSON.stringify({
            guide: null,
            annotations: [{ blockIndex: 3, quote: '文字', content: 'Past fragment.' }],
            afterReading: null,
          }),
          input,
        ),
      'invalid_anchor',
    );
  });

  it('rejects an all-empty trial result but accepts it for formal reading', () => {
    const empty = '{"guide":null,"annotations":[],"afterReading":null}';
    expectTailoringError(
      () => parseTailoringModelResponse(empty, trialInput()),
      'empty_trial_result',
    );
    expect(parseTailoringModelResponse(empty, formalInput())).toEqual({
      guide: null,
      annotations: [],
      afterReading: null,
    });
  });
});

describe('createTailoringCacheKey', () => {
  it('is deterministic across object key insertion order', () => {
    const first = trialInput();
    const second = trialInput();
    second.profiles.book.value = { z: 1, a: { d: 4, c: 3 } };
    first.profiles.book.value = { a: { c: 3, d: 4 }, z: 1 };

    expect(createTailoringCacheKey(first)).toBe(createTailoringCacheKey(second));
    expect(createTailoringCacheKey(first)).toMatch(
      new RegExp(`^tailoring:${TAILORING_PROMPT_VERSION}:[a-f0-9]{64}$`),
    );
  });

  it.each([
    ['user', (input: TrialGenerationInput) => (input.userId = 'user-2')],
    ['package id', (input: TrialGenerationInput) => (input.packageId = 'package-2')],
    ['package version', (input: TrialGenerationInput) => (input.packageVersion = 'package-v4')],
    ['book profile', (input: TrialGenerationInput) => (input.profiles.book.version = 'book-profile-2')],
    ['reader profile', (input: TrialGenerationInput) => (input.profiles.reader.version = 'reader-profile-3')],
    [
      'book-reader profile',
      (input: TrialGenerationInput) => (input.profiles.bookReader.version = 'book-reader-profile-5'),
    ],
    ['strategy', (input: TrialGenerationInput) => (input.strategy.version = 'draft-6')],
    [
      'scope range',
      (input: TrialGenerationInput) => {
        input.source.range.end.offset = 3;
        input.fragmentRange.end.offset = 3;
      },
    ],
    ['model id', (input: TrialGenerationInput) => (input.model.modelId = 'model-b')],
    [
      'model config',
      (input: TrialGenerationInput) => (input.model.configVersion = 'temperature-0-v2'),
    ],
    [
      'prompt source',
      (input: TrialGenerationInput) => (input.source.previousContext = 'different context'),
    ],
  ])('changes when %s changes', (_, mutate) => {
    const original = trialInput();
    const changed = trialInput();
    mutate(changed);
    expect(createTailoringCacheKey(changed)).not.toBe(createTailoringCacheKey(original));
  });

  it('isolates trial and formal namespaces', () => {
    expect(createTailoringCacheKey(trialInput())).not.toBe(createTailoringCacheKey(formalInput()));
  });
});
