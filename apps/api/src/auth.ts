import {
  createHash,
  createHmac,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import {
  authIdentities,
  authPasswordCredentials,
  authSessions,
  readerProfiles,
  users,
  type Database,
} from '@readtailor/database';

export const AUTH_SESSION_COOKIE = 'readtailor_session';
export const GOOGLE_OAUTH_STATE_COOKIE = 'readtailor_google_oauth';

const GOOGLE_AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_JWKS_ENDPOINT = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_SESSION_TOUCH_INTERVAL_MS = 5 * 60 * 1000;
const PASSWORD_SCRYPT_N = 32_768;
const PASSWORD_SCRYPT_R = 8;
const PASSWORD_SCRYPT_P = 1;
const PASSWORD_SCRYPT_KEY_LENGTH = 64;
const PASSWORD_SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;
const DUMMY_PASSWORD_HASH = 'scrypt$1$32768$8$1$cmVhZHRhaWxvci1kdW1teSE$sY8muDidotoofRjR1y9LnzlKEs6Hs_NVtrzzqTwFK7FglgA14CtZYTvmuNL45H8v8e5XTvRh3WwsKBtWlCPkAA';

export interface AuthUser {
  id: string;
  email: string | null;
  displayName: string;
  avatarUrl: string | null;
  readerProfileCompletedAt: Date | null;
}

export interface AuthenticatedSession {
  user: AuthUser;
  expiresAt: Date;
}

export interface LoginResult extends AuthenticatedSession {
  sessionToken: string;
}

export interface PasswordRegisterInput {
  displayName: string;
  email: string;
  password: string;
}

export interface PasswordLoginInput {
  email: string;
  password: string;
}

export interface GoogleLoginStart {
  authorizationUrl: string;
  stateCookie: string;
  stateCookieMaxAgeSeconds: number;
}

export interface GoogleLoginCompletion {
  code: string;
  state: string;
  stateCookie: string;
}

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  jwksEndpoint?: string;
}

export interface GoogleIdentity {
  subject: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string;
  avatarUrl: string | null;
}

interface StoredSession {
  user: AuthUser;
  expiresAt: Date;
  lastSeenAt: Date;
  disabledAt: Date | null;
}

interface IdentityInput extends GoogleIdentity {
  provider: 'google' | 'development';
}

interface CreatePasswordIdentityInput {
  displayName: string;
  email: string;
  passwordHash: string;
}

interface StoredPasswordIdentity {
  user: AuthUser;
  passwordHash: string;
  disabledAt: Date | null;
}

interface CreateSessionInput {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  now: Date;
}

export interface AuthRepository {
  upsertIdentity(input: IdentityInput, now: Date): Promise<AuthUser & { disabledAt: Date | null }>;
  createPasswordIdentity(
    input: CreatePasswordIdentityInput,
    now: Date,
  ): Promise<AuthUser & { disabledAt: Date | null }>;
  findPasswordIdentity(email: string): Promise<StoredPasswordIdentity | null>;
  recordSuccessfulLogin(userId: string, now: Date): Promise<void>;
  createSession(input: CreateSessionInput): Promise<void>;
  findSession(tokenHash: string, now: Date): Promise<StoredSession | null>;
  touchSession(tokenHash: string, now: Date): Promise<void>;
  revokeSession(tokenHash: string, now: Date): Promise<void>;
}

