import type { Briefing, ReadingNodePreview } from '@readtailor/contracts';
import { AssistanceContent, BriefCard } from './components';

export interface ProgressiveStrategyModel {
  mode: 'streaming' | 'recovering' | 'committed' | 'failed';
  source: 'interview' | 'strategy_feedback' | 'trial_feedback';
  briefing: Partial<Briefing>;
  strategySummary: string;
  nodes: ReadingNodePreview[];
  draftVersion?: number;
  error?: string;
}

const BRIEFING_SECTIONS: Array<{ key: keyof Briefing; label: string; prep?: boolean }> = [
  { key: 'bookIdentity', label: '这是一本什么书' },
  { key: 'arc', label: '全书怎么走' },
  { key: 'assumedKnowledge', label: '假设你已经知道' },
  { key: 'readingAdvice', label: '建议你的读法', prep: true },
];

function PartialBriefCard({ briefing }: { briefing: Partial<Briefing> }) {
  return (
    <section className="brief-card progressive-brief" aria-label="读前简报">
      <div className="strategy-version">Before you read · 读前简报</div>
      <h2>读之前，我想先和你说几句</h2>
      {BRIEFING_SECTIONS.map((section) => (
        <div className="brief-section" key={section.key} data-personalized={section.prep ? 'true' : undefined}>
          <h3>{section.label}</h3>
          <p>{briefing[section.key] || <span className="progressive-placeholder">正在整理…</span>}</p>
        </div>
      ))}
    </section>
  );
}

export function ProgressiveStrategyView({ model }: { model: ProgressiveStrategyModel }) {
  const committed = model.mode === 'committed';
  const showCommittedBriefing = committed || model.source !== 'interview';
  const briefing = {
    bookIdentity: model.briefing.bookIdentity ?? '',
    arc: model.briefing.arc ?? '',
    assumedKnowledge: model.briefing.assumedKnowledge ?? '',
    readingAdvice: model.briefing.readingAdvice ?? '',
  };
  const nodes = [...model.nodes].sort((left, right) => left.ordinal - right.ordinal);
  return (
    <div
      className="strategy-review progressive-strategy"
      aria-busy={model.mode === 'streaming' || model.mode === 'recovering'}
    >
      {showCommittedBriefing ? <BriefCard briefing={briefing} /> : <PartialBriefCard briefing={model.briefing} />}
      <section className="strategy-copy">
        <div className="strategy-version">
          {model.draftVersion ? `处理方式 · 草稿 V${model.draftVersion}` : '处理方式 · 正在起草'}
        </div>
        <h2>我们会怎样陪你读这本书</h2>
        {model.strategySummary ? (
          committed
            ? <AssistanceContent content={model.strategySummary} />
            : <p className="progressive-strategy-text">{model.strategySummary}</p>
        ) : <p className="progressive-placeholder">正在形成处理方式…</p>}
      </section>
      <section className="reading-node-selection" aria-label="试读候选位置">
        <div className="strategy-version">三个阅读位置</div>
        <ol>
          {[1, 2, 3].map((ordinal) => {
            const node = nodes.find((item) => item.ordinal === ordinal);
            return (
              <li key={ordinal} data-ready={node ? 'true' : undefined}>
                <span>{String(ordinal).padStart(2, '0')}</span>
                <div>
                  <strong>{node?.chapterPath.join(' / ') || '正在选择位置…'}</strong>
                  {node ? <p>{node.reason}</p> : null}
                </div>
              </li>
            );
          })}
        </ol>
      </section>
      {model.mode === 'recovering' ? <div className="workflow-callout">连接正在恢复，已收到的内容会保留。</div> : null}
      {model.error ? <div className="form-error" role="alert">{model.error}</div> : null}
    </div>
  );
}
