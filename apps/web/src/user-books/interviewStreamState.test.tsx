import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { InterviewClientStreamEvent, StrategySnapshot } from './api';
import { ProgressiveStrategyView } from './ProgressiveStrategyView';
import { IDLE_INTERVIEW_STREAM, interviewStreamReducer } from './interviewStreamState';

const userBookId = '10000000-0000-0000-0000-000000000001';
const streamId = '10000000-0000-0000-0000-000000000002';

function event<T extends Omit<InterviewClientStreamEvent, 'userBookId' | 'streamId' | 'sequence'>>(
  sequence: number,
  value: T,
): InterviewClientStreamEvent {
  return { userBookId, streamId, sequence, ...value } as unknown as InterviewClientStreamEvent;
}

const nodes = [1, 2, 3].map((ordinal) => ({
  ordinal,
  sectionId: `section-${ordinal}`,
  segment: ordinal,
  chapterPath: [`章节 ${ordinal}`],
  reason: `原因 ${ordinal}`,
}));

const finalStrategy: StrategySnapshot = {
  draftId: '10000000-0000-0000-0000-000000000003',
  draftVersion: 1,
  readingBriefing: {
    bookIdentity: '最终定位',
    arc: '最终脉络',
    assumedKnowledge: '最终前提',
    readingAdvice: '最终读法',
  },
  userFacingSummary: '最终 **处理方式**',
  trialCandidatePreviews: nodes,
  adjustmentCount: 0,
  adjustmentLimit: 5,
  canAdjust: true,
};

describe('interview progressive stream reducer', () => {
  it('reassembles draft fields and lets final snapshot correct provisional content', () => {
    let state = interviewStreamReducer(IDLE_INTERVIEW_STREAM, { type: 'begin', sufficiency: 80 });
    state = interviewStreamReducer(state, { type: 'event', event: event(1, { type: 'speculative_reset', phase: 'interviewing', speculativeEpoch: 1 }) });
    state = interviewStreamReducer(state, { type: 'event', event: event(2, { type: 'draft_started', conversationVersion: 6, speculativeEpoch: 1 }) });
    state = interviewStreamReducer(state, { type: 'event', event: event(3, { type: 'briefing_delta', field: 'book_identity', chars: '临时定位', speculativeEpoch: 1 }) });
    state = interviewStreamReducer(state, { type: 'event', event: event(4, { type: 'strategy_delta', chars: '临时方式', speculativeEpoch: 1 }) });
    state = interviewStreamReducer(state, { type: 'event', event: event(5, { type: 'reading_node_added', node: nodes[0]!, speculativeEpoch: 1 }) });
    state = interviewStreamReducer(state, { type: 'event', event: event(6, { type: 'draft_final', strategy: finalStrategy }) });

    expect(state.mode).toBe('draft_streaming');
    expect(state.briefing).toEqual(finalStrategy.readingBriefing);
    expect(state.strategySummary).toBe(finalStrategy.userFacingSummary);
    expect(state.nodes).toEqual(nodes);
    expect(state.finalStrategy).toEqual(finalStrategy);
  });

  it('drops duplicate sequence and clears stale provisional output on a newer epoch', () => {
    let state = interviewStreamReducer(IDLE_INTERVIEW_STREAM, { type: 'begin', sufficiency: 60 });
    state = interviewStreamReducer(state, { type: 'event', event: event(1, { type: 'prompt_delta', chars: '旧问题', speculativeEpoch: 1 }) });
    state = interviewStreamReducer(state, { type: 'event', event: event(1, { type: 'prompt_delta', chars: '重复', speculativeEpoch: 1 }) });
    expect(state.prompt).toBe('旧问题');

    state = interviewStreamReducer(state, { type: 'event', event: event(2, { type: 'speculative_reset', phase: 'interviewing', speculativeEpoch: 2 }) });
    state = interviewStreamReducer(state, { type: 'event', event: event(3, { type: 'strategy_delta', chars: '旧 epoch', speculativeEpoch: 1 }) });
    expect(state.prompt).toBe('');
    expect(state.strategySummary).toBe('');
  });

  it('rebuilds persisted completion checkpoints after a recovery reset', () => {
    let state = interviewStreamReducer(IDLE_INTERVIEW_STREAM, { type: 'recover' });
    state = interviewStreamReducer(state, { type: 'event', event: event(1, { type: 'speculative_reset', phase: 'interviewing', speculativeEpoch: 2 }) });
    state = interviewStreamReducer(state, { type: 'event', event: event(2, { type: 'draft_started', conversationVersion: 6, speculativeEpoch: 2 }) });
    state = interviewStreamReducer(state, { type: 'event', event: event(3, { type: 'briefing_delta', field: 'book_identity', chars: '已保存定位', speculativeEpoch: 2 }) });
    state = interviewStreamReducer(state, { type: 'event', event: event(4, { type: 'briefing_delta', field: 'arc', chars: '已保存脉络', speculativeEpoch: 2 }) });
    state = interviewStreamReducer(state, { type: 'event', event: event(5, { type: 'strategy_delta', chars: '已保存策略', speculativeEpoch: 2 }) });
    state = interviewStreamReducer(state, { type: 'event', event: event(6, { type: 'reading_node_added', node: nodes[0]!, speculativeEpoch: 2 }) });
    state = interviewStreamReducer(state, { type: 'event', event: event(7, { type: 'strategy_delta', chars: '迟到内容', speculativeEpoch: 1 }) });

    expect(state.mode).toBe('draft_streaming');
    expect(state.briefing).toEqual({ bookIdentity: '已保存定位', arc: '已保存脉络' });
    expect(state.strategySummary).toBe('已保存策略');
    expect(state.nodes).toEqual([nodes[0]]);
  });

  it('leaves recovering when an authoritative snapshot contains the current question', () => {
    let state = interviewStreamReducer(IDLE_INTERVIEW_STREAM, { type: 'recover' });
    state = interviewStreamReducer(state, {
      type: 'reconcile',
      snapshot: {
        status: 'active',
        turnInProgress: false,
        canResume: false,
        history: [],
        currentQuestion: {
          id: 'question-2',
          ordinal: 2,
          maxQuestions: 7,
          prompt: '恢复后的问题',
          options: [],
          acknowledgment: '',
          sufficiency: 50,
        },
        errorSummary: null,
      },
    });

    expect(state).toEqual(IDLE_INTERVIEW_STREAM);
  });

  it('keeps recovering while the authoritative snapshot is still generating', () => {
    const recovering = interviewStreamReducer(IDLE_INTERVIEW_STREAM, { type: 'recover' });
    const state = interviewStreamReducer(recovering, {
      type: 'reconcile',
      snapshot: {
        status: 'active',
        turnInProgress: true,
        canResume: false,
        history: [],
        currentQuestion: null,
        errorSummary: null,
      },
    });

    expect(state.mode).toBe('recovering');
  });
});