export interface AuthService {
  authenticateSession(sessionToken: string | null | undefined): Promise<AuthenticatedSession | null>;
  beginGoogleLogin(): GoogleLoginStart;
  completeGoogleLogin(input: GoogleLoginCompletion): Promise<LoginResult>;
  registerWithPassword(input: PasswordRegisterInput): Promise<LoginResult>;
  loginWithPassword(input: PasswordLoginInput): Promise<LoginResult>;
  developmentLogin(): Promise<LoginResult>;
  logout(sessionToken: string | null | undefined): Promise<void>;
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 401 | 403 | 409 | 502 | 503,
    readonly code: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export interface CreateAuthServiceOptions {
  db?: Database;
  repository?: AuthRepository;
  google?: GoogleOAuthConfig;
  oauthStateSecret: string;
  developmentLoginEnabled?: boolean;
  developmentSubject?: string;
  developmentDisplayName?: string;
  sessionTtlMs?: number;
  oauthStateTtlMs?: number;
  sessionTouchIntervalMs?: number;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  verifyGoogleIdToken?: (
    idToken: string,
    input: { clientId: string; nonce: string; jwksEndpoint: string },
  ) => Promise<GoogleIdentity>;
  hashPassword?: (password: string) => Promise<string>;
  verifyPassword?: (password: string, encodedHash: string) => Promise<boolean>;
}

interface OAuthStatePayload {
  state: string;
  codeVerifier: string;
  nonce: string;
  expiresAt: number;
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sha256Base64Url(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function signState(payload: OAuthStatePayload, secret: string): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function verifyState(cookie: string, secret: string, now: Date): OAuthStatePayload {
  const [encoded, signature, extra] = cookie.split('.');
  if (!encoded || !signature || extra !== undefined) {
    throw new AuthError('Google 登录状态无效，请重新开始登录', 400, 'invalid_oauth_state');
  }
  const expected = createHmac('sha256', secret).update(encoded).digest('base64url');
  if (!safeEqual(signature, expected)) {
    throw new AuthError('Google 登录状态无效，请重新开始登录', 400, 'invalid_oauth_state');
  }

  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new AuthError('Google 登录状态无效，请重新开始登录', 400, 'invalid_oauth_state');
  }
  const payload = value as Partial<OAuthStatePayload>;
  if (
    typeof payload.state !== 'string'
    || typeof payload.codeVerifier !== 'string'
    || typeof payload.nonce !== 'string'
    || typeof payload.expiresAt !== 'number'
    || payload.state.length < 32
    || payload.codeVerifier.length < 43
    || payload.nonce.length < 32
  ) {
    throw new AuthError('Google 登录状态无效，请重新开始登录', 400, 'invalid_oauth_state');
  }
  if (payload.expiresAt <= now.getTime()) {
    throw new AuthError('Google 登录已过期，请重新开始登录', 400, 'expired_oauth_state');
  }
  return payload as OAuthStatePayload;
}

function cleanDisplayName(value: string, fallback: string): string {
  const cleaned = value.trim().replace(/\s+/g, ' ').slice(0, 200);
  return cleaned || fallback;
}

export function normalizeEmail(value: string): string {
  return value.trim().normalize('NFKC').toLowerCase();
}

function validEmail(value: string): boolean {
  return value.length >= 3
    && value.length <= 254
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
}

function derivePasswordKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      PASSWORD_SCRYPT_KEY_LENGTH,
      {
        N: PASSWORD_SCRYPT_N,
        r: PASSWORD_SCRYPT_R,
        p: PASSWORD_SCRYPT_P,
        maxmem: PASSWORD_SCRYPT_MAX_MEMORY,
      },
      (error, key) => {
        if (error) reject(error);
        else resolve(key);
      },
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derivePasswordKey(password, salt);
  return [
    'scrypt',
    '1',
    String(PASSWORD_SCRYPT_N),
    String(PASSWORD_SCRYPT_R),
    String(PASSWORD_SCRYPT_P),
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}

export async function verifyPassword(password: string, encodedHash: string): Promise<boolean> {
  const [algorithm, version, n, r, p, encodedSalt, encodedKey, extra] = encodedHash.split('$');
  if (
    algorithm !== 'scrypt'
    || version !== '1'
    || n !== String(PASSWORD_SCRYPT_N)
    || r !== String(PASSWORD_SCRYPT_R)
    || p !== String(PASSWORD_SCRYPT_P)
    || !encodedSalt
    || !encodedKey
    || extra !== undefined
  ) {
    return false;
  }
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(encodedSalt, 'base64url');
    expected = Buffer.from(encodedKey, 'base64url');
  } catch {
    return false;
  }
  if (salt.length < 16 || expected.length !== PASSWORD_SCRYPT_KEY_LENGTH) return false;
  const actual = await derivePasswordKey(password, salt);
  return timingSafeEqual(actual, expected);
}

function authUser(row: typeof users.$inferSelect, email: string | null): AuthUser {
  return {
    id: row.id,
    email,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
    readerProfileCompletedAt: row.readerProfileCompletedAt,
  };
}

export function createDatabaseAuthRepository(db: Database): AuthRepository {
  return {
    async upsertIdentity(input, now) {
      return db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`${input.provider}:${input.subject}`}))`,
        );
        const [existing] = await tx
          .select({ user: users })
          .from(authIdentities)
          .innerJoin(users, eq(users.id, authIdentities.userId))
          .where(
            and(
              eq(authIdentities.provider, input.provider),
              eq(authIdentities.providerSubject, input.subject),
            ),
          )
          .limit(1);

        if (existing) {
          await Promise.all([
            tx
              .update(authIdentities)
              .set({
                email: input.email,
                emailVerified: input.emailVerified,
                updatedAt: now,
              })
              .where(
                and(
                  eq(authIdentities.provider, input.provider),
                  eq(authIdentities.providerSubject, input.subject),
                ),
              ),
            tx
              .update(users)
              .set({
                displayName: input.displayName,
                avatarUrl: input.avatarUrl,
                lastLoginAt: now,
                updatedAt: now,
              })
              .where(eq(users.id, existing.user.id)),
          ]);
          return {
            ...authUser({
              ...existing.user,
              displayName: input.displayName,
              avatarUrl: input.avatarUrl,
              lastLoginAt: now,
              updatedAt: now,
            }, input.email),
            disabledAt: existing.user.disabledAt,
          };
        }

        const [created] = await tx
          .insert(users)
          .values({
            displayName: input.displayName,
            avatarUrl: input.avatarUrl,
            lastLoginAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        if (!created) {
          throw new AuthError('用户创建失败', 503, 'user_creation_failed');
        }
        await tx.insert(authIdentities).values({
          userId: created.id,
          provider: input.provider,
          providerSubject: input.subject,
          email: input.email,
          emailVerified: input.emailVerified,
          createdAt: now,
          updatedAt: now,
        });
        await tx
          .insert(readerProfiles)
          .values({ userId: created.id, createdAt: now, updatedAt: now })
          .onConflictDoNothing({ target: readerProfiles.userId });
        return { ...authUser(created, input.email), disabledAt: created.disabledAt };
      });
    },

    async createPasswordIdentity(input, now) {
      return db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`password:${input.email}`}))`,
        );
        const [existing] = await tx
          .select({ id: authIdentities.id })
          .from(authIdentities)
          .where(
            and(
              eq(authIdentities.provider, 'password'),
              eq(authIdentities.providerSubject, input.email),
            ),
          )
          .limit(1);
        if (existing) {
          throw new AuthError('该邮箱已注册', 409, 'email_already_registered');
        }

        const [created] = await tx
          .insert(users)
          .values({
            displayName: input.displayName,
            avatarUrl: null,
            lastLoginAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        if (!created) {
          throw new AuthError('用户创建失败', 503, 'user_creation_failed');
        }
        const [identity] = await tx
          .insert(authIdentities)
          .values({
            userId: created.id,
            provider: 'password',
            providerSubject: input.email,
            email: input.email,
            emailVerified: false,
            createdAt: now,
            updatedAt: now,
          })
          .returning({ id: authIdentities.id });
        if (!identity) {
          throw new AuthError('用户创建失败', 503, 'identity_creation_failed');
        }
        await Promise.all([
          tx.insert(authPasswordCredentials).values({
            identityId: identity.id,
            passwordHash: input.passwordHash,
            createdAt: now,
            updatedAt: now,
          }),
          tx
            .insert(readerProfiles)
            .values({ userId: created.id, createdAt: now, updatedAt: now })
            .onConflictDoNothing({ target: readerProfiles.userId }),
        ]);
        return { ...authUser(created, input.email), disabledAt: created.disabledAt };
      });
    },

    async findPasswordIdentity(email) {
      const [row] = await db
        .select({
          user: users,
          identity: authIdentities,
          credential: authPasswordCredentials,
        })
        .from(authIdentities)
        .innerJoin(users, eq(users.id, authIdentities.userId))
        .innerJoin(
          authPasswordCredentials,
          eq(authPasswordCredentials.identityId, authIdentities.id),
        )
        .where(
          and(
            eq(authIdentities.provider, 'password'),
            eq(authIdentities.providerSubject, email),
          ),
        )
        .limit(1);
      return row
        ? {
            user: authUser(row.user, row.identity.email),
            passwordHash: row.credential.passwordHash,
            disabledAt: row.user.disabledAt,
          }
        : null;
    },

    async recordSuccessfulLogin(userId, now) {
      await db
        .update(users)
        .set({ lastLoginAt: now, updatedAt: now })
        .where(eq(users.id, userId));
    },

    async createSession(input) {
      await db.insert(authSessions).values({
        userId: input.userId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
        lastSeenAt: input.now,
        createdAt: input.now,
      });
    },

    async findSession(tokenHash, now) {
      const [row] = await db
        .select({ session: authSessions, user: users, identity: authIdentities })
        .from(authSessions)
        .innerJoin(users, eq(users.id, authSessions.userId))
        .leftJoin(authIdentities, eq(authIdentities.userId, users.id))
        .where(
          and(
            eq(authSessions.tokenHash, tokenHash),
            isNull(authSessions.revokedAt),
            gt(authSessions.expiresAt, now),
          ),
        )
        .limit(1);
      return row
        ? {
            user: authUser(row.user, row.identity?.email ?? null),
            expiresAt: row.session.expiresAt,
            lastSeenAt: row.session.lastSeenAt,
            disabledAt: row.user.disabledAt,
          }
        : null;
    },

    async touchSession(tokenHash, now) {
      await db
        .update(authSessions)
        .set({ lastSeenAt: now })
        .where(and(eq(authSessions.tokenHash, tokenHash), isNull(authSessions.revokedAt)));
    },

    async revokeSession(tokenHash, now) {
      await db
        .update(authSessions)
        .set({ revokedAt: now })
        .where(and(eq(authSessions.tokenHash, tokenHash), isNull(authSessions.revokedAt)));
    },
  };
}

