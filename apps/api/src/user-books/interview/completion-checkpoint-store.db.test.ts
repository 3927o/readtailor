import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type {
  BookReaderProfile,
  ProposedStrategy,
  ReaderProfilePatch,
  ReadingBriefing,
  ReadingStrategy,
} from '@readtailor/agent-kit';
import {
  interviewMessages,
  interviewSessions,
} from '@readtailor/database';
import {
  getTestDatabase,
  hasTestDatabase,
  interviewingGraph,
} from '../../test/database';
import {
  createInterviewCompletionStore,
  type InterviewCompletionClaim,
} from './completion-checkpoint-store';

const describePostgres = hasTestDatabase ? describe : describe.skip;
const skipReason = hasTestDatabase ? '' : ' (skipped: TEST_DATABASE_URL is not set)';

const briefing: ReadingBriefing = {
  book_identity: '这是一本围绕核心概念展开的测试书籍。',
  arc: '全书从基础概念逐步推进到实际应用。',
  assumed_knowledge: '读者只需要具备一般背景知识即可开始。',
  reading_advice: '先把握章节主线，再处理局部术语和细节。',
};

const strategy: ProposedStrategy = {
  goals: ['理解核心概念'],
  expression_principles: ['保持简洁'],
  guide: { enabled: true, objectives: ['建立阅读方向'] },
  annotations: { enabled: true, focuses: ['关键术语'], exclusions: [] },
  after_reading: { enabled: true, objectives: ['回顾要点'] },
};

const candidates: ReadingStrategy['trial_candidates'] = [1, 2, 3].map((ordinal) => ({
  section_id: `section-${ordinal}`,
  segment: 1,
  reason: `候选片段 ${ordinal}`,
}));

const bookReaderProfile: BookReaderProfile = {
  summary: '用户希望建立全书主线并理解关键概念。',
  motivations: ['完成阅读'],
  prior_knowledge: ['了解基础背景'],
  reading_goals: ['理解核心论点'],
  likely_barriers: ['术语密度较高'],
};

const readerProfilePatch: ReaderProfilePatch = {
  knowledge: ['掌握本书核心概念'],
};

async function completingGraph(): Promise<{
  interviewSessionId: string;
  claim: InterviewCompletionClaim;
}> {
  const { db } = getTestDatabase();
  const graph = await interviewingGraph(db);
  const leaseId = randomUUID();
  await db.insert(interviewMessages).values({
    interviewSessionId: graph.interviewSessionId,
    sequence: 2,
    role: 'user',
    kind: 'answer',
    content: '我希望理解全书主线。',
    payload: {},
  });
  await db
    .update(interviewSessions)
    .set({
      conversationVersion: 2,
      turnLeaseId: leaseId,
      turnLeaseVersion: 2,
      turnLeaseClaimedAt: sql`now()`,
      turnLeaseExpiresAt: sql`now() + interval '6 minutes'`,
    })
    .where(eq(interviewSessions.id, graph.interviewSessionId));
  return {
    interviewSessionId: graph.interviewSessionId,
    claim: {
      sessionId: graph.interviewSessionId,
      leaseId,
      conversationVersion: 2,
    },
  };
}

