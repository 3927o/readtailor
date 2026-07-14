import { Readable } from 'node:stream';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyReply } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import {
  type DependencyStatus,
  AuthSessionResponseSchema,
  BookCatalogResponseSchema,
  BookNormalizationStatusSchema,
  AdoptTrialRequestSchema,
  AdoptTrialResponseSchema,
  ApproveStrategyRequestSchema,
  ApproveStrategyResponseSchema,
  CreateHighlightRequestSchema,
  DeleteHighlightResponseSchema,
  DevelopmentLoginRequestSchema,
  EnqueueSystemPingResponseSchema,
  ErrorResponseSchema,
  HealthResponseSchema,
  HighlightListResponseSchema,
  HighlightResponseSchema,
  ImportBookResponseSchema,
  type InterviewStreamEvent,
  InterviewStateResponseSchema,
  MarkReadNodeRequestSchema,
  MarkReadNodeResponseSchema,
  MarkTrialSegmentViewedRequestSchema,
  PasswordLoginRequestSchema,
  PasswordRegisterRequestSchema,
  ReaderBootstrapSchema,
  ReaderFocusRequestSchema,
  ReaderProfileOnboardingRequestSchema,
  ReaderProfileResponseSchema,
  ReadingSettingsResponseSchema,
  ReadingSettingsSchema,
  SharedBookSchema,
  StrategyReviewResponseSchema,
  SubmitInterviewAnswerRequestSchema,
  SubmitStrategyFeedbackRequestSchema,
  SubmitTrialFeedbackRequestSchema,
  UpdateHighlightNoteRequestSchema,
  SystemChatRequestSchema,
  SystemJobSchema,
  TrialReviewResponseSchema,
  UserBookShelfResponseSchema,
  UserBookWorkflowResponseSchema,
} from '@readtailor/contracts';
import { createLogger } from '@readtailor/observability';
import {
  AUTH_SESSION_COOKIE,
  GOOGLE_OAUTH_STATE_COOKIE,
  AuthError,
  type AuthService,
  type AuthUser,
} from './auth';
import type { ApiConfig } from './config';
import { BookImportError, type BookImportService } from './book-imports';
import type { BookService } from './books';
import type { SystemChatEvent, SystemChatService } from './system-chat';
import type { SystemJobService } from './system-jobs';
import { ProfileError, type ProfileService } from './profiles';
import { UserBookError, type UserBookService } from './user-books';

declare module 'fastify' {
  interface FastifyRequest {
    authUser: AuthUser | null;
  }
}

const UUID_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

// 冷启动首次探测要覆盖跨区 TLS 握手，超时给足 5 秒。
const HEALTH_PROBE_TIMEOUT_MS = 5000;

export type HealthProbe = () => Promise<void>;

export interface AppDeps {
  systemJobs?: SystemJobService | undefined;
  systemChat?: SystemChatService | undefined;
  healthProbes?: Record<string, HealthProbe> | undefined;
  books?: BookService | undefined;
  bookImports?: BookImportService | undefined;
  userBooks?: UserBookService | undefined;
  auth?: AuthService | undefined;
  profiles?: ProfileService | undefined;
}

const bookIdParams = Type.Object({
  id: Type.String({ pattern: UUID_PATTERN }),
});
const userBookIdParams = Type.Object({
  id: Type.String({ pattern: UUID_PATTERN }),
});
const userBookHighlightParams = Type.Object({
  id: Type.String({ pattern: UUID_PATTERN }),
  hid: Type.String({ pattern: UUID_PATTERN }),
});

