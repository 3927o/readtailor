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

export function ProgressiveStrategyView({ model }: { model: ProgressiveStrategyModel }) {
  const committed = model.mode === 'committed';
  const briefingPending = model.source === 'interview' && !committed;
  const nodes = [...model.nodes].sort((left, right) => left.ordinal - right.ordinal);
  return (
    <div
      className="strategy-review progressive-strategy"
      aria-busy={model.mode === 'streaming' || model.mode === 'recovering'}
    >
      <BriefCard briefing={model.briefing} pending={briefingPending} />
      <section className="strategy-copy">
        <div className="strategy-version">
          {model.draftVersion ? `处理方式 · 草稿 V${model.draftVersion}` : '处理方式 · 正在起草'}
        </div>
        <h2>我们会怎样陪你读这本书</h2>
        {model.strategySummary
          ? <AssistanceContent content={model.strategySummary} />
          : <p className="progressive-placeholder">正在形成处理方式…</p>}
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
