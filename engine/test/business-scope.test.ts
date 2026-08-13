import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getEntry, queryEntries } from '../src/api/queries.js';
import { resolveCitation } from '../src/api/citations.js';
import { createPool } from '../src/db/client.js';
import { migrate } from '../src/db/migrate.js';
import { requireCurrentPopulation } from '../src/dataset.js';
import { getJob } from '../src/jobs.js';

const pool = createPool();

beforeAll(async () => {
  await migrate(pool);
  await pool.query(`DELETE FROM businesses WHERE business_id IN ('scope-a', 'scope-b')`);
  await pool.query(
    `INSERT INTO businesses (business_id, name) VALUES ('scope-a', 'Scope A'), ('scope-b', 'Scope B')`,
  );
  await pool.query(
    `INSERT INTO datasets (dataset_id, business_id, status, is_current, pipeline)
     VALUES
       ('scope-a-ds', 'scope-a', 'reconciled', true, '{"ingested":true,"projected":true,"scored":true}'),
       ('scope-b-ds', 'scope-b', 'reconciled', true, '{"ingested":true,"projected":true,"scored":true}')`,
  );
  await pool.query(
    `INSERT INTO accounts (dataset_id, account, name, root_type, normal_balance)
     VALUES
       ('scope-a-ds', '1000', 'A Cash', 'Asset', 'debit'),
       ('scope-b-ds', '1000', 'B Cash', 'Asset', 'debit')`,
  );
  await pool.query(
    `INSERT INTO entries
       (dataset_id, entry_id, period, posted_at, effective_date, "user", source, voucher_type, line_count, total_amount)
     VALUES
       ('scope-a-ds', 'same-entry', 'P1', now(), '2026-01-01', 'user-a', 'source-a', 'Journal', 1, 10),
       ('scope-b-ds', 'same-entry', 'P1', now(), '2026-01-01', 'user-b', 'source-b', 'Journal', 1, 20)`,
  );
  await pool.query(
    `INSERT INTO lines (dataset_id, line_id, entry_id, line_no, account, debit, credit)
     VALUES
       ('scope-a-ds', 'same-line', 'same-entry', 1, '1000', 10, 0),
       ('scope-b-ds', 'same-line', 'same-entry', 1, '1000', 20, 0)`,
  );
  await pool.query(
    `INSERT INTO scores (dataset_id, entry_id, rule, score, inputs)
     VALUES
       ('scope-a-ds', 'same-entry', 'pair_rarity', 0.25, '{}'),
       ('scope-b-ds', 'same-entry', 'pair_rarity', 0.75, '{}')`,
  );
  await pool.query(
    `INSERT INTO jobs (dataset_id, job_id, kind, status)
     VALUES
       ('scope-a-ds', 'same-job', 'test-a', 'done'),
       ('scope-b-ds', 'same-job', 'test-b', 'done')`,
  );
});

afterAll(async () => {
  await pool.query(`DELETE FROM businesses WHERE business_id IN ('scope-a', 'scope-b')`);
  await pool.end();
});

describe('business scoping', () => {
  it('isolates colliding source IDs in reads, citations, scores, and jobs', async () => {
    const a = await requireCurrentPopulation(pool, 'scope-a');
    const b = await requireCurrentPopulation(pool, 'scope-b');

    const [entryA, entryB, listA, listB, citationA, citationB, jobA, jobB] = await Promise.all([
      getEntry(pool, a, 'same-entry'),
      getEntry(pool, b, 'same-entry'),
      queryEntries(pool, a, {}),
      queryEntries(pool, b, {}),
      resolveCitation(pool, a, 'line', 'same-line'),
      resolveCitation(pool, b, 'line', 'same-line'),
      getJob(pool, a, 'same-job'),
      getJob(pool, b, 'same-job'),
    ]);

    expect(entryA?.entry.user).toBe('user-a');
    expect(entryB?.entry.user).toBe('user-b');
    expect(entryA?.lines[0]?.debit).toBe(1000);
    expect(entryB?.lines[0]?.debit).toBe(2000);
    expect(entryA?.scores[0]?.score).toBeCloseTo(0.25);
    expect(entryB?.scores[0]?.score).toBeCloseTo(0.75);
    expect(listA.rows[0]?.composite).toBeLessThan(listB.rows[0]?.composite ?? 0);
    expect(citationA).toMatchObject({ kind: 'line', line: { debit: 1000 } });
    expect(citationB).toMatchObject({ kind: 'line', line: { debit: 2000 } });
    expect(jobA?.kind).toBe('test-a');
    expect(jobB?.kind).toBe('test-b');
  });
});
