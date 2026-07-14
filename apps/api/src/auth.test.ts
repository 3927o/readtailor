import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  AuthError,
  createAuthService,
  hashPassword,
  normalizeEmail,
  verifyPassword,
  type AuthRepository,
  type AuthUser,
  type GoogleIdentity,
} from './auth';

const STATE_SECRET = 'test-oauth-state-secret-that-is-at-least-32-bytes';
const GOOGLE = {
  clientId: 'google-client-id',
  clientSecret: 'google-client-secret',
  redirectUri: 'http://localhost:3001/v1/auth/google/callback',
};

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hashBase64Url(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function user(overrides: Partial<AuthUser & { disabledAt: Date | null }> = {}) {
  return {
    id: 'a3bb189e-8bf9-3888-9912-ace4e6543002',
    email: null,
    displayName: 'Reader',
    avatarUrl: null,
    readerProfileCompletedAt: null,
    disabledAt: null,
    ...overrides,
  };
}

function fakeRepository(overrides: Partial<AuthRepository> = {}): AuthRepository {
  return {
    async upsertIdentity() { return user(); },
    async createPasswordIdentity() { return user(); },
    async findPasswordIdentity() { return null; },
    async recordSuccessfulLogin() {},
    async createSession() {},
    async findSession() { return null; },
    async touchSession() {},
    async revokeSession() {},
    ...overrides,
  };
}

function createService(input: {
  repository?: AuthRepository;
  now?: () => Date;
  fetch?: typeof globalThis.fetch;
  verifyGoogleIdToken?: (
    idToken: string,
    input: { clientId: string; nonce: string; jwksEndpoint: string },
  ) => Promise<GoogleIdentity>;
  developmentLoginEnabled?: boolean;
  hashPassword?: (password: string) => Promise<string>;
  verifyPassword?: (password: string, encodedHash: string) => Promise<boolean>;
} = {}) {
  return createAuthService({
    repository: input.repository ?? fakeRepository(),
    google: GOOGLE,
    oauthStateSecret: STATE_SECRET,
    ...(input.now ? { now: input.now } : {}),
    ...(input.fetch ? { fetch: input.fetch } : {}),
    ...(input.verifyGoogleIdToken ? { verifyGoogleIdToken: input.verifyGoogleIdToken } : {}),
    ...(input.hashPassword ? { hashPassword: input.hashPassword } : {}),
    ...(input.verifyPassword ? { verifyPassword: input.verifyPassword } : {}),
    ...(input.developmentLoginEnabled !== undefined
      ? { developmentLoginEnabled: input.developmentLoginEnabled }
      : {}),
  });
}

describe('password authentication', () => {
  it('normalizes email addresses consistently', () => {
    expect(normalizeEmail('  Reader@EXAMPLE.COM ')).toBe('reader@example.com');
    expect(normalizeEmail('ＲＥＡＤＥＲ@example.com')).toBe('reader@example.com');
  });

  it('hashes passwords with a random salt and verifies them', async () => {
    const first = await hashPassword('correct horse battery staple');
    const second = await hashPassword('correct horse battery staple');

    expect(first).toMatch(/^scrypt\$1\$32768\$8\$1\$/);
    expect(first).not.toContain('correct horse battery staple');
    expect(first).not.toBe(second);
    await expect(verifyPassword('correct horse battery staple', first)).resolves.toBe(true);
    await expect(verifyPassword('wrong password', first)).resolves.toBe(false);
  });

  it('registers a normalized password identity and stores only the encoded hash', async () => {
    const createPasswordIdentity = vi.fn<AuthRepository['createPasswordIdentity']>(async (input) => (
      user({ email: input.email, displayName: input.displayName })
    ));
    const createSession = vi.fn<AuthRepository['createSession']>();
    const hashPassword = vi.fn(async () => 'encoded-password-hash');
    const service = createService({
      repository: fakeRepository({ createPasswordIdentity, createSession }),
      hashPassword,
    });

    const result = await service.registerWithPassword({
      displayName: '  New   Reader  ',
      email: '  READER@Example.com ',
      password: 'correct horse battery staple',
    });

    expect(hashPassword).toHaveBeenCalledWith('correct horse battery staple');
    expect(createPasswordIdentity).toHaveBeenCalledWith({
      displayName: 'New Reader',
      email: 'reader@example.com',
      passwordHash: 'encoded-password-hash',
    }, expect.any(Date));
    expect(createPasswordIdentity.mock.calls[0]?.[0]).not.toEqual(
      expect.objectContaining({ password: 'correct horse battery staple' }),
    );
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
      userId: result.user.id,
      tokenHash: hash(result.sessionToken),
    }));
  });

  it('rejects invalid registration fields before writing an identity', async () => {
    const createPasswordIdentity = vi.fn<AuthRepository['createPasswordIdentity']>();
    const hashPassword = vi.fn(async () => 'encoded-password-hash');
    const service = createService({
      repository: fakeRepository({ createPasswordIdentity }),
      hashPassword,
    });

    await expect(service.registerWithPassword({
      displayName: 'Reader',
      email: 'not-an-email',
      password: 'correct horse battery staple',
    })).rejects.toMatchObject({ code: 'invalid_email', statusCode: 400 });
    await expect(service.registerWithPassword({
      displayName: 'Reader',
      email: 'reader@example.com',
      password: 'too-short',
    })).rejects.toMatchObject({ code: 'invalid_password', statusCode: 400 });
    await expect(service.registerWithPassword({
      displayName: '   ',
      email: 'reader@example.com',
      password: 'correct horse battery staple',
    })).rejects.toMatchObject({ code: 'invalid_display_name', statusCode: 400 });
    expect(createPasswordIdentity).not.toHaveBeenCalled();
  });

  it('logs in with a password, records the login, and creates a fresh session', async () => {
    const recordSuccessfulLogin = vi.fn<AuthRepository['recordSuccessfulLogin']>();
    const createSession = vi.fn<AuthRepository['createSession']>();
    const verifyPassword = vi.fn(async () => true);
    const repository = fakeRepository({
      async findPasswordIdentity(email) {
        expect(email).toBe('reader@example.com');
        return {
          user: user({ email }),
          passwordHash: 'stored-password-hash',
          disabledAt: null,
        };
      },
      recordSuccessfulLogin,
      createSession,
    });
    const service = createService({ repository, verifyPassword });

    const result = await service.loginWithPassword({
      email: ' READER@example.com ',
      password: 'supplied-password',
    });

    expect(verifyPassword).toHaveBeenCalledWith('supplied-password', 'stored-password-hash');
    expect(recordSuccessfulLogin).toHaveBeenCalledWith(result.user.id, expect.any(Date));
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
      userId: result.user.id,
      tokenHash: hash(result.sessionToken),
    }));
  });

  it('uses the same error and still verifies a hash for unknown emails and wrong passwords', async () => {
    const verifyUnknown = vi.fn(async () => false);
    const unknownService = createService({ verifyPassword: verifyUnknown });
    await expect(unknownService.loginWithPassword({
      email: 'missing@example.com',
      password: 'wrong',
    })).rejects.toMatchObject({ code: 'invalid_credentials', statusCode: 401 });
    expect(verifyUnknown).toHaveBeenCalledWith('wrong', expect.stringMatching(/^scrypt\$/));

    const verifyWrong = vi.fn(async () => false);
    const wrongService = createService({
      repository: fakeRepository({
        async findPasswordIdentity(email) {
          return {
            user: user({ email }),
            passwordHash: 'stored-password-hash',
            disabledAt: null,
          };
        },
      }),
      verifyPassword: verifyWrong,
    });
    await expect(wrongService.loginWithPassword({
      email: 'reader@example.com',
      password: 'wrong',
    })).rejects.toMatchObject({ code: 'invalid_credentials', statusCode: 401 });
    expect(verifyWrong).toHaveBeenCalledWith('wrong', 'stored-password-hash');
  });

  it('refuses a disabled password account after verifying its password', async () => {
    const verifyPassword = vi.fn(async () => true);
    const recordSuccessfulLogin = vi.fn<AuthRepository['recordSuccessfulLogin']>();
    const service = createService({
      repository: fakeRepository({
        async findPasswordIdentity(email) {
          return {
            user: user({ email }),
            passwordHash: 'stored-password-hash',
            disabledAt: new Date('2026-07-13T00:00:00.000Z'),
          };
        },
        recordSuccessfulLogin,
      }),
      verifyPassword,
    });

    await expect(service.loginWithPassword({
      email: 'reader@example.com',
      password: 'correct-password',
    })).rejects.toMatchObject({ code: 'account_disabled', statusCode: 403 });
    expect(verifyPassword).toHaveBeenCalledOnce();
    expect(recordSuccessfulLogin).not.toHaveBeenCalled();
  });
});

