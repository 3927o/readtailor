import { createDatabase } from '@readtailor/database';
import { backfillPresetBooks } from './preset-books';

const LOCK_KEY = 'readtailor:preset-book-backfill:v1';

function readUserId(args: string[]): string | undefined {
  const userIdArg = args.find((arg) => arg.startsWith('--user-id='));
  if (!userIdArg) return undefined;
  const userId = userIdArg.slice('--user-id='.length).trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId)) {
    throw new Error(`invalid --user-id: ${userId}`);
  }
  return userId;
}

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const database = createDatabase(databaseUrl);
let locked = false;
try {
  const [lock] = await database.client<{ locked: boolean }[]>`
    select pg_try_advisory_lock(hashtext(${LOCK_KEY})) as locked
  `;
  locked = lock?.locked === true;
  if (!locked) throw new Error('another preset-book backfill is already running');

  const userId = readUserId(process.argv.slice(2));
  const result = await backfillPresetBooks(database.db, userId ? { userId } : {});
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.failures.length > 0) process.exitCode = 1;
} finally {
  if (locked) {
    await database.client`select pg_advisory_unlock(hashtext(${LOCK_KEY}))`;
  }
  await database.client.end({ timeout: 5 });
}
