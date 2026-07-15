import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { BookReaderProfile, Briefing, Strategy } from '@readtailor/contracts';
import {
  bookPackages,
  bookReaderProfileVersions,
  interviewMessages,
  interviewSessions,
  nodeGenerations,
  sharedBooks,
  strategyDraftVersions,
  trialRevisions,
  trialSegments,
  userBooks,
  users,
} from '@readtailor/database';
import type { Database } from '@readtailor/database';

const profile: BookReaderProfile = {
  purpose: '理解本书的核心论点',
  existingKnowledge: ['了解基础背景'],
  desiredDepthOrOutcome: '能够复述并应用关键概念',
  likelyObstacles: ['术语密度较高'],
  expectedCommitment: '每天阅读三十分钟',
  otherConclusions: [],
};

const briefing: Briefing = {
  bookIdentity: '一本用于数据库集成测试的书',
  arc: '从基础概念推进到实际应用',
  assumedKnowledge: '不要求额外前置知识',
  readingAdvice: '先理解结构，再关注细节',
};

const strategy: Strategy = {
  goals: ['理解核心概念'],
  expressionPrinciples: ['保持简洁'],
  guide: { enabled: true, objectives: ['建立阅读方向'] },
  annotations: { enabled: true, focuses: ['关键术语'], exclusions: [] },
  afterReading: { enabled: true, objectives: ['回顾要点'] },
  trialCandidates: [1, 2, 3].map((segment) => ({
    sectionId: `section-${segment}`,
    segment: 1,
    reason: `候选片段 ${segment}`,
  })),
};

export interface OnShelfGraph {
  userId: string;
  sharedBookId: string;
  packageId: string;
  userBookId: string;
}

export interface InterviewingGraph extends OnShelfGraph {
  interviewSessionId: string;
  questionMessageId: string;
}

export interface StrategyReviewGraph extends OnShelfGraph {
  interviewSessionId: string;
  bookReaderProfileVersionId: string;
  strategyDraftVersionId: string;
}

export interface TrialReviewGraph extends StrategyReviewGraph {
  trialRevisionId: string;
  trialSegmentIds: string[];
  nodeGenerationIds: string[];
}

export async function onShelfGraph(db: Database): Promise<OnShelfGraph> {
  const userId = randomUUID();
  const sharedBookId = randomUUID();
  const packageId = randomUUID();
  const userBookId = randomUUID();
  const uniqueHash = createHash('sha256').update(sharedBookId).digest('hex');

  await db.insert(users).values({ id: userId, displayName: '数据库测试读者' });
  await db.insert(sharedBooks).values({
    id: sharedBookId,
    epubSha256: uniqueHash,
    status: 'analyzing',
    title: '数据库测试书籍',
    authors: ['测试作者'],
    language: 'zh',
    identifiers: {},
    sourceFilename: 'database-test.epub',
  });
  await db.insert(bookPackages).values({
    id: packageId,
    sharedBookId,
    version: 'test-v1',
    contractVersion: 'nb-1.0',
    manifestVersion: 'reading-nodes-1.0',
    objectPrefix: `test/${sharedBookId}`,
    fileHashes: {},
    validationSummary: {},
  });
  await db
    .update(sharedBooks)
    .set({ status: 'ready', currentPackageId: packageId })
    .where(eq(sharedBooks.id, sharedBookId));
  await db.insert(userBooks).values({ id: userBookId, userId, sharedBookId });

  return { userId, sharedBookId, packageId, userBookId };
}

export async function interviewingGraph(db: Database): Promise<InterviewingGraph> {
  const graph = await onShelfGraph(db);
  const interviewSessionId = randomUUID();
  const questionMessageId = randomUUID();

  await db.insert(interviewSessions).values({
    id: interviewSessionId,
    userBookId: graph.userBookId,
    status: 'active',
    questionCount: 1,
    conversationVersion: 1,
  });
  await db.insert(interviewMessages).values({
    id: questionMessageId,
    interviewSessionId,
    sequence: 1,
    role: 'assistant',
    kind: 'question',
    content: '你希望通过这本书获得什么？',
    payload: {
      id: 'purpose',
      acknowledgment: '',
      prompt: '你希望通过这本书获得什么？',
      options: [
        { id: 'overview', label: '了解全貌' },
        { id: 'apply', label: '实际应用' },
      ],
      allowFreeText: true,
      profileDimension: 'purpose',
      sufficiency: 20,
    },
  });
  await db
    .update(userBooks)
    .set({ workflowStatus: 'interviewing', currentInterviewSessionId: interviewSessionId })
    .where(eq(userBooks.id, graph.userBookId));

  return { ...graph, interviewSessionId, questionMessageId };
}

