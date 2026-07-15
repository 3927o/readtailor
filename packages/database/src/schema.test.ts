import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { readingSetupOperations } from './schema';

describe('readingSetupOperations schema', () => {
  const config = getTableConfig(readingSetupOperations);

  it('defines the operation identity, recovery, and result columns', () => {
    expect(config.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'user_book_id',
        'kind',
        'source',
        'base_strategy_draft_version_id',
        'base_trial_revision_id',
        'idempotency_key',
        'request_hash',
        'payload',
        'status',
        'attempt_count',
        'lease_id',
        'lease_claimed_at',
        'lease_expires_at',
        'result_strategy_draft_version_id',
        'result_trial_revision_id',
        'error_summary',
        'completed_at',
      ]),
    );
    expect(readingSetupOperations.status.default).toBe('pending');
    expect(readingSetupOperations.attemptCount.default).toBe(0);
  });

  it('enforces idempotency and a single active operation per book', () => {
    expect(
      config.indexes.map((index) => ({
        name: index.config.name,
        unique: index.config.unique,
        partial: index.config.where !== undefined,
      })),
    ).toEqual(
      expect.arrayContaining([
        {
          name: 'reading_setup_operations_book_idempotency_unique',
          unique: true,
          partial: false,
        },
        {
          name: 'reading_setup_operations_one_active_per_book',
          unique: true,
          partial: true,
        },
        {
          name: 'reading_setup_operations_book_updated_idx',
          unique: false,
          partial: false,
        },
      ]),
    );
  });

  it('keeps the lease, terminal status, source, and result invariants in the database', () => {
    expect(config.checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        'reading_setup_operations_kind_source_valid',
        'reading_setup_operations_base_trial_valid',
        'reading_setup_operations_request_hash_valid',
        'reading_setup_operations_lease_complete',
        'reading_setup_operations_lease_status_valid',
        'reading_setup_operations_lease_window_valid',
        'reading_setup_operations_result_valid',
        'reading_setup_operations_error_valid',
        'reading_setup_operations_completion_valid',
      ]),
    );
    expect(config.foreignKeys).toHaveLength(5);
  });
});
