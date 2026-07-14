import { and, eq, isNull } from 'drizzle-orm';
import type {
  ReaderProfile,
  ReaderProfileOnboardingRequest,
  ReaderProfileResponse,
} from '@readtailor/contracts';
import {
  readerProfileOnboardings,
  readerProfiles,
  readerProfileVersions,
  users,
  type Database,
} from '@readtailor/database';
import { bindPresetBooks } from './preset-books';

export const PROFILE_ONBOARDING_SCHEMA_VERSION = 'reader-profile-onboarding-1.0';
export const PROFILE_MAPPING_VERSION = 'reader-profile-mapping-1.0';

export const KNOWLEDGE_OPTION_IDS = [
  'literature_arts',
  'history_philosophy_social_sciences',
  'business_economics_management',
  'math_science_engineering',
  'computing_internet',
  'none',
] as const;

export const EXPLANATION_OPTION_IDS = [
  'plain_then_precise',
  'examples_analogies',
  'definitions_logic',
  'concise_then_expand',
  'adaptive',
] as const;

export const BACKGROUND_DEPTH_OPTION_IDS = [
  'essential_only',
  'context_without_digression',
  'systematic_foundations',
  'adaptive',
] as const;

type KnowledgeOptionId = (typeof KNOWLEDGE_OPTION_IDS)[number];
type ExplanationOptionId = (typeof EXPLANATION_OPTION_IDS)[number];
type BackgroundDepthOptionId = (typeof BACKGROUND_DEPTH_OPTION_IDS)[number];

export interface NormalizedProfileOnboardingInput {
  knowledgeOptionIds: KnowledgeOptionId[];
  knowledgeFreeText: string | null;
  explanationOptionIds: ExplanationOptionId[];
  explanationFreeText: string | null;
  backgroundDepthOptionId: BackgroundDepthOptionId;
}

const KNOWLEDGE_MAPPING: Record<Exclude<KnowledgeOptionId, 'none'>, string> = {
  literature_arts: '熟悉文学与艺术',
  history_philosophy_social_sciences: '熟悉历史、哲学与社会科学',
  business_economics_management: '熟悉商业、经济与管理',
  math_science_engineering: '熟悉数学、自然科学与工程',
  computing_internet: '熟悉计算机与互联网',
};

const EXPLANATION_MAPPING: Record<ExplanationOptionId, string> = {
  plain_then_precise: '解释陌生概念时，优先使用通俗表述，再引入准确术语',
  examples_analogies: '解释陌生概念时，多使用具体例子或类比',
  definitions_logic: '解释陌生概念时，从定义和逻辑关系逐步推导',
  concise_then_expand: '解释陌生概念时，先给出简洁结论，需要时再展开',
  adaptive: '解释陌生概念时，根据内容选择合适的说明方式',
};

const BACKGROUND_DEPTH_MAPPING: Record<BackgroundDepthOptionId, string> = {
  essential_only: '阅读陌生领域时，只补充理解当前内容必需的信息',
  context_without_digression: '阅读陌生领域时，适当补充必要背景，但避免过度偏离原书',
  systematic_foundations: '阅读陌生领域时，尽量系统地补齐相关基础',
  adaptive: '阅读陌生领域时，根据内容决定背景补充深度',
};

const KNOWLEDGE_SUMMARY: Record<Exclude<KnowledgeOptionId, 'none'>, string> = {
  literature_arts: '文学与艺术',
  history_philosophy_social_sciences: '历史、哲学与社会科学',
  business_economics_management: '商业、经济与管理',
  math_science_engineering: '数学、自然科学与工程',
  computing_internet: '计算机与互联网',
};

const EXPLANATION_SUMMARY: Record<ExplanationOptionId, string> = {
  plain_then_precise: '先用通俗表述，再引入准确术语',
  examples_analogies: '多使用具体例子或类比',
  definitions_logic: '从定义和逻辑关系逐步推导',
  concise_then_expand: '先给出简洁结论，需要时再展开',
  adaptive: '根据内容选择合适的说明方式',
};

const BACKGROUND_DEPTH_SUMMARY: Record<BackgroundDepthOptionId, string> = {
  essential_only: '只补充理解当前内容必需的信息',
  context_without_digression: '适当补充必要背景，但避免过度偏离原书',
  systematic_foundations: '尽量系统地补齐相关基础',
  adaptive: '根据内容决定背景补充深度',
};

export class ProfileError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 404 | 409 | 503,
  ) {
    super(message);
    this.name = 'ProfileError';
  }
}

function normalizeFreeText(value: string | undefined, fieldName: string): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string') throw new ProfileError(`${fieldName}格式不正确`, 400);
  const normalized = value.trim();
  if (normalized.length > 500) throw new ProfileError(`${fieldName}不能超过 500 个字符`, 400);
  return normalized || null;
}

