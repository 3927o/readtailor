import { useId } from 'react';
import type { ProvisionalTrialSample } from '@readtailor/contracts';
import { prepareStandaloneContent } from '../reader/content';
import type { TrialSample } from './api';
import type { TrialOrdinal, TrialSelectionMode } from './trialSelectionStreamState';

type ProgressiveTrialMode = Exclude<TrialSelectionMode, 'idle' | 'completed'>
  | 'generating'
  | 'review';

export interface ProgressiveTrialModel {
  mode: ProgressiveTrialMode;
  samples: Array<ProvisionalTrialSample | TrialSample>;
  activeOrdinal: TrialOrdinal;
  assetBaseUrl?: string;
  error?: string;
}

const SLOT_META = [
  { ordinal: 1, tag: 'threshold', label: '进入门槛' },
  { ordinal: 2, tag: 'typical', label: '典型段落' },
  { ordinal: 3, tag: 'hardest', label: '高难位置' },
] as const;

function sampleStatus(sample: ProvisionalTrialSample | TrialSample | undefined) {
  if (!sample) return 'selecting' as const;
  return 'status' in sample ? sample.status : 'selected' as const;
}

function statusLabel(status: ReturnType<typeof sampleStatus>) {
  switch (status) {
    case 'selecting': return '正在选择';
    case 'selected': return '原文已选出';
    case 'pending': return '等待裁读';
    case 'generating': return '正在生成导读与裁读注';
    case 'ready': return '裁读内容已就绪';
    case 'failed': return '这一段生成失败';
  }
}

export function ProgressiveTrialView({
  model,
  onSelectOrdinal,
}: {
  model: ProgressiveTrialModel;
  onSelectOrdinal(ordinal: TrialOrdinal): void;
}) {
  const instanceId = useId();
  const panelId = `${instanceId}-trial-slot-panel`;
  const tabId = (ordinal: TrialOrdinal) => `${instanceId}-trial-slot-tab-${ordinal}`;
  const samples = [...model.samples].sort((left, right) => left.ordinal - right.ordinal);
  const active = samples.find((sample) => sample.ordinal === model.activeOrdinal);
  const activeStatus = sampleStatus(active);
  const originalHtml = active
    ? prepareStandaloneContent(active.originalHtml, model.assetBaseUrl ?? '', [])
    : '';
  const moveFocus = (ordinal: TrialOrdinal) => {
    onSelectOrdinal(ordinal);
    requestAnimationFrame(() => document.getElementById(tabId(ordinal))?.focus());
  };

  return (
    <section
      className="progressive-trial"
      aria-busy={model.mode === 'selecting' || model.mode === 'recovering' || model.mode === 'generating'}
    >
      <header className="progressive-trial-header">
        <div>
          <span>TRIAL SAMPLES · 三个试读</span>
          <h2>先用三段原文试一试</h2>
        </div>
        <div className="trial-slot-status" aria-live="polite">{statusLabel(activeStatus)}</div>
      </header>

      <div className="trial-slot-tabs" role="tablist" aria-label="试读片段">
        {SLOT_META.map((slot) => {
          const sample = samples.find((item) => item.ordinal === slot.ordinal);
          const status = sampleStatus(sample);
          return (
            <button
              key={slot.ordinal}
              id={tabId(slot.ordinal)}
              className="trial-slot-tab"
              type="button"
              role="tab"
              aria-selected={model.activeOrdinal === slot.ordinal}
              aria-controls={panelId}
              tabIndex={model.activeOrdinal === slot.ordinal ? 0 : -1}
              data-status={status}
              onClick={() => onSelectOrdinal(slot.ordinal)}
              onKeyDown={(event) => {
                let ordinal: TrialOrdinal | null = null;
                if (event.key === 'ArrowLeft') ordinal = slot.ordinal === 1 ? 3 : (slot.ordinal - 1) as TrialOrdinal;
                if (event.key === 'ArrowRight') ordinal = slot.ordinal === 3 ? 1 : (slot.ordinal + 1) as TrialOrdinal;
                if (event.key === 'Home') ordinal = 1;
                if (event.key === 'End') ordinal = 3;
                if (!ordinal) return;
                event.preventDefault();
                moveFocus(ordinal);
              }}
            >
              <span>{String(slot.ordinal).padStart(2, '0')}</span>
              <strong>{slot.label}</strong>
              <small>{statusLabel(status)}</small>
            </button>
          );
        })}
      </div>

      <div
        id={panelId}
        className="trial-sample-stage"
        role="tabpanel"
        aria-labelledby={tabId(model.activeOrdinal)}
      >
        {active ? (
          <>
            <header>
              <strong>{active.chapterPath.join(' › ') || '章节位置未详'}</strong>
              <p>{active.selectionReason}</p>
            </header>
            <div className="trial-original rt-reader-content" dangerouslySetInnerHTML={{ __html: originalHtml }} />
          </>
        ) : (
          <div className="trial-slot-placeholder">
            <strong>正在选择这段原文</strong>
          </div>
        )}
      </div>

      {model.mode === 'recovering' ? (
        <div className="workflow-callout">连接正在恢复，已选出的原文会保留。</div>
      ) : null}
      {model.error ? <div className="form-error" role="alert">{model.error}</div> : null}
    </section>
  );
}
