import type {
  AuthSessionResponse,
  PasswordLoginRequest,
  PasswordRegisterRequest,
  ReaderProfileOnboardingRequest,
  ReaderProfileResponse,
} from '@readtailor/contracts';
import { apiBaseUrl } from '../library/api';

export class AuthApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'AuthApiError';
  }
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event('readtailor:unauthorized'));
    const body = await response.json().catch(() => null) as { error?: unknown } | null;
    throw new AuthApiError(
      typeof body?.error === 'string' ? body.error : `请求失败（${response.status}）`,
      response.status,
    );
  }
  return response.json() as Promise<T>;
}

export async function getAuthSession(): Promise<AuthSessionResponse> {
  return readJson<AuthSessionResponse>(await fetch(`${apiBaseUrl}/v1/auth/session`, {
    credentials: 'include',
  }));
}

export async function developmentLogin(): Promise<AuthSessionResponse> {
  return readJson<AuthSessionResponse>(await fetch(`${apiBaseUrl}/v1/auth/development`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  }));
}

export async function passwordLogin(
  input: PasswordLoginRequest,
): Promise<AuthSessionResponse> {
  return readJson<AuthSessionResponse>(await fetch(`${apiBaseUrl}/v1/auth/login`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  }));
}

export async function passwordRegister(
  input: PasswordRegisterRequest,
): Promise<AuthSessionResponse> {
  return readJson<AuthSessionResponse>(await fetch(`${apiBaseUrl}/v1/auth/register`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  }));
}

export async function logout(): Promise<void> {
  const response = await fetch(`${apiBaseUrl}/v1/auth/logout`, {
    method: 'POST',
    credentials: 'include',
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: unknown } | null;
    throw new AuthApiError(
      typeof body?.error === 'string' ? body.error : `退出失败（${response.status}）`,
      response.status,
    );
  }
}

export async function completeProfileOnboarding(
  input: ReaderProfileOnboardingRequest,
): Promise<ReaderProfileResponse> {
  return readJson<ReaderProfileResponse>(await fetch(`${apiBaseUrl}/v1/profile/onboarding`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  }));
}

export function googleLoginUrl(returnTo: string): string {
  return `${apiBaseUrl}/v1/auth/google/start?returnTo=${encodeURIComponent(returnTo)}`;
}