export async function strategyReviewGraph(db: Database): Promise<StrategyReviewGraph> {
  const graph = await onShelfGraph(db);
  const interviewSessionId = randomUUID();
  const bookReaderProfileVersionId = randomUUID();
  const strategyDraftVersionId = randomUUID();
  const completedAt = new Date('2026-07-16T00:00:00.000Z');

  await db.insert(interviewSessions).values({
    id: interviewSessionId,
    userBookId: graph.userBookId,
    status: 'completed',
    questionCount: 1,
    conversationVersion: 2,
    completedAt,
  });
  await db.insert(bookReaderProfileVersions).values({
    id: bookReaderProfileVersionId,
    userBookId: graph.userBookId,
    interviewSessionId,
    version: 1,
    profile,
  });
  await db.insert(strategyDraftVersions).values({
    id: strategyDraftVersionId,
    userBookId: graph.userBookId,
    bookReaderProfileVersionId,
    version: 1,
    status: 'draft',
    readingBriefing: briefing,
    userFacingSummary: '测试阅读策略',
    strategy,
  });
  await db
    .update(userBooks)
    .set({
      workflowStatus: 'strategy_review',
      currentInterviewSessionId: interviewSessionId,
      currentBookReaderProfileVersionId: bookReaderProfileVersionId,
      currentStrategyDraftVersionId: strategyDraftVersionId,
    })
    .where(eq(userBooks.id, graph.userBookId));

  return {
    ...graph,
    interviewSessionId,
    bookReaderProfileVersionId,
    strategyDraftVersionId,
  };
}

export async function trialReviewGraph(db: Database): Promise<TrialReviewGraph> {
  const graph = await strategyReviewGraph(db);
  const trialRevisionId = randomUUID();
  const publishedAt = new Date('2026-07-16T00:10:00.000Z');

  await db
    .update(strategyDraftVersions)
    .set({ status: 'approved_for_trial', approvedForTrialAt: publishedAt })
    .where(eq(strategyDraftVersions.id, graph.strategyDraftVersionId));
  await db.insert(trialRevisions).values({
    id: trialRevisionId,
    userBookId: graph.userBookId,
    strategyDraftVersionId: graph.strategyDraftVersionId,
    revision: 1,
    status: 'published',
    publishedAt,
  });

  const segmentRows = [1, 2, 3].map((ordinal) => ({
    id: randomUUID(),
    trialRevisionId,
    ordinal,
    sectionId: `section-${ordinal}`,
    segment: 1,
    startBlockIndex: 1,
    startOffset: 0,
    endBlockIndex: 1,
    endOffset: 10,
    selectionReason: `试读片段 ${ordinal}`,
    status: 'ready' as const,
  }));
  await db.insert(trialSegments).values(segmentRows);

  const generationRows = segmentRows.map((segment) => ({
    id: randomUUID(),
    userBookId: graph.userBookId,
    generationScope: 'trial' as const,
    trialSegmentId: segment.id,
    strategyDraftVersionId: graph.strategyDraftVersionId,
    sectionId: segment.sectionId,
    segment: segment.segment,
    status: 'ready' as const,
    attemptCount: 1,
    result: { guide: '试读导读', annotations: [], afterReading: '试读回顾' },
    modelConfigId: 'database-test-model',
    promptVersion: 'database-test-v1',
    cacheKey: `database-test:${segment.id}`,
    completedAt: publishedAt,
  }));
  await db.insert(nodeGenerations).values(generationRows);
  await db
    .update(userBooks)
    .set({ workflowStatus: 'trial_review', currentTrialRevisionId: trialRevisionId })
    .where(eq(userBooks.id, graph.userBookId));

  return {
    ...graph,
    trialRevisionId,
    trialSegmentIds: segmentRows.map(({ id }) => id),
    nodeGenerationIds: generationRows.map(({ id }) => id),
  };
}