describe('ProgressiveStrategyView', () => {
  it('uses the committed briefing and Markdown UI while content is streaming', () => {
    const html = renderToStaticMarkup(<ProgressiveStrategyView model={{
      mode: 'streaming',
      source: 'interview',
      briefing: { bookIdentity: '一本系统书' },
      strategySummary: '正在形成 **处理方式**',
      nodes: [nodes[0]!],
    }} />);
    expect(html.match(/brief-section/g)).toHaveLength(4);
    expect(html).toContain('BEFORE YOU READ · 读前简报');
    expect(html).toContain('<strong>处理方式</strong>');
    expect(html).toContain('正在选择位置');
  });

  it('keeps the completed UI structure stable when the authoritative result arrives', () => {
    const streaming = renderToStaticMarkup(<ProgressiveStrategyView model={{
      mode: 'streaming',
      source: 'interview',
      briefing: finalStrategy.readingBriefing,
      strategySummary: finalStrategy.userFacingSummary,
      nodes,
    }} />);
    const committed = renderToStaticMarkup(<ProgressiveStrategyView model={{
      mode: 'committed',
      source: 'interview',
      briefing: finalStrategy.readingBriefing,
      strategySummary: finalStrategy.userFacingSummary,
      nodes,
      draftVersion: 1,
    }} />);
    expect(streaming.match(/brief-section/g)).toHaveLength(4);
    expect(committed.match(/brief-section/g)).toHaveLength(4);
    expect(streaming).toContain('class="rt-kicker"');
    expect(committed).toContain('class="rt-kicker"');
    expect(committed).toContain('<strong>处理方式</strong>');
    expect(committed).toContain('章节 3');
  });
});
