/** Verifies the HTTP wiring for the independent agent-driven reading-setup service. */

import { describe, expect, it, vi } from 'vitest';
import type { ReadingSetupSessionSnapshot } from '@readtailor/contracts';
import { buildApp } from './app';
import type { AgentDrivenReadingSetupService } from './agent-driven-reading-setup';
import type { AuthService } from './auth';
import { loadApiConfig } from './config';

const userId = '11111111-1111-4111-8111-111111111111';
const userBookId = '22222222-2222-4222-8222-222222222222';
const sessionId = '33333333-3333-4333-8333-333333333333';
const runId = '44444444-4444-4444-8444-444444444444';
const strategyVersionId = '55555555-5555-4555-8555-555555555555';

const auth: AuthService = {
  async authenticateSession() {
    return {
      user: {
        id: userId,
        displayName: 'Reader',
        avatarUrl: null,
        email: null,
        readerProfileCompletedAt: new Date(),
      },
      expiresAt: new Date('2026-08-14T00:00:00.000Z'),
    };
  },
  beginGoogleLogin() { throw new Error('not used'); },
  async completeGoogleLogin() { throw new Error('not used'); },
  async registerWithPassword() { throw new Error('not used'); },
  async loginWithPassword() { throw new Error('not used'); },
  async developmentLogin() { throw new Error('not used'); },
  async logout() {},
};

const snapshot: ReadingSetupSessionSnapshot = {
  id: sessionId,
  userBookId,
  agentType: 'reading_setup',
  agentState: {
    systemPrompt: 'system',
    modelConfigId: 'model:prompt',
    thinkingLevel: 'medium',
    messages: [],
    actions: [],
  },
  activeRun: null,
  createdAt: '2026-07-22T00:00:00.000Z',
  updatedAt: '2026-07-22T00:00:00.000Z',
};

describe('Reading setup routes', () => {
  it('wires session, run subscription and explicit confirmation to the independent service', async () => {
    const getOrCreateSession = vi.fn(async () => snapshot);
    const submitMessage = vi.fn(async () => ({ runId, accepted: true }));
    const submitStrategyConfirmation = vi.fn(async () => ({ runId, accepted: true }));
    const confirm = vi.fn(async () => ({
      userBookId,
      workflowStatus: 'active_reading' as const,
      strategyVersionId,
    }));
    const service = {
      getOrCreateSession,
      submitMessage,
      submitStrategyConfirmation,
      confirm,
      async *subscribeRun() {
        yield {
          type: 'run_snapshot' as const,
          runId,
          snapshot: {
            runId,
            lastSequence: 7,
            status: 'completed' as const,
            assistantText: '完成',
            assistantMessage: null,
            tools: [],
            error: null,
          },
        };
      },
    } as unknown as AgentDrivenReadingSetupService;
    const app = await buildApp(loadApiConfig({ LOG_LEVEL: 'silent' }), {
      auth,
      agentDrivenReadingSetup: service,
    });

    const created = await app.inject({
      method: 'POST',
      url: `/v1/user-books/${userBookId}/reading-setup/session`,
      headers: { origin: 'http://localhost:5173' },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ id: sessionId, agentType: 'reading_setup' });
    expect(getOrCreateSession).toHaveBeenCalledWith(userId, userBookId);

    const started = await app.inject({
      method: 'POST',
      url: `/v1/reading-setup/sessions/${sessionId}/messages`,
      headers: { origin: 'http://localhost:5173', 'content-type': 'application/json' },
      payload: { message: '开始准备' },
    });
    expect(started.statusCode).toBe(202);
    expect(started.json()).toEqual({ runId, accepted: true });
    expect(submitMessage).toHaveBeenCalledWith(userId, sessionId, '开始准备');

    const strategyConfirmed = await app.inject({
      method: 'POST',
      url: `/v1/reading-setup/sessions/${sessionId}/strategy-confirmations`,
      headers: { origin: 'http://localhost:5173', 'content-type': 'application/json' },
      payload: { strategyToolCallId: 'strategy-1' },
    });
    expect(strategyConfirmed.statusCode).toBe(202);
    expect(strategyConfirmed.json()).toEqual({ runId, accepted: true });
    expect(submitStrategyConfirmation).toHaveBeenCalledWith(userId, sessionId, {
      strategyToolCallId: 'strategy-1',
    });

    const events = await app.inject({
      method: 'GET',
      url: `/v1/reading-setup/sessions/${sessionId}/runs/${runId}/events`,
    });
    expect(events.statusCode).toBe(200);
    expect(events.headers['content-type']).toContain('text/event-stream');
    expect(events.body).toContain('"type":"run_snapshot"');
    expect(events.body).toContain('"status":"completed"');

    const activated = await app.inject({
      method: 'POST',
      url: `/v1/reading-setup/sessions/${sessionId}/confirm`,
      headers: { origin: 'http://localhost:5173', 'content-type': 'application/json' },
      payload: { trialToolCallId: 'trial-1' },
    });
    expect(activated.statusCode).toBe(200);
    expect(activated.json()).toEqual({
      userBookId,
      workflowStatus: 'active_reading',
      strategyVersionId,
    });
    expect(confirm).toHaveBeenCalledWith(userId, sessionId, 'trial-1');
  });
});
