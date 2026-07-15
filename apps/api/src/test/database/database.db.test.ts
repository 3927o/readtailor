import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { trialSegments, userBooks } from '@readtailor/database';
import { getTestDatabase, hasTestDatabase, interviewingGraph, trialReviewGraph } from '.';

const describePostgres = hasTestDatabase ? describe : describe.skip;
const skipReason = hasTestDatabase ? '' : ' (skipped: TEST_DATABASE_URL is not set)';

describePostgres(`PostgreSQL test infrastructure${skipReason}`, () => {
  it('applies all migrations inside the worker schema', async () => {
    const { client, schemaName } = getTestDatabase();
    const [schema] = await client<{ current_schema: string }[]>`
      select current_schema() as current_schema
    `;
    const [migrationCount] = await client<{ count: number }[]>`
      select count(*)::int as count
      from ${client(schemaName)}.__drizzle_migrations
    `;
    const [latestTable] = await client<{ exists: boolean }[]>`
      select exists (
        select 1
        from pg_catalog.pg_tables
        where schemaname = ${schemaName}
          and tablename = 'reading_setup_operations'
      ) as exists
    `;

    expect(schema?.current_schema).toBe(schemaName);
    expect(migrationCount?.count).toBeGreaterThan(0);
    expect(latestTable?.exists).toBe(true);
  });

  it('builds an interviewing graph with a consistent workflow pointer', async () => {
    const { db } = getTestDatabase();
    const graph = await interviewingGraph(db);
    const [userBook] = await db
      .select()
      .from(userBooks)
      .where(eq(userBooks.id, graph.userBookId));

    expect(userBook).toMatchObject({
      workflowStatus: 'interviewing',
      currentInterviewSessionId: graph.interviewSessionId,
    });
  });

  it('builds a published 3/3 trial review graph', async () => {
    const { db } = getTestDatabase();
    const graph = await trialReviewGraph(db);
    const [userBook] = await db
      .select()
      .from(userBooks)
      .where(eq(userBooks.id, graph.userBookId));
    const segments = await db
      .select()
      .from(trialSegments)
      .where(eq(trialSegments.trialRevisionId, graph.trialRevisionId));

    expect(userBook).toMatchObject({
      workflowStatus: 'trial_review',
      currentStrategyDraftVersionId: graph.strategyDraftVersionId,
      currentTrialRevisionId: graph.trialRevisionId,
    });
    expect(segments).toHaveLength(3);
    expect(segments.every(({ status }) => status === 'ready')).toBe(true);
  });
});
