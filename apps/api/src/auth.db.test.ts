/**
 * 数据库级认证测试：验证三种真实新用户分支都只在创建时获得 ready preset 书籍。
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  bookPackages,
  sharedBooks,
  userBooks,
} from '@readtailor/database';
import { createDatabaseAuthRepository } from './auth';
import {
  getTestDatabase,
  hasTestDatabase,
} from './test/database';

const describePostgres = hasTestDatabase ? describe : describe.skip;
const skipReason = hasTestDatabase ? '' : ' (skipped: TEST_DATABASE_URL is not set)';

async function createSharedBook(options: {
  isPreset: boolean;
  status: 'queued' | 'ready';
}): Promise<string> {
  const db = getTestDatabase().db;
  const bookId = randomUUID();
  const packageId = randomUUID();
  await db.insert(sharedBooks).values({
    id: bookId,
    epubSha256: randomUUID().replaceAll('-', '').padEnd(64, '0').slice(0, 64),
    status: 'queued',
    title: `Book ${bookId}`,
    authors: [],
    language: 'und',
    identifiers: {},
    sourceFilename: `${bookId}.epub`,
    isPreset: options.isPreset,
  });
  if (options.status === 'ready') {
    await db.insert(bookPackages).values({
      id: packageId,
      sharedBookId: bookId,
      version: `test-${bookId}`,
      contractVersion: 'nb-1.0',
      manifestVersion: 'reading-nodes-1.0',
      objectPrefix: `test/${bookId}`,
      fileHashes: {},
      validationSummary: {},
    });
    await db
      .update(sharedBooks)
      .set({ status: 'ready', currentPackageId: packageId })
      .where(eq(sharedBooks.id, bookId));
  }
  return bookId;
}

async function shelf(userId: string) {
  return getTestDatabase().db
    .select({
      sharedBookId: userBooks.sharedBookId,
      workflowStatus: userBooks.workflowStatus,
    })
    .from(userBooks)
    .where(eq(userBooks.userId, userId));
}

describePostgres(`database auth preset shelf initialization${skipReason}`, () => {
  beforeEach(async () => {
    await getTestDatabase().db.update(sharedBooks).set({ isPreset: false });
  });

  it('adds only ready preset books for a new password user', async () => {
    const readyPresetId = await createSharedBook({ isPreset: true, status: 'ready' });
    await createSharedBook({ isPreset: true, status: 'queued' });
    await createSharedBook({ isPreset: false, status: 'ready' });
    const repository = createDatabaseAuthRepository(getTestDatabase().db);

    const user = await repository.createPasswordIdentity({
      displayName: 'Password User',
      email: `${randomUUID()}@example.com`,
      passwordHash: 'test-password-hash',
    }, new Date());

    expect(await shelf(user.id)).toEqual([{
      sharedBookId: readyPresetId,
      workflowStatus: 'on_shelf',
    }]);
  });

  it.each(['google', 'development'] as const)(
    'adds ready preset books for a first %s login',
    async (provider) => {
      const readyPresetId = await createSharedBook({ isPreset: true, status: 'ready' });
      const repository = createDatabaseAuthRepository(getTestDatabase().db);

      const user = await repository.upsertIdentity({
        provider,
        subject: randomUUID(),
        email: provider === 'google' ? `${randomUUID()}@example.com` : null,
        emailVerified: provider === 'google',
        displayName: `${provider} user`,
        avatarUrl: null,
      }, new Date());

      expect(await shelf(user.id)).toEqual([{
        sharedBookId: readyPresetId,
        workflowStatus: 'on_shelf',
      }]);
    },
  );

  it('does not seed newly added presets when an existing identity logs in again', async () => {
    const firstPresetId = await createSharedBook({ isPreset: true, status: 'ready' });
    const repository = createDatabaseAuthRepository(getTestDatabase().db);
    const subject = randomUUID();
    const identity = {
      provider: 'google' as const,
      subject,
      email: `${randomUUID()}@example.com`,
      emailVerified: true,
      displayName: 'Existing User',
      avatarUrl: null,
    };
    const user = await repository.upsertIdentity(identity, new Date());
    await createSharedBook({ isPreset: true, status: 'ready' });

    await repository.upsertIdentity(identity, new Date());

    expect(await shelf(user.id)).toEqual([{
      sharedBookId: firstPresetId,
      workflowStatus: 'on_shelf',
    }]);
  });
});
