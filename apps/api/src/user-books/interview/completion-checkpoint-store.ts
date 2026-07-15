import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { eq, sql } from 'drizzle-orm';
import type {
  BookReaderProfile,
  CompletedInterviewArtifacts,
  CompletionSnapshot,
  InterviewCompletionStore,
  ReaderProfilePatch,
  ReadingBriefing,
  ReadingStrategyCore,
  TrialCandidate,
} from '@readtailor/agent-kit';
import {
  interviewMessages,
  interviewSessions,
  userBooks,
  type Database,
} from '@readtailor/database';

export type InterviewCompletionClaim = {
  sessionId: string;
  leaseId: string;
  conversationVersion: number;
};

export type InterviewCompletionCheckpoint =
  | {
      type: 'completion_started';
      completionId: string;
      baseConversationVersion: number;
    }
  | {
      type: 'briefing_submitted';
      completionId: string;
      briefing: ReadingBriefing;
    }
  | {
      type: 'strategy_submitted';
      completionId: string;
      publicStrategy: string;
      strategy: ReadingStrategyCore;
    }
  | {
      type: 'trial_candidates_submitted';
      completionId: string;
      candidates: TrialCandidate[];
    }
  | {
      type: 'interview_profile_submitted';
      completionId: string;
      bookReaderProfile: BookReaderProfile;
      readerProfilePatch?: ReaderProfilePatch;
    };

export type InterviewCompletionStage =
  | 'start'
  | 'briefing'
  | 'strategy'
  | 'candidates'
  | 'profile'
  | 'complete';

export type InterviewCompletionCheckpointErrorCode =
  | 'lease_lost'
  | 'not_started'
  | 'out_of_order'
  | 'conflict'
  | 'incomplete';

export class InterviewCompletionCheckpointError extends Error {
  constructor(
    readonly code: InterviewCompletionCheckpointErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'InterviewCompletionCheckpointError';
  }
}

type CheckpointMessage = Pick<
  typeof interviewMessages.$inferSelect,
  'kind' | 'payload' | 'sequence'
>;

function checkpointFromPayload(payload: Record<string, unknown>): InterviewCompletionCheckpoint | null {
  if (
    typeof payload.type !== 'string'
    || typeof payload.completionId !== 'string'
    || payload.completionId.length === 0
  ) return null;
  switch (payload.type) {
    case 'completion_started':
      return Number.isInteger(payload.baseConversationVersion)
        ? payload as InterviewCompletionCheckpoint
        : null;
    case 'briefing_submitted':
      return payload.briefing && typeof payload.briefing === 'object'
        ? payload as InterviewCompletionCheckpoint
        : null;
    case 'strategy_submitted':
      return typeof payload.publicStrategy === 'string'
        && payload.strategy && typeof payload.strategy === 'object'
        ? payload as InterviewCompletionCheckpoint
        : null;
    case 'trial_candidates_submitted':
      return Array.isArray(payload.candidates)
        ? payload as InterviewCompletionCheckpoint
        : null;
    case 'interview_profile_submitted':
      return payload.bookReaderProfile && typeof payload.bookReaderProfile === 'object'
        ? payload as InterviewCompletionCheckpoint
        : null;
    default:
      return null;
  }
}

export function isInterviewCompletionCheckpointPayload(value: unknown): boolean {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && checkpointFromPayload(value as Record<string, unknown>),
  );
}