function normalizeOptionIds<T extends string>(
  value: string[],
  allowed: readonly T[],
  fieldName: string,
  maxItems: number,
): T[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ProfileError(`${fieldName}至少选择一项`, 400);
  }
  if (value.length > maxItems) {
    throw new ProfileError(`${fieldName}最多选择 ${maxItems} 项`, 400);
  }
  if (new Set(value).size !== value.length) {
    throw new ProfileError(`${fieldName}不能包含重复选项`, 400);
  }
  const allowedSet = new Set<string>(allowed);
  if (value.some((optionId) => typeof optionId !== 'string' || !allowedSet.has(optionId))) {
    throw new ProfileError(`${fieldName}包含未知选项`, 400);
  }
  const selected = new Set(value);
  return allowed.filter((optionId) => selected.has(optionId));
}

export function validateProfileOnboardingInput(
  input: ReaderProfileOnboardingRequest,
): NormalizedProfileOnboardingInput {
  if (!input || typeof input !== 'object') throw new ProfileError('画像问卷格式不正确', 400);

  const knowledgeOptionIds = normalizeOptionIds(
    input.knowledgeOptionIds,
    KNOWLEDGE_OPTION_IDS,
    '知识背景',
    3,
  );
  if (knowledgeOptionIds.includes('none') && knowledgeOptionIds.length !== 1) {
    throw new ProfileError('“没有特别熟悉的领域”不能与其他知识背景同时选择', 400);
  }

  const explanationOptionIds = normalizeOptionIds(
    input.explanationOptionIds,
    EXPLANATION_OPTION_IDS,
    '解释方式',
    2,
  );
  if (explanationOptionIds.includes('adaptive') && explanationOptionIds.length !== 1) {
    throw new ProfileError('“没有固定偏好”不能与其他解释方式同时选择', 400);
  }

  if (
    typeof input.backgroundDepthOptionId !== 'string' ||
    !BACKGROUND_DEPTH_OPTION_IDS.includes(
      input.backgroundDepthOptionId as BackgroundDepthOptionId,
    )
  ) {
    throw new ProfileError('背景补充深度包含未知选项', 400);
  }

  return {
    knowledgeOptionIds,
    knowledgeFreeText: normalizeFreeText(input.knowledgeFreeText, '知识背景补充'),
    explanationOptionIds,
    explanationFreeText: normalizeFreeText(input.explanationFreeText, '解释方式补充'),
    backgroundDepthOptionId: input.backgroundDepthOptionId as BackgroundDepthOptionId,
  };
}

export function mapProfileOnboarding(input: ReaderProfileOnboardingRequest): ReaderProfile {
  const normalized = validateProfileOnboardingInput(input);
  const hasNoKnowledge = normalized.knowledgeOptionIds.includes('none');
  const knowledgeIds = normalized.knowledgeOptionIds.filter(
    (optionId): optionId is Exclude<KnowledgeOptionId, 'none'> => optionId !== 'none',
  );
  const knowledge = knowledgeIds.map((optionId) => KNOWLEDGE_MAPPING[optionId]);
  const explanationPreferences = [
    ...normalized.explanationOptionIds.map((optionId) => EXPLANATION_MAPPING[optionId]),
    BACKGROUND_DEPTH_MAPPING[normalized.backgroundDepthOptionId],
  ];

  const knowledgeSummary = hasNoKnowledge
    ? '用户目前没有特别熟悉的领域。'
    : `用户熟悉${knowledgeIds.map((optionId) => KNOWLEDGE_SUMMARY[optionId]).join('、')}。`;
  const explanationSummary = `解释陌生概念时，适合${normalized.explanationOptionIds
    .map((optionId) => EXPLANATION_SUMMARY[optionId])
    .join('，并')}。`;
  const backgroundSummary = `阅读陌生领域时，${BACKGROUND_DEPTH_SUMMARY[normalized.backgroundDepthOptionId]}。`;

  return {
    summary: `${knowledgeSummary}${explanationSummary}${backgroundSummary}`,
    knowledge,
    explanationPreferences,
  };
}

function sameOnboarding(
  existing: typeof readerProfileOnboardings.$inferSelect,
  submitted: NormalizedProfileOnboardingInput,
): boolean {
  try {
    const normalizedExisting = validateProfileOnboardingInput({
      knowledgeOptionIds: existing.knowledgeOptionIds,
      ...(existing.knowledgeFreeText === null
        ? {}
        : { knowledgeFreeText: existing.knowledgeFreeText }),
      explanationOptionIds: existing.explanationOptionIds,
      ...(existing.explanationFreeText === null
        ? {}
        : { explanationFreeText: existing.explanationFreeText }),
      backgroundDepthOptionId: existing.backgroundDepthOptionId,
    });
    return JSON.stringify(normalizedExisting) === JSON.stringify(submitted);
  } catch {
    return false;
  }
}

