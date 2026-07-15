import {
  runReadingSetupAgent,
  type InterviewQuestion,
  type InterviewStreamDelta,
  type ReadingSetupOutcome,
  type ReadingSetupCallMetrics,
  type ReadingSetupPhase,
  type ReadingStrategy,
  type TrialFragmentSelection,
} from '@readtailor/agent-kit';
import {
  appendAgentTraceEvent,
  summarizeAgentTraceEvents,
  timeAgentCall,
  type PerfSink,
} from '@readtailor/observability';

export interface ReadingSetupEngine {
  // One continuous logical session per user_book. `phase` selects the exposed tools:
  // interviewing → present_interview_question / finish_interview; strategy_review →
  // save_strategy_draft. The outcome is a discriminated union (question | completed | revised).
  // `onStream` (interviewing only) receives token-level deltas for the SSE endpoint (§4).
  runTurn(input: {
    sessionId: string;
    phase: ReadingSetupPhase;
    askedCount: number;
    context: Record<string, unknown>;
    feedback?: string;
    requestId?: string;
    conversationVersion?: number;
    onStream?: (delta: InterviewStreamDelta) => void;
  }): Promise<ReadingSetupOutcome>;
}

export function createAgentReadingSetupEngine(options: {
  apiBaseUrl: string;
  apiKey: string;
  modelName: string;
  perfSink?: PerfSink;
}): ReadingSetupEngine {
  return {
    runTurn(input) {
      const trace: Array<Record<string, unknown>> = [];
      let metrics: ReadingSetupCallMetrics | undefined;
      const summarize = () => ({
        ...summarizeAgentTraceEvents(trace),
        ...(metrics ?? {}),
      });
      return timeAgentCall(
        options.perfSink,
        {
          requestId: input.requestId ?? null,
          sessionId: input.sessionId,
          conversationVersion: input.conversationVersion ?? null,
          source: 'api',
          kind: `reading_setup.${input.phase}`,
          model: options.modelName,
          traceEvents: trace,
        },
        () => runReadingSetupAgent({
          ...options,
          ...input,
          onTrace: (event) => appendAgentTraceEvent(trace, event),
          onMetrics: (value) => {
            metrics = value;
          },
        }),
        {
          onSuccess: summarize,
          onError: summarize,
        },
      );
    },
  };
}

const fakeQuestions: InterviewQuestion[] = [
  {
    id: 'reading-purpose',
    acknowledgment: '',
    prompt: '你最希望通过这本书解决什么问题？',
    hint: '知道你的目的，我才知道该把你带向哪里。',
    options: [
      { id: 'understand', label: '建立完整理解' },
      { id: 'apply', label: '把关键观点用到实际问题中' },
      { id: 'explore', label: '先判断它是否值得深入读' },
    ],
    allow_text: true,
    profile_dimension: 'reading_goals',
    sufficiency: 25,
  },
  {
    id: 'prior-knowledge',
    acknowledgment: '明白了，我会围绕这个目标来安排处理方式。',
    prompt: '你对这本书讨论的领域已经熟悉到什么程度？',
    hint: '我据此决定要不要先替你补背景。',
    options: [
      { id: 'new', label: '基本陌生，需要补充必要背景' },
      { id: 'some', label: '知道一些概念，但没有系统读过' },
      { id: 'familiar', label: '比较熟悉，希望直接进入细节' },
    ],
    allow_text: true,
    profile_dimension: 'prior_knowledge',
    sufficiency: 55,
  },
  {
    id: 'likely-barrier',
    acknowledgment: '好的，这能帮助我判断需要补多少背景。',
    prompt: '什么情况最容易让你在阅读过程中停下来？',
    hint: '我会把力气优先花在这些地方。',
    options: [
      { id: 'concepts', label: '概念密集，不清楚术语之间的关系' },
      { id: 'context', label: '缺少背景，不知道作者为什么这样说' },
      { id: 'structure', label: '局部能读懂，但容易失去全书主线' },
      { id: 'pace', label: '解释太多会打断阅读节奏' },
    ],
    allow_text: true,
    profile_dimension: 'likely_barriers',
    sufficiency: 80,
  },
];

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function selectTrialCandidates(context: Record<string, unknown>): ReadingStrategy['trial_candidates'] {
  const bookProfile = record(context.bookProfile);
  const raw = Array.isArray(bookProfile.trial_candidates) ? bookProfile.trial_candidates : [];
  const candidates = raw
    .map((item) => record(item))
    .filter((item) => typeof item.section_id === 'string' && Number.isInteger(item.segment));
  if (candidates.length < 3) {
    throw new Error('book profile does not contain three valid trial candidates');
  }
  const indexes = [0, Math.floor((candidates.length - 1) / 2), candidates.length - 1];
  return indexes.map((index, ordinal) => {
    const candidate = candidates[index]!;
    return {
      section_id: candidate.section_id as string,
      segment: candidate.segment as number,
      reason: text(
        candidate.reason,
        ['用于观察进入本书时的理解门槛。', '用于观察全书典型内容的表达方式。', '用于检验较高难度内容的处理效果。'][ordinal]!,
      ),
    };
  });
}

