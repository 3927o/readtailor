import { useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { ReaderProfileOnboardingRequest } from '@readtailor/contracts';
import { Navigate, useNavigate } from 'react-router';
import { useAuth } from './AuthProvider';
import { completeProfileOnboarding } from './api';
import { AUTH_RETURN_TO_STORAGE_KEY } from './LoginPage';

const KNOWLEDGE_OPTIONS = [
  { id: 'literature_arts', label: '文学与艺术' },
  { id: 'history_philosophy_social_sciences', label: '历史、哲学与社会科学' },
  { id: 'business_economics_management', label: '商业、经济与管理' },
  { id: 'math_science_engineering', label: '数学、自然科学与工程' },
  { id: 'computing_internet', label: '计算机与互联网' },
  { id: 'none', label: '没有特别熟悉的领域' },
] as const;

const EXPLANATION_OPTIONS = [
  { id: 'plain_then_precise', label: '先用通俗的话说明，再介绍准确概念' },
  { id: 'examples_analogies', label: '多用具体例子或类比' },
  { id: 'definitions_logic', label: '从定义和逻辑关系一步步推导' },
  { id: 'concise_then_expand', label: '直接给简洁结论，需要时再展开' },
  { id: 'adaptive', label: '没有固定偏好，根据内容决定' },
] as const;

const BACKGROUND_OPTIONS = [
  { id: 'essential_only', label: '只补充理解当前内容必需的信息' },
  { id: 'context_without_digression', label: '适当说明来龙去脉，但不要偏离原书太远' },
  { id: 'systematic_foundations', label: '尽量系统地补齐相关基础' },
  { id: 'adaptive', label: '根据内容决定' },
] as const;

type KnowledgeOptionId = (typeof KNOWLEDGE_OPTIONS)[number]['id'];
type ExplanationOptionId = (typeof EXPLANATION_OPTIONS)[number]['id'];
type BackgroundOptionId = (typeof BACKGROUND_OPTIONS)[number]['id'];

function safeStoredReturnTo(value: string | null): string {
  return value?.startsWith('/') && !value.startsWith('//') && value !== '/onboarding'
    ? value
    : '/';
}

function toggleExclusive<T extends string>(
  selected: readonly T[],
  id: T,
  exclusiveId: T,
  maxItems: number,
): T[] {
  if (selected.includes(id)) return selected.filter((item) => item !== id);
  if (id === exclusiveId) return [exclusiveId];
  const withoutExclusive = selected.filter((item) => item !== exclusiveId);
  return withoutExclusive.length >= maxItems ? [...withoutExclusive] : [...withoutExclusive, id];
}

export function OnboardingPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [knowledgeOptionIds, setKnowledgeOptionIds] = useState<KnowledgeOptionId[]>([]);
  const [knowledgeFreeText, setKnowledgeFreeText] = useState('');
  const [explanationOptionIds, setExplanationOptionIds] = useState<ExplanationOptionId[]>([]);
  const [explanationFreeText, setExplanationFreeText] = useState('');
  const [backgroundDepthOptionId, setBackgroundDepthOptionId] = useState<BackgroundOptionId>(
    'context_without_digression',
  );
  const [validationError, setValidationError] = useState<string | null>(null);
  const submit = useMutation({
    mutationFn: completeProfileOnboarding,
    onSuccess: () => {
      auth.markReaderProfileCompleted();
      const returnTo = safeStoredReturnTo(sessionStorage.getItem(AUTH_RETURN_TO_STORAGE_KEY));
      sessionStorage.removeItem(AUTH_RETURN_TO_STORAGE_KEY);
      navigate(returnTo, { replace: true });
    },
  });

  const stepValid = useMemo(() => {
    if (step === 0) return knowledgeOptionIds.length > 0;
    if (step === 1) return explanationOptionIds.length > 0;
    return Boolean(backgroundDepthOptionId);
  }, [backgroundDepthOptionId, explanationOptionIds.length, knowledgeOptionIds.length, step]);

  if (auth.isLoading) {
    return <main className="onboarding-page auth-state" aria-busy="true">正在读取账户…</main>;
  }
  if (!auth.user) {
    return <Navigate replace to="/login?returnTo=%2Fonboarding" />;
  }
  if (auth.user.readerProfileCompleted) {
    return <Navigate replace to="/" />;
  }

  const next = () => {
    if (!stepValid) {
      setValidationError(step === 0 ? '请至少选择一项知识背景。' : '请至少选择一种解释方式。');
      return;
    }
    setValidationError(null);
    setStep((current) => Math.min(2, current + 1));
  };

  const submitAnswers = () => {
    const input: ReaderProfileOnboardingRequest = {
      knowledgeOptionIds,
      ...(knowledgeFreeText.trim() ? { knowledgeFreeText: knowledgeFreeText.trim() } : {}),
      explanationOptionIds,
      ...(explanationFreeText.trim() ? { explanationFreeText: explanationFreeText.trim() } : {}),
      backgroundDepthOptionId,
    };
    submit.mutate(input);
  };

  return (
    <main className="onboarding-page">
      <section className="onboarding-panel" aria-labelledby="onboarding-title">
        <header className="onboarding-header">
          <div className="onboarding-progress" aria-label={`第 ${step + 1} 题，共 3 题`}>
            <span>{step + 1}/3</span>
            <progress value={step + 1} max={3} />
          </div>
          <h1 id="onboarding-title">建立你的阅读画像</h1>
        </header>

        {step === 0 ? (
          <fieldset className="onboarding-question">
            <legend>下面哪些领域是你比较熟悉的？</legend>
            <div className="onboarding-options">
              {KNOWLEDGE_OPTIONS.map((option) => {
                const checked = knowledgeOptionIds.includes(option.id);
                const disabled = !checked
                  && option.id !== 'none'
                  && !knowledgeOptionIds.includes('none')
                  && knowledgeOptionIds.length >= 3;
                return (
                  <label key={option.id}>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={disabled}
                      onChange={() => setKnowledgeOptionIds((current) => (
                        toggleExclusive(current, option.id, 'none', 3)
                      ))}
                    />
                    <span>{option.label}</span>
                  </label>
                );
              })}
            </div>
            <label className="onboarding-free-text">
              <span>也可以补充更具体的领域</span>
              <textarea
                value={knowledgeFreeText}
                maxLength={500}
                placeholder="例如：古希腊哲学、机器学习"
                onChange={(event) => setKnowledgeFreeText(event.target.value)}
              />
            </label>
          </fieldset>
        ) : null}

        {step === 1 ? (
          <fieldset className="onboarding-question">
            <legend>遇到陌生概念时，你更喜欢怎样的解释？</legend>
            <div className="onboarding-options">
              {EXPLANATION_OPTIONS.map((option) => {
                const checked = explanationOptionIds.includes(option.id);
                const disabled = !checked
                  && option.id !== 'adaptive'
                  && !explanationOptionIds.includes('adaptive')
                  && explanationOptionIds.length >= 2;
                return (
                  <label key={option.id}>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={disabled}
                      onChange={() => setExplanationOptionIds((current) => (
                        toggleExclusive(current, option.id, 'adaptive', 2)
                      ))}
                    />
                    <span>{option.label}</span>
                  </label>
                );
              })}
            </div>
            <label className="onboarding-free-text">
              <span>还有其他解释偏好吗？</span>
              <textarea
                value={explanationFreeText}
                maxLength={500}
                onChange={(event) => setExplanationFreeText(event.target.value)}
              />
            </label>
          </fieldset>
        ) : null}

        {step === 2 ? (
          <fieldset className="onboarding-question">
            <legend>阅读不熟悉领域的内容时，你希望默认补充多少背景？</legend>
            <div className="onboarding-options">
              {BACKGROUND_OPTIONS.map((option) => (
                <label key={option.id}>
                  <input
                    type="radio"
                    name="background-depth"
                    value={option.id}
                    checked={backgroundDepthOptionId === option.id}
                    onChange={() => setBackgroundDepthOptionId(option.id)}
                  />
                  <span>{option.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}

        {validationError || submit.isError ? (
          <div className="form-error" role="alert">
            {validationError ?? (submit.error instanceof Error ? submit.error.message : '画像提交失败')}
          </div>
        ) : null}

        <div className="onboarding-actions">
          {step > 0 ? (
            <button
              className="button button-secondary"
              type="button"
              disabled={submit.isPending}
              onClick={() => {
                setValidationError(null);
                setStep((current) => Math.max(0, current - 1));
              }}
            >
              返回
            </button>
          ) : null}
          {step < 2 ? (
            <button className="button button-primary" type="button" onClick={next}>继续</button>
          ) : (
            <button
              className="button button-primary"
              type="button"
              disabled={submit.isPending}
              onClick={submitAnswers}
            >
              {submit.isPending ? '正在建立画像…' : '完成并进入书架'}
            </button>
          )}
        </div>
      </section>
    </main>
  );
}
