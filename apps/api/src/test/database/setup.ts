import { afterAll, beforeAll, beforeEach } from 'vitest';
import {
  closeTestDatabase,
  hasTestDatabase,
  initializeTestDatabase,
  resetTestDatabase,
} from './context';

beforeAll(async () => {
  if (hasTestDatabase) await initializeTestDatabase();
});

beforeEach(async () => {
  if (hasTestDatabase) await resetTestDatabase();
});

afterAll(async () => {
  if (hasTestDatabase) await closeTestDatabase();
});