function projectSnapshot(
  messages: CheckpointMessage[],
  baseConversationVersion: number,
): CompletionSnapshot {
  const checkpoints = messages
    .filter((message) => message.kind === 'summary')
    .map((message) => checkpointFromPayload(message.payload))
    .filter((checkpoint): checkpoint is InterviewCompletionCheckpoint => checkpoint !== null);
  const started = checkpoints.findLast((checkpoint) => (
    checkpoint.type === 'completion_started'
    && checkpoint.baseConversationVersion === baseConversationVersion
  ));
  if (!started || started.type !== 'completion_started') {
    return { completionId: null, baseConversationVersion };
  }

  const current = checkpoints.filter((checkpoint) => checkpoint.completionId === started.completionId);
  const briefing = current.findLast((checkpoint) => checkpoint.type === 'briefing_submitted');
  const strategy = current.findLast((checkpoint) => checkpoint.type === 'strategy_submitted');
  const candidates = current.findLast((checkpoint) => checkpoint.type === 'trial_candidates_submitted');
  const profile = current.findLast((checkpoint) => checkpoint.type === 'interview_profile_submitted');
  return {
    completionId: started.completionId,
    baseConversationVersion,
    ...(briefing?.type === 'briefing_submitted' ? { briefing: briefing.briefing } : {}),
    ...(strategy?.type === 'strategy_submitted' ? {
      strategy: { publicStrategy: strategy.publicStrategy, strategy: strategy.strategy },
    } : {}),
    ...(candidates?.type === 'trial_candidates_submitted' ? { candidates: candidates.candidates } : {}),
    ...(profile?.type === 'interview_profile_submitted' ? {
      profile: {
        bookReaderProfile: profile.bookReaderProfile,
        ...(profile.readerProfilePatch ? { readerProfilePatch: profile.readerProfilePatch } : {}),
      },
    } : {}),
  };
}

function nextStage(snapshot: CompletionSnapshot): InterviewCompletionStage {
  if (!snapshot.completionId) return 'start';
  if (!snapshot.briefing) return 'briefing';
  if (!snapshot.strategy) return 'strategy';
  if (!snapshot.candidates) return 'candidates';
  if (!snapshot.profile) return 'profile';
  return 'complete';
}

function payloadRecord(value: InterviewCompletionCheckpoint): Record<string, unknown> {
  return value as unknown as Record<string, unknown>;
}

