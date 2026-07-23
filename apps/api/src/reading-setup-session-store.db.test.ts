import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createReadingSetupSessionStore,
  type ReadingSetupSessionStore,
} from '@readtailor/database';
import type { AgentSessionState } from '@readtailor/contracts';
import {
  getTestDatabase,
  hasTestDatabase,
  onShelfGraph,
} from './test/database';

const describePostgres = hasTestDatabase ? describe : describe.skip;
const skipReason = hasTestDatabase ? '' : ' (skipped: TEST_DATABASE_URL is not set)';

const state = (message: string): AgentSessionState => ({
  systemPrompt: 'system',
  modelConfigId: 'model:prompt',
  thinkingLevel: 'medium',
  messages: message
    ? [{ role: 'user', content: message, timestamp: Date.now() }]
    : [],
  actions: [],
});

async function createSession(store: ReadingSetupSessionStore) {
  const graph = await onShelfGraph(getTestDatabase().db);
  const session = await store.createForOwnedUserBook({
    userId: graph.userId,
    userBookId: graph.userBookId,
    initialState: state(''),
  });
  return { graph, session };
}

describePostgres(`Reading setup session store${skipReason}`, () => {
  it('allows exactly one parallel run claim', async () => {
    const store = createReadingSetupSessionStore({ db: getTestDatabase().db });
    const { graph, session } = await createSession(store);
    const runIds = [randomUUID(), randomUUID()];
    const claims = await Promise.all(runIds.map((runId) => store.claimRun(session.id, runId)));
    expect(claims.filter((claim) => claim.claimed)).toHaveLength(1);
    const winner = claims.findIndex((claim) => claim.claimed);
    const loser = winner === 0 ? 1 : 0;
    const winnerState = state('winner');
    expect(claims[loser]!.activeRunId).toBe(runIds[winner]);
    expect(await store.commitRun(session.id, runIds[loser]!, state('stale'))).toBe(false);
    expect(await store.commitRun(session.id, runIds[winner]!, winnerState)).toBe(true);
    expect((await store.getOwnedByUserBook(graph.userId, graph.userBookId))?.agentState)
      .toEqual(winnerState);
  });

  it('prevents an expired run from overwriting or clearing a later run', async () => {
    const store = createReadingSetupSessionStore({ db: getTestDatabase().db });
    const { session } = await createSession(store);
    const expiredRunId = randomUUID();
    const currentRunId = randomUUID();
    expect((await store.claimRun(session.id, expiredRunId)).claimed).toBe(true);
    expect(await store.failRun(session.id, expiredRunId)).toBe(true);
    expect((await store.claimRun(session.id, currentRunId)).claimed).toBe(true);

    expect(await store.commitRun(session.id, expiredRunId, state('expired'))).toBe(false);
    expect(await store.failRun(session.id, expiredRunId)).toBe(false);
    expect((await store.getById(session.id))?.activeRunId).toBe(currentRunId);
    const currentState = state('current');
    expect(await store.commitRun(session.id, currentRunId, currentState)).toBe(true);
    expect((await store.getById(session.id))?.agentState).toEqual(currentState);
  });
});
