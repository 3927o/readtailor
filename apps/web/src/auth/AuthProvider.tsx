import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, type ReactNode } from 'react';
import type {
  AuthSessionResponse,
  AuthUser,
  PasswordLoginRequest,
  PasswordRegisterRequest,
} from '@readtailor/contracts';
import {
  developmentLogin as requestDevelopmentLogin,
  getAuthSession,
  logout as requestLogout,
  passwordLogin as requestPasswordLogin,
  passwordRegister as requestPasswordRegister,
} from './api';

const AUTH_QUERY_KEY = ['auth-session'] as const;

interface AuthContextValue {
  user: AuthUser | null;
  isLoading: boolean;
  error: Error | null;
  refresh: () => Promise<AuthUser | null>;
  passwordLogin: (input: PasswordLoginRequest) => Promise<AuthUser>;
  passwordRegister: (input: PasswordRegisterRequest) => Promise<AuthUser>;
  developmentLogin: () => Promise<AuthUser>;
  logout: () => Promise<void>;
  markReaderProfileCompleted: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const session = useQuery({
    queryKey: AUTH_QUERY_KEY,
    queryFn: getAuthSession,
    retry: false,
    staleTime: 30_000,
  });

  const clearPrivateQueries = useCallback(() => {
    queryClient.removeQueries({
      predicate: (query) => query.queryKey[0] !== AUTH_QUERY_KEY[0],
    });
  }, [queryClient]);

  const refresh = useCallback(async () => {
    const result = await session.refetch();
    if (result.error) throw result.error;
    return result.data?.user ?? null;
  }, [session]);

  const acceptSession = useCallback((result: AuthSessionResponse, errorMessage: string) => {
    if (!result.user) throw new Error(errorMessage);
    clearPrivateQueries();
    queryClient.setQueryData<AuthSessionResponse>(AUTH_QUERY_KEY, result);
    return result.user;
  }, [clearPrivateQueries, queryClient]);

  const passwordLogin = useCallback(async (input: PasswordLoginRequest) => (
    acceptSession(await requestPasswordLogin(input), '登录没有返回用户')
  ), [acceptSession]);

  const passwordRegister = useCallback(async (input: PasswordRegisterRequest) => (
    acceptSession(await requestPasswordRegister(input), '注册没有返回用户')
  ), [acceptSession]);

  const developmentLogin = useCallback(async () => {
    return acceptSession(await requestDevelopmentLogin(), '开发登录没有返回用户');
  }, [acceptSession]);

  const logout = useCallback(async () => {
    await requestLogout();
    clearPrivateQueries();
    queryClient.setQueryData<AuthSessionResponse>(AUTH_QUERY_KEY, { user: null });
  }, [clearPrivateQueries, queryClient]);

  const markReaderProfileCompleted = useCallback(() => {
    queryClient.setQueryData<AuthSessionResponse>(AUTH_QUERY_KEY, (current) => ({
      user: current?.user
        ? { ...current.user, readerProfileCompleted: true }
        : null,
    }));
    void queryClient.invalidateQueries({ queryKey: ['reader-profile'] });
  }, [queryClient]);

  useEffect(() => {
    const handleUnauthorized = () => {
      clearPrivateQueries();
      queryClient.setQueryData<AuthSessionResponse>(AUTH_QUERY_KEY, { user: null });
    };
    window.addEventListener('readtailor:unauthorized', handleUnauthorized);
    return () => window.removeEventListener('readtailor:unauthorized', handleUnauthorized);
  }, [clearPrivateQueries, queryClient]);

  const error = session.error instanceof Error ? session.error : null;
  return (
    <AuthContext.Provider value={{
      user: session.data?.user ?? null,
      isLoading: session.isPending,
      error,
      refresh,
      passwordLogin,
      passwordRegister,
      developmentLogin,
      logout,
      markReaderProfileCompleted,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}