export function createInterviewCompletionStore(options: {
  db: Database;
  claim: InterviewCompletionClaim;
  validateCandidates?(value: TrialCandidate[]): void;
}): InterviewCompletionStore {
  const { db, claim, validateCandidates } = options;

  const withLockedSnapshot = async <T>(
    action: (
      tx: Parameters<Parameters<Database['transaction']>[0]>[0],
      snapshot: CompletionSnapshot,
      messages: CheckpointMessage[],
    ) => Promise<T>,
  ): Promise<T> => db.transaction(async (tx) => {
    const [session] = await tx
      .select({
        status: interviewSessions.status,
        conversationVersion: interviewSessions.conversationVersion,
        turnLeaseId: interviewSessions.turnLeaseId,
        turnLeaseVersion: interviewSessions.turnLeaseVersion,
        leaseActive: sql<boolean>`${interviewSessions.turnLeaseExpiresAt} > now()`,
        workflowStatus: userBooks.workflowStatus,
      })
      .from(interviewSessions)
      .innerJoin(userBooks, eq(userBooks.id, interviewSessions.userBookId))
      .where(eq(interviewSessions.id, claim.sessionId))
      .limit(1)
      .for('update');
    if (
      !session
      || session.status !== 'active'
      || session.workflowStatus !== 'interviewing'
      || session.conversationVersion !== claim.conversationVersion
      || session.turnLeaseId !== claim.leaseId
      || session.turnLeaseVersion !== claim.conversationVersion
      || !session.leaseActive
    ) {
      throw new InterviewCompletionCheckpointError('lease_lost', 'interview turn lease lost');
    }
    const messages = await tx
      .select({
        kind: interviewMessages.kind,
        payload: interviewMessages.payload,
        sequence: interviewMessages.sequence,
      })
      .from(interviewMessages)
      .where(eq(interviewMessages.interviewSessionId, claim.sessionId))
      .orderBy(interviewMessages.sequence);
    return action(tx, projectSnapshot(messages, claim.conversationVersion), messages);
  });

  const append = async (
    tx: Parameters<Parameters<Database['transaction']>[0]>[0],
    messages: CheckpointMessage[],
    checkpoint: InterviewCompletionCheckpoint,
  ) => {
    const maxSequence = messages.reduce(
      (highest, message) => Math.max(highest, message.sequence),
      0,
    );
    await tx.insert(interviewMessages).values({
      interviewSessionId: claim.sessionId,
      sequence: maxSequence + 1,
      role: 'assistant',
      kind: 'summary',
      content: checkpoint.type,
      payload: payloadRecord(checkpoint),
    });
  };

  const submit = async <T>(input: {
    stage: Exclude<InterviewCompletionStage, 'start' | 'complete'>;
    value: T;
    current(snapshot: CompletionSnapshot): T | undefined;
    checkpoint(completionId: string): InterviewCompletionCheckpoint;
    validate?(value: T): void;
  }): Promise<CompletionSnapshot> => withLockedSnapshot(async (tx, snapshot, messages) => {
    if (!snapshot.completionId) {
      throw new InterviewCompletionCheckpointError('not_started', 'interview completion has not started');
    }
    const existing = input.current(snapshot);
    if (existing !== undefined) {
      if (!isDeepStrictEqual(existing, input.value)) {
        throw new InterviewCompletionCheckpointError('conflict', 'completion stage already has a different result');
      }
      return snapshot;
    }
    const expectedStage = nextStage(snapshot);
    if (expectedStage !== input.stage) {
      throw new InterviewCompletionCheckpointError('out_of_order', `expected ${expectedStage} stage`);
    }
    input.validate?.(input.value);
    await append(tx, messages, input.checkpoint(snapshot.completionId));
    const inserted = input.checkpoint(snapshot.completionId);
    return projectSnapshot([
      ...messages,
      { kind: 'summary', sequence: messages.length + 1, payload: payloadRecord(inserted) },
    ], claim.conversationVersion);
  });

  return {
    load() {
      return withLockedSnapshot(async (_tx, snapshot) => snapshot);
    },
    start() {
      return withLockedSnapshot(async (tx, snapshot, messages) => {
        if (snapshot.completionId) return snapshot;
        const checkpoint: InterviewCompletionCheckpoint = {
          type: 'completion_started',
          completionId: randomUUID(),
          baseConversationVersion: claim.conversationVersion,
        };
        await append(tx, messages, checkpoint);
        return projectSnapshot([
          ...messages,
          { kind: 'summary', sequence: messages.length + 1, payload: payloadRecord(checkpoint) },
        ], claim.conversationVersion);
      });
    },
    submitBriefing(value) {
      return submit({
        stage: 'briefing',
        value,
        current: (snapshot) => snapshot.briefing,
        checkpoint: (completionId) => ({ type: 'briefing_submitted', completionId, briefing: value }),
      });
    },
    submitStrategy(value) {
      return submit({
        stage: 'strategy',
        value,
        current: (snapshot) => snapshot.strategy,
        checkpoint: (completionId) => ({ type: 'strategy_submitted', completionId, ...value }),
      });
    },
    submitCandidates(value) {
      return submit({
        stage: 'candidates',
        value,
        current: (snapshot) => snapshot.candidates,
        ...(validateCandidates ? { validate: validateCandidates } : {}),
        checkpoint: (completionId) => ({
          type: 'trial_candidates_submitted',
          completionId,
          candidates: value,
        }),
      });
    },
    submitProfile(value) {
      return submit({
        stage: 'profile',
        value,
        current: (snapshot) => snapshot.profile,
        checkpoint: (completionId) => ({
          type: 'interview_profile_submitted',
          completionId,
          ...value,
        }),
      });
    },
    complete() {
      return withLockedSnapshot(async (_tx, snapshot) => {
        if (
          !snapshot.briefing
          || !snapshot.strategy
          || !snapshot.candidates
          || !snapshot.profile
        ) {
          throw new InterviewCompletionCheckpointError('incomplete', 'interview completion is incomplete');
        }
        return {
          briefing: snapshot.briefing,
          strategy: snapshot.strategy,
          candidates: snapshot.candidates,
          profile: snapshot.profile,
        };
      });
    },
  };
}