export function createProfileService(options: { db: Database }) {
  return {
    async get(userId: string): Promise<ReaderProfileResponse> {
      const [user] = await options.db
        .select({ completedAt: users.readerProfileCompletedAt })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (!user) throw new ProfileError('用户不存在', 404);

      const [current] = await options.db
        .select({ profile: readerProfileVersions.profile })
        .from(readerProfiles)
        .innerJoin(
          readerProfileVersions,
          eq(readerProfileVersions.id, readerProfiles.currentVersionId),
        )
        .where(eq(readerProfiles.userId, userId))
        .limit(1);

      if (!user.completedAt && !current) return { completed: false, profile: null };
      if (!user.completedAt || !current) throw new ProfileError('用户画像状态不一致', 503);
      return { completed: true, profile: current.profile };
    },

    async completeOnboarding(
      userId: string,
      input: ReaderProfileOnboardingRequest,
    ): Promise<ReaderProfileResponse> {
      const normalized = validateProfileOnboardingInput(input);
      const generatedProfile = mapProfileOnboarding(input);

      return options.db.transaction(async (tx) => {
        const [user] = await tx
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.id, userId), isNull(users.disabledAt)))
          .limit(1)
          .for('update');
        if (!user) throw new ProfileError('用户不存在或已停用', 404);

        const [existingOnboarding] = await tx
          .select()
          .from(readerProfileOnboardings)
          .where(eq(readerProfileOnboardings.userId, userId))
          .limit(1);

        if (existingOnboarding) {
          if (!sameOnboarding(existingOnboarding, normalized)) {
            throw new ProfileError('初始阅读画像已经完成，不能提交不同答案', 409);
          }
          const [existingVersion] = await tx
            .select({ profile: readerProfileVersions.profile })
            .from(readerProfiles)
            .innerJoin(
              readerProfileVersions,
              eq(readerProfileVersions.id, readerProfiles.currentVersionId),
            )
            .where(eq(readerProfiles.userId, userId))
            .limit(1);
          if (!existingVersion) throw new ProfileError('用户画像状态不一致', 503);
          return { completed: true, profile: existingVersion.profile };
        }

        await tx.insert(readerProfileOnboardings).values({
          userId,
          schemaVersion: PROFILE_ONBOARDING_SCHEMA_VERSION,
          mappingVersion: PROFILE_MAPPING_VERSION,
          knowledgeOptionIds: normalized.knowledgeOptionIds,
          knowledgeFreeText: normalized.knowledgeFreeText,
          explanationOptionIds: normalized.explanationOptionIds,
          explanationFreeText: normalized.explanationFreeText,
          backgroundDepthOptionId: normalized.backgroundDepthOptionId,
          extractionStatus: 'not_requested',
        });

        await tx
          .insert(readerProfiles)
          .values({ userId })
          .onConflictDoNothing({ target: readerProfiles.userId });
        const [profile] = await tx
          .select({ id: readerProfiles.id, currentVersionId: readerProfiles.currentVersionId })
          .from(readerProfiles)
          .where(eq(readerProfiles.userId, userId))
          .limit(1);
        if (!profile) throw new ProfileError('长期画像初始化失败', 503);
        if (profile.currentVersionId) throw new ProfileError('初始阅读画像已经存在', 409);

        const [version] = await tx
          .insert(readerProfileVersions)
          .values({
            readerProfileId: profile.id,
            version: 1,
            profile: generatedProfile,
            changeSource: 'onboarding',
          })
          .returning({ id: readerProfileVersions.id });
        if (!version) throw new ProfileError('长期画像版本创建失败', 503);

        const completedAt = new Date();
        await tx
          .update(readerProfiles)
          .set({ currentVersionId: version.id, updatedAt: completedAt })
          .where(eq(readerProfiles.id, profile.id));
        await tx
          .update(users)
          .set({ readerProfileCompletedAt: completedAt, updatedAt: completedAt })
          .where(eq(users.id, userId));

        // §5.2「完成后把所有预置书籍加入用户书架」— stock the shelf in the same transaction so the
        // profile and its preset books commit atomically. Idempotent: a replay short-circuits above
        // (existingOnboarding), and a rare concurrent double-submit is caught by the on-conflict guard
        // inside bindPresetBooks, so「预置书籍只加入一次」holds (PRD §19.1).
        await bindPresetBooks(tx, userId);

        return { completed: true, profile: generatedProfile };
      });
    },
  };
}

export type ProfileService = ReturnType<typeof createProfileService>;