describe('Google OAuth', () => {
  it('creates a signed state cookie and an authorization URL with PKCE and nonce', () => {
    const service = createService();
    const start = service.beginGoogleLogin();
    const url = new URL(start.authorizationUrl);

    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe(GOOGLE.clientId);
    expect(url.searchParams.get('redirect_uri')).toBe(GOOGLE.redirectUri);
    expect(url.searchParams.get('scope')).toBe('openid email profile');
    expect(url.searchParams.get('state')).toHaveLength(43);
    expect(url.searchParams.get('nonce')).toHaveLength(43);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toHaveLength(43);
    expect(start.stateCookie.split('.')).toHaveLength(2);
    expect(start.stateCookieMaxAgeSeconds).toBe(600);
  });

  it('rejects a tampered OAuth state cookie before exchanging the code', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const service = createService({ fetch });
    const start = service.beginGoogleLogin();
    const state = new URL(start.authorizationUrl).searchParams.get('state')!;

    await expect(service.completeGoogleLogin({
      code: 'authorization-code',
      state,
      stateCookie: `${start.stateCookie}tampered`,
    })).rejects.toMatchObject({ code: 'invalid_oauth_state', statusCode: 400 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects expired OAuth state', async () => {
    let current = new Date('2026-07-14T00:00:00.000Z');
    const service = createService({ now: () => current });
    const start = service.beginGoogleLogin();
    const state = new URL(start.authorizationUrl).searchParams.get('state')!;
    current = new Date('2026-07-14T00:11:00.000Z');

    await expect(service.completeGoogleLogin({
      code: 'authorization-code',
      state,
      stateCookie: start.stateCookie,
    })).rejects.toMatchObject({ code: 'expired_oauth_state' });
  });

  it('exchanges the code with the original verifier and stores only a session token hash', async () => {
    let storedTokenHash = '';
    const repository = fakeRepository({
      async upsertIdentity(identity) {
        expect(identity).toMatchObject({
          provider: 'google',
          subject: 'google-subject',
          email: 'reader@example.com',
          emailVerified: true,
        });
        return user({ email: identity.email });
      },
      async createSession(input) {
        storedTokenHash = input.tokenHash;
      },
    });
    let tokenRequestBody: URLSearchParams | undefined;
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      tokenRequestBody = init?.body as URLSearchParams;
      return new Response(JSON.stringify({ id_token: 'signed-google-id-token' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const verifyGoogleIdToken = vi.fn(async (_token: string, input: {
      clientId: string;
      nonce: string;
      jwksEndpoint: string;
    }) => {
      expect(input.clientId).toBe(GOOGLE.clientId);
      expect(input.nonce).toHaveLength(43);
      return {
        subject: 'google-subject',
        email: 'reader@example.com',
        emailVerified: true,
        displayName: 'Reader',
        avatarUrl: 'https://example.com/avatar.png',
      };
    });
    const service = createService({ repository, fetch, verifyGoogleIdToken });
    const start = service.beginGoogleLogin();
    const url = new URL(start.authorizationUrl);
    const result = await service.completeGoogleLogin({
      code: 'authorization-code',
      state: url.searchParams.get('state')!,
      stateCookie: start.stateCookie,
    });

    expect(fetch).toHaveBeenCalledOnce();
    expect(tokenRequestBody?.get('code')).toBe('authorization-code');
    expect(tokenRequestBody?.get('client_secret')).toBe(GOOGLE.clientSecret);
    const verifier = tokenRequestBody?.get('code_verifier');
    expect(verifier).toHaveLength(86);
    expect(hashBase64Url(verifier!)).toBe(url.searchParams.get('code_challenge'));
    expect(verifyGoogleIdToken).toHaveBeenCalledWith(
      'signed-google-id-token',
      expect.objectContaining({ nonce: url.searchParams.get('nonce') }),
    );
    expect(result.sessionToken).toHaveLength(43);
    expect(result.user.email).toBe('reader@example.com');
    expect(storedTokenHash).toBe(hash(result.sessionToken));
    expect(storedTokenHash).not.toBe(result.sessionToken);
  });
});

describe('server sessions', () => {
  it('authenticates an active session and periodically updates lastSeenAt', async () => {
    const checkedAt = new Date('2026-07-14T00:10:00.000Z');
    let lookedUpHash = '';
    let touchedHash = '';
    const repository = fakeRepository({
      async findSession(tokenHash) {
        lookedUpHash = tokenHash;
        return {
          user: user(),
          expiresAt: new Date('2026-08-14T00:00:00.000Z'),
          lastSeenAt: new Date('2026-07-14T00:00:00.000Z'),
          disabledAt: null,
        };
      },
      async touchSession(tokenHash) { touchedHash = tokenHash; },
    });
    const service = createService({ repository, now: () => checkedAt });

    await expect(service.authenticateSession('raw-session-token')).resolves.toMatchObject({
      user: { displayName: 'Reader' },
    });
    expect(lookedUpHash).toBe(hash('raw-session-token'));
    expect(touchedHash).toBe(lookedUpHash);
  });

  it('refuses a session belonging to a disabled user', async () => {
    const repository = fakeRepository({
      async findSession() {
        return {
          user: user(),
          expiresAt: new Date('2026-08-14T00:00:00.000Z'),
          lastSeenAt: new Date('2026-07-14T00:00:00.000Z'),
          disabledAt: new Date('2026-07-13T00:00:00.000Z'),
        };
      },
    });
    const service = createService({ repository });

    await expect(service.authenticateSession('raw-session-token')).resolves.toBeNull();
  });

  it('hashes a session token before revoking it and treats missing tokens as a no-op', async () => {
    const revokeSession = vi.fn<AuthRepository['revokeSession']>();
    const service = createService({ repository: fakeRepository({ revokeSession }) });

    await service.logout(undefined);
    await service.logout('raw-session-token');

    expect(revokeSession).toHaveBeenCalledOnce();
    expect(revokeSession).toHaveBeenCalledWith(hash('raw-session-token'), expect.any(Date));
  });
});

describe('development login', () => {
  it('is unavailable unless explicitly enabled', async () => {
    const service = createService();
    await expect(service.developmentLogin()).rejects.toBeInstanceOf(AuthError);
    await expect(service.developmentLogin()).rejects.toMatchObject({
      code: 'development_login_disabled',
      statusCode: 403,
    });
  });

  it('creates a real server session when enabled', async () => {
    const upsertIdentity = vi.fn<AuthRepository['upsertIdentity']>(async () => user());
    const createSession = vi.fn<AuthRepository['createSession']>();
    const service = createService({
      developmentLoginEnabled: true,
      repository: fakeRepository({ upsertIdentity, createSession }),
    });

    const result = await service.developmentLogin();

    expect(upsertIdentity).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'development',
        subject: 'readtailor-project-owner',
      }),
      expect.any(Date),
    );
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
      userId: result.user.id,
      tokenHash: hash(result.sessionToken),
    }));
  });
});

describe('configuration', () => {
  it('requires a strong OAuth state signing secret', () => {
    expect(() => createAuthService({
      repository: fakeRepository(),
      oauthStateSecret: 'too-short',
    })).toThrow('at least 32 bytes');
  });
});
