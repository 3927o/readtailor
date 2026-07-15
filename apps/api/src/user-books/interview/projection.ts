import type {
  BookReaderProfile,
  Briefing,
  InterviewQuestion,
  InterviewStateResponse,
} from '@readtailor/contracts';
import {
  interviewAnswers,
  interviewMessages,
  interviewSessions,
} from '@readtailor/database';

type InterviewSessionRow = typeof interviewSessions.$inferSelect;
type InterviewMessageRow = typeof interviewMessages.$inferSelect;
type InterviewAnswerRow = typeof interviewAnswers.$inferSelect;

export function mapInterviewQuestion(value: {
  id: string;
  acknowledgment: string;
  prompt: string;
  hint?: string;
  options: Array<{ id: string; label: string }>;
  allow_text: true;
  profile_dimension: string;
  sufficiency: number;
}): InterviewQuestion {
  return {
    id: value.id,
    acknowledgment: value.acknowledgment,
    prompt: value.prompt,
    ...(value.hint ? { hint: value.hint } : {}),
    options: value.options,
    allowFreeText: true,
    profileDimension: value.profile_dimension,
    sufficiency: value.sufficiency,
  };
}

export function mapInterviewBookReaderProfile(value: {
  summary: string;
  motivations: string[];
  prior_knowledge: string[];
  reading_goals: string[];
  likely_barriers: string[];
}): BookReaderProfile {
  return {
    purpose: value.motivations.join('；'),
    existingKnowledge: value.prior_knowledge,
    desiredDepthOrOutcome: value.reading_goals.join('；'),
    likelyObstacles: value.likely_barriers,
    expectedCommitment: '按实际阅读进度持续推进，不要求一次生成整本书。',
    otherConclusions: [value.summary],
  };
}

export function mapInterviewBriefing(value: {
  book_identity: string;
  arc: string;
  assumed_knowledge: string;
  reading_advice: string;
}): Briefing {
  return {
    bookIdentity: value.book_identity,
    arc: value.arc,
    assumedKnowledge: value.assumed_knowledge,
    readingAdvice: value.reading_advice,
  };
}

export function projectInterviewState(input: {
  session: InterviewSessionRow;
  messages: InterviewMessageRow[];
  answers: Array<{ answer: InterviewAnswerRow; question: InterviewMessageRow }>;
  now?: Date;
}): InterviewStateResponse {
  const { session, messages, answers } = input;
  const answeredQuestionIds = new Set(answers.map((row) => String(row.question.payload.id ?? '')));
  const currentMessage = [...messages]
    .reverse()
    .find((message) => (
      message.kind === 'question'
      && !answeredQuestionIds.has(String(message.payload.id ?? ''))
    ));
  return {
    sessionId: session.id,
    status: session.status,
    turnInProgress: Boolean(
      session.turnLeaseId
      && session.turnLeaseExpiresAt
      && session.turnLeaseExpiresAt.getTime() > (input.now ?? new Date()).getTime()
    ),
    completionStarted: messages.some((message) => (
      message.kind === 'summary'
      && message.payload.type === 'completion_started'
    )),
    questionCount: session.questionCount,
    maxQuestions: 7,
    currentQuestion: currentMessage ? currentMessage.payload as InterviewQuestion : null,
    sufficiency: currentMessage
      ? (currentMessage.payload as { sufficiency?: number }).sufficiency ?? null
      : null,
    answers: answers.map(({ answer, question }) => {
      const payload = question.payload as InterviewQuestion;
      const labels = answer.selectedOptionIds
        .map((id) => payload.options?.find((option) => option.id === id)?.label ?? id);
      const answerText = [...labels, answer.freeText?.trim()].filter(Boolean).join('；');
      return {
        id: answer.id,
        questionId: String(payload.id ?? ''),
        question: payload.prompt ?? '',
        selectedOptionIds: answer.selectedOptionIds,
        freeText: answer.freeText,
        answerText,
        createdAt: answer.createdAt.toISOString(),
      };
    }),
  };
}
