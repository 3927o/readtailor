import { describe, expect, it } from 'vitest';
import {
  ProfileError,
  mapProfileOnboarding,
  validateProfileOnboardingInput,
} from './profiles';

const validInput = {
  knowledgeOptionIds: ['computing_internet'],
  explanationOptionIds: ['plain_then_precise'],
  backgroundDepthOptionId: 'context_without_digression',
};

describe('profile onboarding mapping', () => {
  it('maps the fixed PRD options to a deterministic reader profile', () => {
    expect(mapProfileOnboarding(validInput)).toEqual({
      summary:
        '用户熟悉计算机与互联网。解释陌生概念时，适合先用通俗表述，再引入准确术语。阅读陌生领域时，适当补充必要背景，但避免过度偏离原书。',
      knowledge: ['熟悉计算机与互联网'],
      explanationPreferences: [
        '解释陌生概念时，优先使用通俗表述，再引入准确术语',
        '阅读陌生领域时，适当补充必要背景，但避免过度偏离原书',
      ],
    });
  });

  it('keeps mapping stable regardless of submitted option order', () => {
    const first = mapProfileOnboarding({
      knowledgeOptionIds: ['computing_internet', 'literature_arts'],
      explanationOptionIds: ['examples_analogies', 'plain_then_precise'],
      backgroundDepthOptionId: 'essential_only',
    });
    const second = mapProfileOnboarding({
      knowledgeOptionIds: ['literature_arts', 'computing_internet'],
      explanationOptionIds: ['plain_then_precise', 'examples_analogies'],
      backgroundDepthOptionId: 'essential_only',
    });
    expect(first).toEqual(second);
  });

  it('represents the mutually exclusive neutral options without fabricated knowledge', () => {
    expect(
      mapProfileOnboarding({
        knowledgeOptionIds: ['none'],
        explanationOptionIds: ['adaptive'],
        backgroundDepthOptionId: 'adaptive',
      }),
    ).toEqual({
      summary:
        '用户目前没有特别熟悉的领域。解释陌生概念时，适合根据内容选择合适的说明方式。阅读陌生领域时，根据内容决定背景补充深度。',
      knowledge: [],
      explanationPreferences: [
        '解释陌生概念时，根据内容选择合适的说明方式',
        '阅读陌生领域时，根据内容决定背景补充深度',
      ],
    });
  });

  it('normalizes option order and optional free text for idempotency comparison', () => {
    expect(
      validateProfileOnboardingInput({
        knowledgeOptionIds: ['computing_internet', 'literature_arts'],
        knowledgeFreeText: '  机器学习  ',
        explanationOptionIds: ['examples_analogies'],
        explanationFreeText: '   ',
        backgroundDepthOptionId: 'systematic_foundations',
      }),
    ).toEqual({
      knowledgeOptionIds: ['literature_arts', 'computing_internet'],
      knowledgeFreeText: '机器学习',
      explanationOptionIds: ['examples_analogies'],
      explanationFreeText: null,
      backgroundDepthOptionId: 'systematic_foundations',
    });
  });
});

describe('profile onboarding validation', () => {
  it.each([
    [{ ...validInput, knowledgeOptionIds: [] }, '知识背景至少选择一项'],
    [
      {
        ...validInput,
        knowledgeOptionIds: [
          'literature_arts',
          'history_philosophy_social_sciences',
          'business_economics_management',
          'computing_internet',
        ],
      },
      '知识背景最多选择 3 项',
    ],
    [
      { ...validInput, knowledgeOptionIds: ['none', 'computing_internet'] },
      '“没有特别熟悉的领域”不能与其他知识背景同时选择',
    ],
    [
      { ...validInput, explanationOptionIds: ['adaptive', 'examples_analogies'] },
      '“没有固定偏好”不能与其他解释方式同时选择',
    ],
    [
      { ...validInput, explanationOptionIds: ['plain_then_precise', 'plain_then_precise'] },
      '解释方式不能包含重复选项',
    ],
    [{ ...validInput, knowledgeOptionIds: ['unknown'] }, '知识背景包含未知选项'],
    [{ ...validInput, backgroundDepthOptionId: 'unknown' }, '背景补充深度包含未知选项'],
    [{ ...validInput, knowledgeFreeText: 'x'.repeat(501) }, '知识背景补充不能超过 500 个字符'],
  ])('rejects invalid answers', (input, message) => {
    expect(() => validateProfileOnboardingInput(input)).toThrowError(
      expect.objectContaining<Partial<ProfileError>>({ message, statusCode: 400 }),
    );
  });
});