function fakeSelectFragments(context: Record<string, unknown>): TrialFragmentSelection[] {
  const nodes = Array.isArray(context.trialNodeContents) ? context.trialNodeContents : [];
  if (nodes.length < 3) {
    throw new Error('fake select_trial requires three preloaded candidate nodes');
  }
  const tags: TrialFragmentSelection['tag'][] = ['threshold', 'typical', 'hardest'];
  const reasons = [
    '覆盖进入本书时的理解门槛。',
    '覆盖全书典型内容的表达方式。',
    '覆盖较高难度内容的处理效果。',
  ];
  return nodes.slice(0, 3).map((raw, ordinal) => {
    const node = record(raw);
    const blocks = (Array.isArray(node.blocks) ? node.blocks : [])
      .map((block) => record(block))
      .filter((block) => Number.isInteger(block.block_index));
    const first = blocks[0];
    const last = blocks.at(-1);
    if (!first || !last) throw new Error('fake select_trial candidate node has no blocks');
    return {
      section_id: node.section_id as string,
      segment: node.segment as number,
      tag: tags[ordinal]!,
      range: {
        start: { block_index: first.block_index as number, offset: 0 },
        end: { block_index: last.block_index as number, offset: String(last.text ?? '').length },
      },
      reason: reasons[ordinal]!,
    };
  });
}

function fakeCompleted(context: Record<string, unknown>): ReadingSetupOutcome {
  const book = record(context.book);
  const bookProfile = record(context.bookProfile);
  const title = text(book.title, '这本书');
  const summary = text(bookProfile.summary, `${title}围绕一组彼此关联的核心问题展开。`);
  const structure = text(bookProfile.structure, '全书按章节逐步展开论点与例子。');
  const strategy: ReadingStrategy = {
    goals: ['帮助用户在保持阅读节奏的同时建立全书主线并在关键处补齐理解。'],
    expression_principles: ['保持原文完整，只在确有理解价值时增加辅助内容，不打断正常阅读节奏。'],
    guide: {
      enabled: true,
      objectives: ['在每个适合处理的节点开始前交代当前位置与阅读重点。'],
    },
    annotations: {
      enabled: true,
      focuses: ['解释影响当前段落理解的关键概念、背景和论证跳步。'],
      exclusions: ['不复述已经清楚的原文，不用解释打断正常阅读节奏。'],
    },
    after_reading: {
      enabled: true,
      objectives: ['在节点结束后帮助用户把局部内容放回全书主线。'],
    },
    trial_candidates: selectTrialCandidates(context),
  };
  return {
    type: 'completed',
    bookReaderProfile: {
      summary: `用户希望在保持阅读节奏的同时，建立对《${title}》主线和关键概念的可靠理解。`,
      motivations: ['真正读完并形成可复述的整体理解。'],
      prior_knowledge: ['对相关领域有初步认识，具体程度以访谈回答为准。'],
      reading_goals: ['抓住全书主线，并理解关键概念在具体段落中的作用。'],
      likely_barriers: ['概念或背景密集时可能失去局部内容与全书结构之间的联系。'],
    },
    briefing: {
      book_identity: `《${title}》并不适合只靠摘取结论来读。${summary}`,
      arc: structure,
      assumed_knowledge: '默认你对相关领域有初步认识；真正陌生的概念与背景，我会在正文旁替你补上。',
      reading_advice: '先保持正文推进，遇到影响理解的概念再展开裁读内容；重点是始终知道作者此刻在做什么、这一段与全书主线的关系。',
    },
    publicStrategy: '阅读节点开始前，我会用简短导读说明当前位置和真正值得留意的问题。正文中只在关键概念、必要背景或论证跳步处加入裁读注，已经清楚的句子不重复解释。节点结束后，我会视内容需要补一段助读，帮助你把刚读过的内容放回全书结构。任何增强内容都只附加在原文旁边，不改写原文。',
    strategy,
  };
}

// Replays a resolved interviewing outcome as synthetic stream deltas so the SSE endpoint
// (and its tests / local dev) exercise the real event path without a live model.
function emitFakeStream(onStream: (delta: InterviewStreamDelta) => void, outcome: ReadingSetupOutcome): void {
  if (outcome.type === 'question') {
    const question = outcome.question;
    if (question.acknowledgment) onStream({ type: 'ack_delta', chars: question.acknowledgment });
    onStream({ type: 'prompt_delta', chars: question.prompt });
    if (question.hint) onStream({ type: 'hint_delta', chars: question.hint });
    for (const option of question.options) onStream({ type: 'option_added', id: option.id, label: option.label });
    onStream({ type: 'sufficiency', value: question.sufficiency });
  } else if (outcome.type === 'completed') {
    onStream({ type: 'concluding' });
  }
}

export function createFakeReadingSetupEngine(): ReadingSetupEngine {
  return {
    async runTurn(input) {
      if (input.phase === 'select_trial') {
        return { type: 'fragments', fragments: fakeSelectFragments(input.context) };
      }
      if (input.phase === 'strategy_review') {
        const completed = fakeCompleted(input.context);
        if (completed.type !== 'completed') throw new Error('fake setup did not complete');
        return {
          type: 'revised',
          publicStrategy: `${completed.publicStrategy}\n\n已吸收你的反馈：${(input.feedback ?? '').trim()}`,
          strategy: completed.strategy,
        };
      }
      const question = fakeQuestions[input.askedCount];
      const outcome: ReadingSetupOutcome = question
        ? { type: 'question', question }
        : fakeCompleted(input.context);
      if (input.onStream) emitFakeStream(input.onStream, outcome);
      return outcome;
    },
  };
}