function assetContentType(path: string): string {
  const extension = path.split('.').pop()?.toLowerCase();
  return (
    {
      avif: 'image/avif',
      gif: 'image/gif',
      jpeg: 'image/jpeg',
      jpg: 'image/jpeg',
      png: 'image/png',
      svg: 'image/svg+xml',
      webp: 'image/webp',
      mp3: 'audio/mpeg',
      mp4: 'video/mp4',
      ogg: 'audio/ogg',
      webm: 'video/webm',
      woff: 'font/woff',
      woff2: 'font/woff2',
    }[extension ?? ''] ?? 'application/octet-stream'
  );
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`probe timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

// Interleaves SSE keep-alive comments so a long silent gap (e.g. while finish_interview
// generates the briefing) doesn't trip idle proxy/load-balancer timeouts. A single pending
// read of the source is kept across heartbeats so no event is dropped.
async function* withHeartbeat(source: AsyncGenerator<string>, intervalMs: number): AsyncGenerator<string> {
  let pending = source.next();
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const heartbeat = new Promise<'heartbeat'>((resolve) => {
      timer = setTimeout(() => resolve('heartbeat'), intervalMs);
    });
    const winner = await Promise.race([pending.then(() => 'data' as const), heartbeat]);
    if (timer) clearTimeout(timer);
    if (winner === 'heartbeat') {
      yield ': ping\n\n';
      continue;
    }
    const result = await pending;
    if (result.done) return;
    yield result.value;
    pending = source.next();
  }
}

export async function buildApp(config: ApiConfig, deps: AppDeps = {}) {
  const app = Fastify({
    loggerInstance: createLogger(config.logLevel),
    genReqId: (request) => request.headers['x-request-id']?.toString() ?? crypto.randomUUID(),
  }).withTypeProvider<TypeBoxTypeProvider>();

  await app.register(cors, {
    origin: config.webOrigins,
    credentials: true,
    // The API historically served only GET/POST, so the default preflight advertised just those.
    // §11.6 reading-settings (PUT) and §11.7 highlights (PATCH/DELETE) are cross-origin credentialed
    // requests whose preflight must permit these methods, or the browser blocks them before sending.
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
  });
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  await app.register(multipart, {
    limits: {
      files: 1,
      fileSize: 100 * 1024 * 1024,
    },
  });
  app.decorateRequest('authUser', null);

  const cookieOptions = {
    httpOnly: true,
    secure: config.authCookieSecure,
    sameSite: 'lax' as const,
    path: '/',
  };
  const publicPaths = new Set([
    '/v1/health',
    '/v1/auth/session',
    '/v1/auth/google/start',
    '/v1/auth/google/callback',
    '/v1/auth/register',
    '/v1/auth/login',
    '/v1/auth/development',
    '/v1/auth/logout',
  ]);

  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0] ?? request.url;
    if (!path.startsWith('/v1/') || publicPaths.has(path)) return;

    if (path.startsWith('/v1/system/')) {
      const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
      if (!config.systemApiToken) {
        return reply.code(503).send({ error: 'system API is disabled' });
      }
      if (token !== config.systemApiToken) {
        return reply.code(401).send({ error: 'system API token required' });
      }
      return;
    }

    if (!deps.auth) {
      return reply.code(503).send({ error: 'authentication is not configured' });
    }
    const session = await deps.auth.authenticateSession(request.cookies[AUTH_SESSION_COOKIE]);
    if (!session) {
      return reply.code(401).send({ error: '请先登录' });
    }
    request.authUser = session.user;

    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const origin = request.headers.origin;
      if (!origin || !config.webOrigins.includes(origin)) {
        return reply.code(403).send({ error: '请求来源无效' });
      }
    }
  });

  const publicAuthUser = (user: AuthUser) => ({
    id: user.id,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    email: user.email,
    readerProfileCompleted: Boolean(user.readerProfileCompletedAt),
  });
  const setSessionCookie = (reply: FastifyReply, token: string) => {
    reply.setCookie(AUTH_SESSION_COOKIE, token, {
      ...cookieOptions,
      maxAge: config.authSessionDays * 24 * 60 * 60,
    });
  };
  const safeReturnPath = (value: unknown) =>
    typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')
      ? value.slice(0, 2000)
      : '/';
  const hasTrustedOrigin = (origin: string | undefined) =>
    Boolean(origin && config.webOrigins.includes(origin));

  app.get(
    '/v1/auth/session',
    { schema: { response: { 200: AuthSessionResponseSchema } } },
    async (request) => {
      if (!deps.auth) return { user: null };
      const session = await deps.auth.authenticateSession(request.cookies[AUTH_SESSION_COOKIE]);
      return { user: session ? publicAuthUser(session.user) : null };
    },
  );

  app.post(
    '/v1/auth/register',
    {
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        body: PasswordRegisterRequestSchema,
        response: {
          201: AuthSessionResponseSchema,
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          409: ErrorResponseSchema,
          502: ErrorResponseSchema,
          503: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (!deps.auth) return reply.code(503).send({ error: 'authentication is not configured' });
      if (!hasTrustedOrigin(request.headers.origin)) {
        return reply.code(403).send({ error: '请求来源无效' });
      }
      try {
        const result = await deps.auth.registerWithPassword(request.body);
        setSessionCookie(reply, result.sessionToken);
        return reply.code(201).send({ user: publicAuthUser(result.user) });
      } catch (error) {
        if (error instanceof AuthError) {
          return reply.code(error.statusCode).send({ error: error.message });
        }
        throw error;
      }
    },
  );

  app.post(
    '/v1/auth/login',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        body: PasswordLoginRequestSchema,
        response: {
          200: AuthSessionResponseSchema,
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          409: ErrorResponseSchema,
          502: ErrorResponseSchema,
          503: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (!deps.auth) return reply.code(503).send({ error: 'authentication is not configured' });
      if (!hasTrustedOrigin(request.headers.origin)) {
        return reply.code(403).send({ error: '请求来源无效' });
      }
      try {
        const result = await deps.auth.loginWithPassword(request.body);
        setSessionCookie(reply, result.sessionToken);
        return { user: publicAuthUser(result.user) };
      } catch (error) {
        if (error instanceof AuthError) {
          return reply.code(error.statusCode).send({ error: error.message });
        }
        throw error;
      }
    },
  );

  app.get(
    '/v1/auth/google/start',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: { querystring: Type.Object({ returnTo: Type.Optional(Type.String()) }) },
    },
    async (request, reply) => {
      if (!deps.auth) return reply.code(503).send({ error: 'Google 登录未配置' });
      try {
        const start = deps.auth.beginGoogleLogin();
        reply.setCookie(GOOGLE_OAUTH_STATE_COOKIE, start.stateCookie, {
          ...cookieOptions,
          path: '/v1/auth/google/callback',
          maxAge: start.stateCookieMaxAgeSeconds,
        });
        reply.setCookie('readtailor_auth_return_to', safeReturnPath(request.query.returnTo), {
          ...cookieOptions,
          path: '/v1/auth/google/callback',
          maxAge: start.stateCookieMaxAgeSeconds,
        });
        return reply.redirect(start.authorizationUrl);
      } catch (error) {
        if (error instanceof AuthError) {
          return reply.code(error.statusCode === 403 ? 403 : 503).send({ error: error.message });
        }
        throw error;
      }
    },
  );

  app.get(
    '/v1/auth/google/callback',
    {
      schema: {
        querystring: Type.Object({
          code: Type.Optional(Type.String()),
          state: Type.Optional(Type.String()),
          error: Type.Optional(Type.String()),
        }),
      },
    },
    async (request, reply) => {
      if (!deps.auth) return reply.code(503).send({ error: 'Google 登录未配置' });
      if (request.query.error) return reply.redirect(`${config.webBaseUrl}/login?error=google_denied`);
      if (!request.query.code || !request.query.state) {
        return reply.code(400).send({ error: 'Google 登录回调缺少必要参数' });
      }
      try {
        const result = await deps.auth.completeGoogleLogin({
          code: request.query.code,
          state: request.query.state,
          stateCookie: request.cookies[GOOGLE_OAUTH_STATE_COOKIE] ?? '',
        });
        setSessionCookie(reply, result.sessionToken);
        const returnTo = result.user.readerProfileCompletedAt
          ? safeReturnPath(request.cookies.readtailor_auth_return_to)
          : '/onboarding';
        reply.clearCookie(GOOGLE_OAUTH_STATE_COOKIE, { path: '/v1/auth/google/callback' });
        reply.clearCookie('readtailor_auth_return_to', { path: '/v1/auth/google/callback' });
        return reply.redirect(`${config.webBaseUrl}${returnTo}`);
      } catch (error) {
        if (error instanceof AuthError) {
          request.log.warn({ code: error.code }, 'Google login failed');
          return reply.redirect(`${config.webBaseUrl}/login?error=${encodeURIComponent(error.code)}`);
        }
        throw error;
      }
    },
  );

  app.post(
    '/v1/auth/development',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        body: DevelopmentLoginRequestSchema,
        response: { 200: AuthSessionResponseSchema, 403: ErrorResponseSchema, 503: ErrorResponseSchema },
      },
    },
    async (request, reply) => {
      if (!deps.auth) return reply.code(503).send({ error: 'authentication is not configured' });
      if (!hasTrustedOrigin(request.headers.origin)) {
        return reply.code(403).send({ error: '请求来源无效' });
      }
      try {
        const result = await deps.auth.developmentLogin();
        setSessionCookie(reply, result.sessionToken);
        return { user: publicAuthUser(result.user) };
      } catch (error) {
        if (error instanceof AuthError) {
          return reply.code(error.statusCode === 403 ? 403 : 503).send({ error: error.message });
        }
        throw error;
      }
    },
  );

  app.post('/v1/auth/logout', async (request, reply) => {
    if (!hasTrustedOrigin(request.headers.origin)) {
      return reply.code(403).send({ error: '请求来源无效' });
    }
    await deps.auth?.logout(request.cookies[AUTH_SESSION_COOKIE]);
    reply.clearCookie(AUTH_SESSION_COOKIE, cookieOptions);
    return reply.code(204).send();
  });

  app.get(
    '/v1/profile',
    {
      schema: {
        response: { 200: ReaderProfileResponseSchema, 503: ErrorResponseSchema },
      },
    },
    async (request, reply) => {
      if (!deps.profiles) return reply.code(503).send({ error: 'reader profile is not configured' });
      return deps.profiles.get(request.authUser!.id);
    },
  );

  app.post(
    '/v1/profile/onboarding',
    {
      schema: {
        body: ReaderProfileOnboardingRequestSchema,
        response: {
          200: ReaderProfileResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
          503: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (!deps.profiles) return reply.code(503).send({ error: 'reader profile is not configured' });
      try {
        return await deps.profiles.completeOnboarding(request.authUser!.id, request.body);
      } catch (error) {
        if (error instanceof ProfileError) {
          return reply.code(error.statusCode).send({ error: error.message });
        }
        throw error;
      }
    },
  );

  const userBookFailure = (error: unknown, reply: { code(statusCode: number): unknown }): { error: string } => {
    if (error instanceof UserBookError) {
      reply.code(error.statusCode);
      return { error: error.message };
    }
    throw error;
  };

  app.get(
    '/v1/health',
    {
      schema: {
        response: {
          200: HealthResponseSchema,
          503: HealthResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const probes = Object.entries(deps.healthProbes ?? {});
      const dependencies: Record<string, DependencyStatus> = {};
      await Promise.all(
        probes.map(async ([name, probe]) => {
          try {
            await withTimeout(probe(), HEALTH_PROBE_TIMEOUT_MS);
            dependencies[name] = 'ok';
          } catch (error) {
            request.log.warn({ err: error, dependency: name }, 'health probe failed');
            dependencies[name] = 'error';
          }
        }),
      );

      const degraded = Object.values(dependencies).includes('error');
      if (degraded) {
        reply.code(503);
      }

      return {
        service: 'api',
        status: degraded ? ('degraded' as const) : ('ok' as const),
        version: '0.0.0',
        timestamp: new Date().toISOString(),
        ...(probes.length > 0 ? { dependencies } : {}),
      };
    },
  );

  app.post(
    '/v1/system/ping',
    {
      schema: {
        response: {
          202: EnqueueSystemPingResponseSchema,
          503: ErrorResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      if (!deps.systemJobs) {
        return reply
          .code(503)
          .send({ error: 'system job pipeline is not configured (DATABASE_URL and REDIS_URL required)' });
      }

      const { jobId } = await deps.systemJobs.enqueuePing();
      return reply.code(202).send({ jobId });
    },
  );

  app.get(
    '/v1/books',
    {
      schema: {
        response: {
          200: BookCatalogResponseSchema,
          503: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (!deps.books) {
        return reply.code(503).send({ error: 'book catalog is not configured' });
      }
      return { books: await deps.books.listBooks(request.authUser!.id) };
    },
  );

  app.get(
    '/v1/user-books',
    {
      schema: {
        response: { 200: UserBookShelfResponseSchema, 503: ErrorResponseSchema },
      },
    },
    async (request, reply) => {
      if (!deps.userBooks) return reply.code(503).send({ error: 'user book workflow is not configured' });
      return deps.userBooks.forUser(request.authUser!.id).list();
    },
  );

  app.get(
    '/v1/user-books/:id/workflow',
    {
      schema: {
        params: userBookIdParams,
        response: {
          200: UserBookWorkflowResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
          503: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (!deps.userBooks) return reply.code(503).send({ error: 'user book workflow is not configured' });
      try {
        return await deps.userBooks.forUser(request.authUser!.id).workflow(request.params.id);
      } catch (error) {
        return userBookFailure(error, reply);
      }
    },
  );

  app.get(
    '/v1/user-books/:id/interview',
    {
      schema: {
        params: userBookIdParams,
        response: { 200: InterviewStateResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema, 503: ErrorResponseSchema },
      },
    },
    async (request, reply) => {
      if (!deps.userBooks) return reply.code(503).send({ error: 'user book workflow is not configured' });
      try {
        return await deps.userBooks.forUser(request.authUser!.id).interviewState(request.params.id);
      } catch (error) {
        return userBookFailure(error, reply);
      }
    },
  );

  app.post(
    '/v1/user-books/:id/interview/answers',
    {
      // 响应是 SSE 流（§4）：逐字致谢/问题、逐个选项、充足度，最后 question_final 或 done。
      // 流会绕过序列化，因此不声明 response schema。
      schema: {
        params: userBookIdParams,
        body: SubmitInterviewAnswerRequestSchema,
      },
    },
    async (request, reply) => {
      if (!deps.userBooks) return reply.code(503).send({ error: 'user book workflow is not configured' });
      const events = deps.userBooks
        .forUser(request.authUser!.id)
        .streamInterviewAnswer(request.params.id, request.body);

      // 先拉首个事件再开流：开流前（校验、落库）的失败仍能以 HTTP 错误码呈现；一旦响应头发出，
      // 就只能靠带内 error 事件了（§4.1 / §4.4）。
      let first: IteratorResult<InterviewStreamEvent>;
      try {
        first = await events.next();
      } catch (error) {
        return userBookFailure(error, reply);
      }

      const encode = (event: InterviewStreamEvent) => `data: ${JSON.stringify(event)}\n\n`;
      const toSse = async function* (): AsyncGenerator<string> {
        try {
          if (!first.done) yield encode(first.value);
          for await (const event of events) yield encode(event);
        } catch (error) {
          request.log.error({ err: error }, 'interview answer stream failed');
          yield encode({ type: 'error', message: '访谈处理失败' });
        }
      };

      return reply
        .type('text/event-stream')
        .header('cache-control', 'no-cache')
        .header('x-accel-buffering', 'no')
        .send(Readable.from(withHeartbeat(toSse(), 15_000)));
    },
  );

  app.get(
    '/v1/user-books/:id/strategy',
    {
      schema: {
        params: userBookIdParams,
        response: { 200: StrategyReviewResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema, 503: ErrorResponseSchema },
      },
    },
    async (request, reply) => {
      if (!deps.userBooks) return reply.code(503).send({ error: 'user book workflow is not configured' });
      try {
        return await deps.userBooks.forUser(request.authUser!.id).strategyState(request.params.id);
      } catch (error) {
        return userBookFailure(error, reply);
      }
    },
  );

  app.post(
    '/v1/user-books/:id/strategy/feedback',
    {
      schema: {
        params: userBookIdParams,
        body: SubmitStrategyFeedbackRequestSchema,
        response: { 200: StrategyReviewResponseSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema, 503: ErrorResponseSchema },
      },
    },
    async (request, reply) => {
      if (!deps.userBooks) return reply.code(503).send({ error: 'user book workflow is not configured' });
      try {
        return await deps.userBooks.forUser(request.authUser!.id).submitStrategyFeedback(request.params.id, request.body);
      } catch (error) {
        return userBookFailure(error, reply);
      }
    },
  );

  app.post(
    '/v1/user-books/:id/strategy/approve',
    {
      schema: {
        params: userBookIdParams,
        body: ApproveStrategyRequestSchema,
        response: { 200: ApproveStrategyResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema, 503: ErrorResponseSchema },
      },
    },
    async (request, reply) => {
      if (!deps.userBooks) return reply.code(503).send({ error: 'user book workflow is not configured' });
      try {
        return await deps.userBooks.forUser(request.authUser!.id).approveStrategy(request.params.id, request.body);
      } catch (error) {
        return userBookFailure(error, reply);
      }
    },
  );

  app.get(
    '/v1/user-books/:id/trial',
    {
      schema: {
        params: userBookIdParams,
        response: { 200: TrialReviewResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema, 503: ErrorResponseSchema },
      },
    },
    async (request, reply) => {
      if (!deps.userBooks) return reply.code(503).send({ error: 'user book workflow is not configured' });
      try {
        return await deps.userBooks.forUser(request.authUser!.id).trialState(request.params.id);
      } catch (error) {
        return userBookFailure(error, reply);
      }
    },
  );

  app.post(
    '/v1/user-books/:id/trial/retry',
    {
      schema: {
        params: userBookIdParams,
        body: Type.Object({}),
        response: { 200: TrialReviewResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema, 503: ErrorResponseSchema },
      },
    },
    async (request, reply) => {
      if (!deps.userBooks) return reply.code(503).send({ error: 'user book workflow is not configured' });
      try {
        return await deps.userBooks.forUser(request.authUser!.id).retryTrial(request.params.id);
      } catch (error) {
        return userBookFailure(error, reply);
      }
    },
  );

  app.post(
    '/v1/user-books/:id/trial/viewed',
    {
      schema: {
        params: userBookIdParams,
        body: MarkTrialSegmentViewedRequestSchema,
        response: { 200: TrialReviewResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema, 503: ErrorResponseSchema },
      },
    },
    async (request, reply) => {
      if (!deps.userBooks) return reply.code(503).send({ error: 'user book workflow is not configured' });
      try {
        return await deps.userBooks.forUser(request.authUser!.id).markTrialViewed(request.params.id, request.body);
      } catch (error) {
        return userBookFailure(error, reply);
      }
    },
  );

  app.post(
    '/v1/user-books/:id/trial/feedback',
    {
      schema: {
        params: userBookIdParams,
        body: SubmitTrialFeedbackRequestSchema,
        response: { 200: StrategyReviewResponseSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema, 503: ErrorResponseSchema },
      },
    },
    async (request, reply) => {
      if (!deps.userBooks) return reply.code(503).send({ error: 'user book workflow is not configured' });
      try {
        return await deps.userBooks.forUser(request.authUser!.id).submitTrialFeedback(request.params.id, request.body);
      } catch (error) {
        return userBookFailure(error, reply);
      }
    },
  );

  app.post(
    '/v1/user-books/:id/trial/adopt',
    {
      schema: {
        params: userBookIdParams,
        body: AdoptTrialRequestSchema,
        response: { 200: AdoptTrialResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema, 503: ErrorResponseSchema },
      },
    },
    async (request, reply) => {
      if (!deps.userBooks) return reply.code(503).send({ error: 'user book workflow is not configured' });
      try {
        return await deps.userBooks.forUser(request.authUser!.id).adoptTrial(request.params.id, request.body);
      } catch (error) {
        return userBookFailure(error, reply);
      }
    },
  );

  app.get(
    '/v1/user-books/:id/reader',
    {
      schema: {
        params: userBookIdParams,
        response: { 200: ReaderBootstrapSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema, 503: ErrorResponseSchema },
      },
    },
    async (request, reply) => {
      if (!deps.userBooks) return reply.code(503).send({ error: 'user book workflow is not configured' });
      try {
        return await deps.userBooks.forUser(request.authUser!.id).reader(request.params.id);
      } catch (error) {
        return userBookFailure(error, reply);
      }
    },
  );

  // §6.2 / PRD §11.3: the reader reports its current (or jumped-to) node so the host keeps the
  // lazy-loading window generating and raises the target's priority. Returns the fresh bootstrap
  // so the client picks up newly-queued enhancements immediately.
  app.post(
    '/v1/user-books/:id/reader/focus',
    {
      schema: {
        params: userBookIdParams,
        body: ReaderFocusRequestSchema,
        response: { 200: ReaderBootstrapSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema, 503: ErrorResponseSchema },
      },
    },
    async (request, reply) => {
      if (!deps.userBooks) return reply.code(503).send({ error: 'user book workflow is not configured' });
      try {
        return await deps.userBooks.forUser(request.authUser!.id).reportReaderFocus(request.params.id, request.body);
      } catch (error) {
        return userBookFailure(error, reply);
      }
    },
  );

  // §11.4: mark a reading node read (monotonic, idempotent). Returns the full read set.
  app.post(
    '/v1/user-books/:id/reader/read-nodes',
    {
      schema: {
        params: userBookIdParams,
        body: MarkReadNodeRequestSchema,
        response: { 200: MarkReadNodeResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema, 503: ErrorResponseSchema },
      },
    },
    async (request, reply) => {
      if (!deps.userBooks) return reply.code(503).send({ error: 'user book workflow is not configured' });
      try {
        return await deps.userBooks.forUser(request.authUser!.id).markReadNode(request.params.id, request.body);
      } catch (error) {
        return userBookFailure(error, reply);
      }
    },
  );

  // §11.6: per-user (global) reader presentation settings — synced across books and devices.
  app.get(
    '/v1/me/reading-settings',
    { schema: { response: { 200: ReadingSettingsResponseSchema, 503: ErrorResponseSchema } } },
    async (request, reply) => {
      if (!deps.userBooks) return reply.code(503).send({ error: 'user book workflow is not configured' });
      return deps.userBooks.forUser(request.authUser!.id).getReadingSettings();
    },
  );

  app.put(
    '/v1/me/reading-settings',
    {
      schema: {
        body: ReadingSettingsSchema,
        response: { 200: ReadingSettingsResponseSchema, 400: ErrorResponseSchema, 503: ErrorResponseSchema },
      },
    },
    async (request, reply) => {
      if (!deps.userBooks) return reply.code(503).send({ error: 'user book workflow is not configured' });
      try {
        return await deps.userBooks.forUser(request.authUser!.id).updateReadingSettings(request.body);
      } catch (error) {
        return userBookFailure(error, reply);
      }
    },
  );

  // §11.7: reader highlights (+ optional notes). CRUD is per user-book; the reader also gets the full
  // list via bootstrap, so this GET backs the standalone highlight list view. PATCH/DELETE are the
  // cross-origin non-simple methods the CORS preflight already advertises (see the cors register).
  app.get(
    '/v1/user-books/:id/highlights',
    {
      schema: {
        params: userBookIdParams,
        response: { 200: HighlightListResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema, 503: ErrorResponseSchema },
      },
    },
    async (request, reply) => {
      if (!deps.userBooks) return reply.code(503).send({ error: 'user book workflow is not configured' });
      try {
        return await deps.userBooks.forUser(request.authUser!.id).listHighlights(request.params.id);
      } catch (error) {
        return userBookFailure(error, reply);
      }
    },
  );

  app.post(
    '/v1/user-books/:id/highlights',
    {
      schema: {
        params: userBookIdParams,
        body: CreateHighlightRequestSchema,
        response: { 200: HighlightResponseSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema, 503: ErrorResponseSchema },
      },
    },
    async (request, reply) => {
      if (!deps.userBooks) return reply.code(503).send({ error: 'user book workflow is not configured' });
      try {
        return await deps.userBooks.forUser(request.authUser!.id).createHighlight(request.params.id, request.body);
      } catch (error) {
        return userBookFailure(error, reply);
      }
    },
  );

  app.patch(
    '/v1/user-books/:id/highlights/:hid',
    {
      schema: {
        params: userBookHighlightParams,
        body: UpdateHighlightNoteRequestSchema,
        response: { 200: HighlightResponseSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema, 503: ErrorResponseSchema },
      },
    },
    async (request, reply) => {
      if (!deps.userBooks) return reply.code(503).send({ error: 'user book workflow is not configured' });
      try {
        return await deps.userBooks.forUser(request.authUser!.id).updateHighlightNote(request.params.id, request.params.hid, request.body);
      } catch (error) {
        return userBookFailure(error, reply);
      }
    },
  );

  app.delete(
    '/v1/user-books/:id/highlights/:hid',
    {
      schema: {
        params: userBookHighlightParams,
        response: { 200: DeleteHighlightResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema, 503: ErrorResponseSchema },
      },
    },
    async (request, reply) => {
      if (!deps.userBooks) return reply.code(503).send({ error: 'user book workflow is not configured' });
      try {
        return await deps.userBooks.forUser(request.authUser!.id).deleteHighlight(request.params.id, request.params.hid);
      } catch (error) {
        return userBookFailure(error, reply);
      }
    },
  );

  app.post(
    '/v1/books/import',
    {
      schema: {
        response: {
          200: ImportBookResponseSchema,
          202: ImportBookResponseSchema,
          400: ErrorResponseSchema,
          413: ErrorResponseSchema,
          503: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (!deps.bookImports) {
        return reply.code(503).send({ error: 'book import pipeline is not configured' });
      }
      try {
        const upload = await request.file();
        if (!upload) return reply.code(400).send({ error: '请选择 EPUB 文件' });
        const result = await deps.bookImports.importBook(request.authUser!.id, {
          filename: upload.filename,
          mediaType: upload.mimetype,
          bytes: await upload.toBuffer(),
        });
        return reply.code(result.reused ? 200 : 202).send(result);
      } catch (error) {
        if (error instanceof BookImportError) {
          return reply.code(error.statusCode === 413 ? 413 : 400).send({ error: error.message });
        }
        if ((error as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
          return reply.code(413).send({ error: 'EPUB 文件不能超过 100 MB' });
        }
        throw error;
      }
    },
  );

  app.post(
    '/v1/books/:id/retry',
    {
      schema: {
        params: bookIdParams,
        response: {
          200: ImportBookResponseSchema,
          202: ImportBookResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
          503: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (!deps.bookImports) {
        return reply.code(503).send({ error: 'book import pipeline is not configured' });
      }
      try {
        const result = await deps.bookImports.retryBook(request.authUser!.id, request.params.id);
        return reply.code(result.reused ? 200 : 202).send(result);
      } catch (error) {
        if (error instanceof BookImportError) {
          return reply.code(error.statusCode as 400 | 404 | 409).send({ error: error.message });
        }
        throw error;
      }
    },
  );

  app.get(
    '/v1/books/:id/status',
    {
      schema: {
        params: bookIdParams,
        response: {
          200: BookNormalizationStatusSchema,
          404: ErrorResponseSchema,
          503: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (!deps.books) {
        return reply.code(503).send({ error: 'book catalog is not configured' });
      }
      if (!await deps.books.canAccess(request.authUser!.id, request.params.id)) {
        return reply.code(404).send({ error: 'book not found' });
      }
      const status = await deps.books.getNormalizationStatus(request.params.id);
      return status ?? reply.code(404).send({ error: 'book not found' });
    },
  );

  app.get(
    '/v1/books/:id',
    {
      schema: {
        params: bookIdParams,
        response: {
          200: SharedBookSchema,
          404: ErrorResponseSchema,
          503: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (!deps.books) {
        return reply.code(503).send({ error: 'book catalog is not configured' });
      }
      if (!await deps.books.canAccess(request.authUser!.id, request.params.id)) {
        return reply.code(404).send({ error: 'ready book not found' });
      }
      const book = await deps.books.getBook(request.params.id);
      return book ?? reply.code(404).send({ error: 'ready book not found' });
    },
  );

  app.get(
    '/v1/books/:id/manifest',
    { schema: { params: bookIdParams } },
    async (request, reply) => {
      if (!deps.books) {
        return reply.code(503).send({ error: 'book catalog is not configured' });
      }
      if (!await deps.books.canAccess(request.authUser!.id, request.params.id)) {
        return reply.code(404).send({ error: 'book manifest not found' });
      }
      const manifest = await deps.books.getManifest(request.params.id);
      return manifest ?? reply.code(404).send({ error: 'book manifest not found' });
    },
  );

  app.get(
    '/v1/books/:id/content',
    { schema: { params: bookIdParams } },
    async (request, reply) => {
      if (!deps.books) {
        return reply.code(503).send({ error: 'book catalog is not configured' });
      }
      if (!await deps.books.canAccess(request.authUser!.id, request.params.id)) {
        return reply.code(404).send({ error: 'book content not found' });
      }
      const content = await deps.books.getContent(request.params.id);
      if (!content) {
        return reply.code(404).send({ error: 'book content not found' });
      }
      return reply.type('text/html; charset=utf-8').send(Buffer.from(content));
    },
  );

  app.get(
    '/v1/books/:id/profile',
    { schema: { params: bookIdParams } },
    async (request, reply) => {
      if (!deps.books) {
        return reply.code(503).send({ error: 'book catalog is not configured' });
      }
      if (!await deps.books.canAccess(request.authUser!.id, request.params.id)) {
        return reply.code(404).send({ error: 'book profile not found' });
      }
      const profile = await deps.books.getProfile(request.params.id);
      return profile ?? reply.code(404).send({ error: 'book profile not found' });
    },
  );

  app.get(
    '/v1/books/:id/assets/*',
    {
      schema: {
        params: Type.Object({
          id: Type.String({ pattern: UUID_PATTERN }),
          '*': Type.String({ minLength: 1 }),
        }),
      },
    },
    async (request, reply) => {
      if (!deps.books) {
        return reply.code(503).send({ error: 'book catalog is not configured' });
      }
      if (!await deps.books.canAccess(request.authUser!.id, request.params.id)) {
        return reply.code(404).send({ error: 'book asset not found' });
      }
      const path = request.params['*'];
      const asset = await deps.books.getAsset(request.params.id, path);
      if (!asset) {
        return reply.code(404).send({ error: 'book asset not found' });
      }
      reply.header('x-content-type-options', 'nosniff');
      if (path.toLowerCase().endsWith('.svg')) {
        reply.header(
          'content-security-policy',
          "sandbox; default-src 'none'; style-src 'unsafe-inline'",
        );
      }
      return reply.type(assetContentType(path)).send(Buffer.from(asset));
    },
  );

  app.get(
    '/v1/system/jobs/:id',
    {
      schema: {
        params: Type.Object({
          id: Type.String({ pattern: UUID_PATTERN }),
        }),
        response: {
          200: SystemJobSchema,
          404: ErrorResponseSchema,
          503: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (!deps.systemJobs) {
        return reply
          .code(503)
          .send({ error: 'system job pipeline is not configured (DATABASE_URL and REDIS_URL required)' });
      }

      const job = await deps.systemJobs.getJob(request.params.id);
      if (!job) {
        return reply.code(404).send({ error: 'system job not found' });
      }

      return job;
    },
  );

  app.post(
    '/v1/system/chat',
    {
      // 响应是 SSE 流，不声明 response schema（流会绕过序列化，类型推导也不适用）。
      schema: {
        body: SystemChatRequestSchema,
      },
    },
    async (request, reply) => {
      const systemChat = deps.systemChat;
      if (!systemChat) {
        return reply
          .code(503)
          .send({ error: 'system chat is not configured (DATABASE_URL required)' });
      }

      const encode = (event: SystemChatEvent) => `data: ${JSON.stringify(event)}\n\n`;

      // 先拉取首个事件再开流：开流前的失败（如数据库不可用）还能以 HTTP 错误码呈现，
      // 一旦响应头发出就只能靠带内 error 事件了。
      const events = systemChat.stream(request.body.prompt);
      let first: IteratorResult<SystemChatEvent>;
      try {
        first = await events.next();
      } catch (error) {
        request.log.error({ err: error }, 'system chat failed to start');
        return reply.code(500).send({ error: 'system chat failed to start' });
      }

      const toSse = async function* (): AsyncGenerator<string> {
        try {
          if (!first.done) {
            yield encode(first.value);
          }
          for await (const event of events) {
            yield encode(event);
          }
        } catch (error) {
          request.log.error({ err: error }, 'system chat stream failed');
          yield encode({ type: 'error', message: 'model stream failed' });
        }
      };

      return reply
        .type('text/event-stream')
        .header('cache-control', 'no-cache')
        .send(Readable.from(toSse()));
    },
  );

  return app;
}
