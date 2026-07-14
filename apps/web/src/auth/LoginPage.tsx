import { useState, type FormEvent } from 'react';
import { Navigate, useSearchParams } from 'react-router';
import { useAuth } from './AuthProvider';
import { googleLoginUrl } from './api';

export const AUTH_RETURN_TO_STORAGE_KEY = 'readtailor.auth.returnTo';

function safeReturnTo(value: string | null): string {
  return value?.startsWith('/') && !value.startsWith('//') ? value : '/';
}

function loginErrorMessage(code: string | null): string | null {
  if (!code) return null;
  if (code === 'google_denied') return 'Google 登录已取消。';
  if (code === 'account_disabled') return '这个账户已停用。';
  return 'Google 登录没有完成，请重试。';
}

export function LoginPage() {
  const auth = useAuth();
  const [searchParams] = useSearchParams();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [formPending, setFormPending] = useState(false);
  const [developmentPending, setDevelopmentPending] = useState(false);
  const returnTo = safeReturnTo(searchParams.get('returnTo'));
  const oauthError = loginErrorMessage(searchParams.get('error'));
  const developmentEnabled = import.meta.env.VITE_AUTH_DEVELOPMENT_ENABLED === 'true';

  if (auth.isLoading) {
    return <main className="login-page auth-state" aria-busy="true">正在确认登录状态…</main>;
  }
  if (auth.user) {
    return <Navigate replace to={auth.user.readerProfileCompleted ? returnTo : '/onboarding'} />;
  }

  const rememberReturnTo = () => {
    sessionStorage.setItem(AUTH_RETURN_TO_STORAGE_KEY, returnTo);
  };

  const submitPassword = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);
    setFormPending(true);
    rememberReturnTo();
    const request = mode === 'login'
      ? auth.passwordLogin({ email, password })
      : auth.passwordRegister({ displayName, email, password });
    void request
      .catch((error: unknown) => {
        setFormError(error instanceof Error ? error.message : '认证失败，请重试');
      })
      .finally(() => setFormPending(false));
  };

  return (
    <main className="login-page">
      <section className="login-panel" aria-labelledby="login-title">
        <div className="login-brand">
          <span className="login-brand-cn">裁读</span>
          <span className="login-brand-en">READTAILOR</span>
        </div>
        <div className="login-mode-tabs" role="tablist" aria-label="账户入口">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'login'}
            onClick={() => {
              setMode('login');
              setFormError(null);
            }}
          >登录</button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'register'}
            onClick={() => {
              setMode('register');
              setFormError(null);
            }}
          >注册</button>
        </div>

        <h1 id="login-title">{mode === 'login' ? '登录裁读' : '创建裁读账户'}</h1>
        <p>{mode === 'login' ? '回到你的书架、阅读画像和阅读进度。' : '建立你的书架和个人阅读画像。'}</p>

        {oauthError || formError || auth.error ? (
          <div className="form-error" role="alert">
            {formError ?? oauthError ?? auth.error?.message}
          </div>
        ) : null}

        <form className="login-form" onSubmit={submitPassword}>
          {mode === 'register' ? (
            <label>
              <span>昵称</span>
              <input
                type="text"
                name="name"
                autoComplete="name"
                minLength={1}
                maxLength={100}
                required
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
              />
            </label>
          ) : null}
          <label>
            <span>邮箱</span>
            <input
              type="email"
              name="email"
              autoComplete="email"
              maxLength={254}
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <label>
            <span>密码</span>
            <input
              type="password"
              name="password"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              minLength={mode === 'login' ? 1 : 10}
              maxLength={128}
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <button className="button button-primary" type="submit" disabled={formPending}>
            {formPending ? '正在提交…' : mode === 'login' ? '登录' : '创建账户'}
          </button>
        </form>

        <div className="login-divider"><span>或</span></div>

        <div className="login-actions">
          <button
            className="button button-secondary login-google"
            type="button"
            onClick={() => {
              rememberReturnTo();
              window.location.assign(googleLoginUrl(returnTo));
            }}
          >
            使用 Google 登录
          </button>

          {developmentEnabled ? (
            <button
              className="button button-secondary"
              type="button"
              disabled={developmentPending}
              onClick={() => {
                setFormError(null);
                setDevelopmentPending(true);
                rememberReturnTo();
                void auth.developmentLogin()
                  .catch((error: unknown) => {
                    setFormError(error instanceof Error ? error.message : '开发登录失败');
                  })
                  .finally(() => setDevelopmentPending(false));
              }}
            >
              {developmentPending ? '正在登录…' : '开发环境登录'}
            </button>
          ) : null}
        </div>
      </section>
    </main>
  );
}