export function createAuthService(options: CreateAuthServiceOptions): AuthService {
  if (Buffer.byteLength(options.oauthStateSecret) < 32) {
    throw new Error('oauthStateSecret must contain at least 32 bytes');
  }
  if (!options.repository && !options.db) {
    throw new Error('createAuthService requires db or repository');
  }

  const repository = options.repository ?? createDatabaseAuthRepository(options.db!);
  const now = options.now ?? (() => new Date());
  const sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const oauthStateTtlMs = options.oauthStateTtlMs ?? DEFAULT_OAUTH_STATE_TTL_MS;
  const touchIntervalMs = options.sessionTouchIntervalMs ?? DEFAULT_SESSION_TOUCH_INTERVAL_MS;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const hashPasswordImpl = options.hashPassword ?? hashPassword;
  const verifyPasswordImpl = options.verifyPassword ?? verifyPassword;

  const createSession = async (user: AuthUser): Promise<LoginResult> => {
    const issuedAt = now();
    const sessionToken = base64Url(randomBytes(32));
    const expiresAt = new Date(issuedAt.getTime() + sessionTtlMs);
    await repository.createSession({
      userId: user.id,
      tokenHash: sha256(sessionToken),
      expiresAt,
      now: issuedAt,
    });
    return { user, sessionToken, expiresAt };
  };

  const requireGoogle = (): GoogleOAuthConfig => {
    if (!options.google) {
      throw new AuthError('Google 登录尚未配置', 503, 'google_oauth_unavailable');
    }
    return options.google;
  };

  const verifyGoogleIdToken = options.verifyGoogleIdToken ?? (async (
    idToken: string,
    input: { clientId: string; nonce: string; jwksEndpoint: string },
  ): Promise<GoogleIdentity> => {
    const jwks = createRemoteJWKSet(new URL(input.jwksEndpoint));
    const { payload } = await jwtVerify(idToken, jwks, {
      audience: input.clientId,
      issuer: GOOGLE_ISSUERS,
    });
    if (typeof payload.sub !== 'string' || !payload.sub) {
      throw new AuthError('Google 身份缺少用户标识', 401, 'invalid_google_identity');
    }
    if (typeof payload.nonce !== 'string' || !safeEqual(payload.nonce, input.nonce)) {
      throw new AuthError('Google 登录 nonce 校验失败', 401, 'invalid_google_nonce');
    }
    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : null;
    const emailVerified = payload.email_verified === true;
    if (!email || !emailVerified) {
      throw new AuthError('Google 账户邮箱尚未验证', 403, 'unverified_google_email');
    }
    const fallbackName = email.split('@')[0] || 'ReadTailor User';
    return {
      subject: payload.sub,
      email,
      emailVerified,
      displayName: cleanDisplayName(typeof payload.name === 'string' ? payload.name : '', fallbackName),
      avatarUrl: typeof payload.picture === 'string' ? payload.picture : null,
    };
  });

  return {
    async authenticateSession(sessionToken) {
      if (!sessionToken) return null;
      const tokenHash = sha256(sessionToken);
      const checkedAt = now();
      const session = await repository.findSession(tokenHash, checkedAt);
      if (!session || session.disabledAt) return null;
      if (checkedAt.getTime() - session.lastSeenAt.getTime() >= touchIntervalMs) {
        await repository.touchSession(tokenHash, checkedAt);
      }
      return { user: session.user, expiresAt: session.expiresAt };
    },

    beginGoogleLogin() {
      const google = requireGoogle();
      const state = base64Url(randomBytes(32));
      const codeVerifier = base64Url(randomBytes(64));
      const nonce = base64Url(randomBytes(32));
      const stateCookie = signState(
        {
          state,
          codeVerifier,
          nonce,
          expiresAt: now().getTime() + oauthStateTtlMs,
        },
        options.oauthStateSecret,
      );
      const authorizationUrl = new URL(
        google.authorizationEndpoint ?? GOOGLE_AUTHORIZATION_ENDPOINT,
      );
      authorizationUrl.search = new URLSearchParams({
        client_id: google.clientId,
        redirect_uri: google.redirectUri,
        response_type: 'code',
        scope: 'openid email profile',
        state,
        nonce,
        code_challenge: sha256Base64Url(codeVerifier),
        code_challenge_method: 'S256',
        prompt: 'select_account',
      }).toString();
      return {
        authorizationUrl: authorizationUrl.toString(),
        stateCookie,
        stateCookieMaxAgeSeconds: Math.ceil(oauthStateTtlMs / 1000),
      };
    },

    async completeGoogleLogin(input) {
      const google = requireGoogle();
      if (!input.code.trim() || !input.state.trim() || !input.stateCookie.trim()) {
        throw new AuthError('Google 登录回调参数不完整', 400, 'invalid_google_callback');
      }
      const oauthState = verifyState(input.stateCookie, options.oauthStateSecret, now());
      if (!safeEqual(oauthState.state, input.state)) {
        throw new AuthError('Google 登录 state 校验失败', 400, 'invalid_oauth_state');
      }

      let response: Response;
      try {
        response = await fetchImpl(google.tokenEndpoint ?? GOOGLE_TOKEN_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code: input.code,
            client_id: google.clientId,
            client_secret: google.clientSecret,
            redirect_uri: google.redirectUri,
            code_verifier: oauthState.codeVerifier,
          }),
          signal: AbortSignal.timeout(10_000),
        });
      } catch (error) {
        throw new AuthError(
          error instanceof Error ? `Google token 交换失败：${error.message}` : 'Google token 交换失败',
          502,
          'google_token_exchange_failed',
        );
      }
      if (!response.ok) {
        throw new AuthError('Google token 交换失败', 502, 'google_token_exchange_failed');
      }
      const tokenResponse = await response.json() as { id_token?: unknown };
      if (typeof tokenResponse.id_token !== 'string') {
        throw new AuthError('Google 未返回身份令牌', 502, 'missing_google_id_token');
      }
      let identity: GoogleIdentity;
      try {
        identity = await verifyGoogleIdToken(tokenResponse.id_token, {
          clientId: google.clientId,
          nonce: oauthState.nonce,
          jwksEndpoint: google.jwksEndpoint ?? GOOGLE_JWKS_ENDPOINT,
        });
      } catch (error) {
        if (error instanceof AuthError) throw error;
        throw new AuthError('Google 身份令牌校验失败', 401, 'invalid_google_id_token');
      }
      const user = await repository.upsertIdentity({ ...identity, provider: 'google' }, now());
      if (user.disabledAt) {
        throw new AuthError('账户已停用', 403, 'account_disabled');
      }
      return createSession(user);
    },

    async registerWithPassword(input) {
      const email = normalizeEmail(input.email);
      if (!validEmail(email)) {
        throw new AuthError('请输入有效的邮箱地址', 400, 'invalid_email');
      }
      if (input.password.length < 10 || input.password.length > 128) {
        throw new AuthError('密码长度需要为 10 到 128 个字符', 400, 'invalid_password');
      }
      const displayName = cleanDisplayName(input.displayName, '');
      if (!displayName) {
        throw new AuthError('请输入昵称', 400, 'invalid_display_name');
      }
      const passwordHash = await hashPasswordImpl(input.password);
      const user = await repository.createPasswordIdentity(
        { email, displayName, passwordHash },
        now(),
      );
      if (user.disabledAt) {
        throw new AuthError('账户已停用', 403, 'account_disabled');
      }
      return createSession(user);
    },

    async loginWithPassword(input) {
      const email = normalizeEmail(input.email);
      const identity = validEmail(email)
        ? await repository.findPasswordIdentity(email)
        : null;
      const valid = await verifyPasswordImpl(
        input.password,
        identity?.passwordHash ?? DUMMY_PASSWORD_HASH,
      );
      if (!identity || !valid) {
        throw new AuthError('邮箱或密码错误', 401, 'invalid_credentials');
      }
      if (identity.disabledAt) {
        throw new AuthError('账户已停用', 403, 'account_disabled');
      }
      await repository.recordSuccessfulLogin(identity.user.id, now());
      return createSession(identity.user);
    },

    async developmentLogin() {
      if (!options.developmentLoginEnabled) {
        throw new AuthError('开发登录未启用', 403, 'development_login_disabled');
      }
      const subject = options.developmentSubject?.trim() || 'readtailor-project-owner';
      const displayName = cleanDisplayName(
        options.developmentDisplayName ?? 'ReadTailor Owner',
        'ReadTailor Owner',
      );
      const user = await repository.upsertIdentity(
        {
          provider: 'development',
          subject,
          email: null,
          emailVerified: false,
          displayName,
          avatarUrl: null,
        },
        now(),
      );
      if (user.disabledAt) {
        throw new AuthError('账户已停用', 403, 'account_disabled');
      }
      return createSession(user);
    },

    async logout(sessionToken) {
      if (!sessionToken) return;
      await repository.revokeSession(sha256(sessionToken), now());
    },
  };
}