describePostgres(`interview completion checkpoint store${skipReason}`, () => {
  it('persists ordered checkpoints without advancing conversationVersion', async () => {
    const { db } = getTestDatabase();
    const graph = await completingGraph();
    const store = createInterviewCompletionStore({ db, claim: graph.claim });

    const [firstStart, replayedStart] = await Promise.all([store.start(), store.start()]);
    expect(firstStart.completionId).toBe(replayedStart.completionId);
    expect(firstStart.briefing).toBeUndefined();

    await expect(store.complete()).rejects.toMatchObject({ code: 'incomplete' });
    await expect(store.submitStrategy({ publicStrategy: '测试阅读策略', strategy }))
      .rejects.toMatchObject({ code: 'out_of_order' });

    expect(await store.submitBriefing(briefing)).toMatchObject({ briefing });
    expect(await store.submitStrategy({ publicStrategy: '测试阅读策略', strategy }))
      .toMatchObject({ strategy: { publicStrategy: '测试阅读策略', strategy } });
    const rejectingStore = createInterviewCompletionStore({
      db,
      claim: graph.claim,
      validateCandidates() {
        throw new Error('candidate is outside the manifest pool');
      },
    });
    await expect(rejectingStore.submitCandidates(candidates))
      .rejects.toThrow('candidate is outside the manifest pool');
    expect((await db
      .select()
      .from(interviewMessages)
      .where(eq(interviewMessages.interviewSessionId, graph.interviewSessionId)))
      .filter((message) => message.kind === 'summary')).toHaveLength(3);
    expect(await store.submitCandidates(candidates)).toMatchObject({ candidates });
    expect(await store.submitProfile({ bookReaderProfile, readerProfilePatch }))
      .toMatchObject({ profile: { bookReaderProfile, readerProfilePatch } });

    const completed = await store.complete();
    expect(completed).toEqual({
      briefing,
      strategy: { publicStrategy: '测试阅读策略', strategy },
      candidates,
      profile: { bookReaderProfile, readerProfilePatch },
    });
    expect(await store.load()).toMatchObject({
      completionId: firstStart.completionId,
      baseConversationVersion: 2,
      briefing,
      candidates,
    });

    const [session] = await db
      .select()
      .from(interviewSessions)
      .where(eq(interviewSessions.id, graph.interviewSessionId));
    const messages = await db
      .select()
      .from(interviewMessages)
      .where(eq(interviewMessages.interviewSessionId, graph.interviewSessionId));
    const checkpoints = messages.filter((message) => message.kind === 'summary');
    expect(session).toMatchObject({ status: 'active', conversationVersion: 2 });
    expect(checkpoints.map((message) => message.sequence)).toEqual([3, 4, 5, 6, 7]);
    expect(checkpoints.map((message) => message.payload.type)).toEqual([
      'completion_started',
      'briefing_submitted',
      'strategy_submitted',
      'trial_candidates_submitted',
      'interview_profile_submitted',
    ]);
  });

  it('treats equal stage submissions as idempotent and rejects different results', async () => {
    const { db } = getTestDatabase();
    const graph = await completingGraph();
    const store = createInterviewCompletionStore({ db, claim: graph.claim });
    await store.start();
    const first = await store.submitBriefing(briefing);

    expect(await store.submitBriefing({ ...briefing })).toEqual(first);
    await expect(store.submitBriefing({
      ...briefing,
      arc: '这是另一个不同但仍然有效的全书推进说明。',
    })).rejects.toMatchObject({ code: 'conflict' });

    const messages = await db
      .select()
      .from(interviewMessages)
      .where(eq(interviewMessages.interviewSessionId, graph.interviewSessionId));
    expect(messages.filter((message) => message.kind === 'summary')).toHaveLength(2);
  });

  it('fences replaced and expired leases from loading or appending checkpoints', async () => {
    const { db } = getTestDatabase();
    const graph = await completingGraph();
    const staleStore = createInterviewCompletionStore({ db, claim: graph.claim });
    await staleStore.start();

    const replacementLeaseId = randomUUID();
    await db
      .update(interviewSessions)
      .set({ turnLeaseId: replacementLeaseId })
      .where(eq(interviewSessions.id, graph.interviewSessionId));
    await expect(staleStore.load()).rejects.toMatchObject({ code: 'lease_lost' });
    await expect(staleStore.submitBriefing(briefing)).rejects.toMatchObject({ code: 'lease_lost' });

    const replacementStore = createInterviewCompletionStore({
      db,
      claim: { ...graph.claim, leaseId: replacementLeaseId },
    });
    const replacementSnapshot = await replacementStore.load();
    expect(replacementSnapshot).toMatchObject({
      completionId: expect.any(String),
    });
    expect(replacementSnapshot.briefing).toBeUndefined();

    await db
      .update(interviewSessions)
      .set({
        turnLeaseClaimedAt: sql`now() - interval '2 minutes'`,
        turnLeaseExpiresAt: sql`now() - interval '1 minute'`,
      })
      .where(eq(interviewSessions.id, graph.interviewSessionId));
    await expect(replacementStore.load()).rejects.toMatchObject({ code: 'lease_lost' });
    await expect(replacementStore.complete()).rejects.toMatchObject({ code: 'lease_lost' });
  });
});
