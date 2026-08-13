import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/db/client.js';
import { migrate } from '../src/db/migrate.js';
import { createServer } from '../src/server.js';

const pool = createPool();
const businessId = 'worklist-test';
const datasetId = 'worklist-test-ds';
let app: Awaited<ReturnType<typeof createServer>> | undefined;

beforeAll(async () => {
  await migrate(pool);
  await pool.query(`DELETE FROM businesses WHERE business_id = $1`, [businessId]);
  await pool.query(`INSERT INTO businesses (business_id, name) VALUES ($1, 'Worklist Test')`, [businessId]);
  await pool.query(
    `INSERT INTO datasets (dataset_id, business_id, status, is_current, pipeline)
     VALUES ($1, $2, 'reconciled', true, $3::jsonb)`,
    [datasetId, businessId, JSON.stringify({ ingested: true, projected: true, scored: true, investigated: true, grouped: true })],
  );
  await pool.query(
    `INSERT INTO accounts (dataset_id, account, name, root_type, normal_balance)
     VALUES ($1, '1000', 'Cash', 'Asset', 'debit'), ($1, '2000', 'Accrual', 'Liability', 'credit')`,
    [datasetId],
  );
  await pool.query(
    `INSERT INTO entries
       (dataset_id, entry_id, period, posted_at, effective_date, "user", source, voucher_type, line_count, total_amount)
     VALUES
       ($1, 'E1', 'P1', '2026-01-31T12:00:00Z', '2026-01-31', 'alice', 'test', 'Journal', 2, 100),
       ($1, 'E2', 'P1', '2026-02-28T12:00:00Z', '2026-02-28', 'alice', 'test', 'Journal', 2, 105),
       ($1, 'E3', 'P2', '2026-03-31T12:00:00Z', '2026-03-31', 'alice', 'test', 'Journal', 2, 110),
       ($1, 'E4', 'P2', '2026-04-30T12:00:00Z', '2026-04-30', 'alice', 'test', 'Journal', 2, 102)`,
    [datasetId],
  );
  await pool.query(
    `INSERT INTO lines (dataset_id, line_id, entry_id, line_no, account, debit, credit)
     VALUES
       ($1, 'L1D', 'E1', 1, '1000', 100, 0), ($1, 'L1C', 'E1', 2, '2000', 0, 100),
       ($1, 'L2D', 'E2', 1, '1000', 105, 0), ($1, 'L2C', 'E2', 2, '2000', 0, 105),
       ($1, 'L3D', 'E3', 1, '1000', 110, 0), ($1, 'L3C', 'E3', 2, '2000', 0, 110),
       ($1, 'L4D', 'E4', 1, '1000', 102, 0), ($1, 'L4C', 'E4', 2, '2000', 0, 102)`,
    [datasetId],
  );
  await pool.query(
    `INSERT INTO scores (dataset_id, entry_id, rule, score, inputs)
     SELECT $1, entry_id, rule, 1, '{"pair":"1000↔2000"}'::jsonb
     FROM unnest(ARRAY['E1','E2','E3','E4']) AS entry_id
     CROSS JOIN unnest(ARRAY['pair_rarity','new_pair_emergence']) AS rule`,
    [datasetId],
  );
  await pool.query(
    `INSERT INTO review_groups
       (dataset_id, group_id, kind, account_a, account_b, consistency_score, consistency_detail, recurrence)
     VALUES
       ($1, 'G1', 'group', '1000', '2000', 1, '[]', '{"months":[],"marks":[],"byMonth":{}}'),
       ($1, 'G2', 'individual', '1000', '2000', 1, '[]', '{"months":[],"marks":[],"byMonth":{}}')`,
    [datasetId],
  );
  await pool.query(
    `INSERT INTO group_members (dataset_id, group_id, entry_id, is_deviation)
     VALUES ($1, 'G1', 'E1', false), ($1, 'G1', 'E2', false),
            ($1, 'G1', 'E3', false), ($1, 'G2', 'E4', false)`,
    [datasetId],
  );
  app = await createServer(pool);
});

afterAll(async () => {
  await app?.close();
  await pool.query(`DELETE FROM businesses WHERE business_id = $1`, [businessId]).catch(() => undefined);
  await pool.end();
});

describe('worklist decisions and membership', () => {
  it('sets aside, reconcludes, and atomically supersedes decisions when membership changes', async () => {
    const first = await app!.inject({
      method: 'POST',
      url: `/api/businesses/${businessId}/decisions/group/G1`,
      payload: {
        conclusion: 'set-aside',
        basis: 'Awaiting support',
        recordedBy: 'Auditor One',
        entryIds: ['E1', 'E2', 'E3'],
      },
    });
    expect(first.statusCode).toBe(200);
    const firstId = first.json().decisionId as string;

    const second = await app!.inject({
      method: 'POST',
      url: `/api/businesses/${businessId}/decisions/group/G1`,
      payload: {
        conclusion: 'appropriate-recurring',
        basis: 'Pattern confirmed',
        recordedBy: 'Auditor Two',
        entryIds: ['E1', 'E2', 'E3'],
      },
    });
    expect(second.statusCode).toBe(200);
    const secondId = second.json().decisionId as string;

    const storedSecond = await app!.inject({
      method: 'GET',
      url: `/api/businesses/${businessId}/decisions/${secondId}`,
    });
    expect(storedSecond.json()).toMatchObject({ supersedesId: firstId, conclusion: 'appropriate-recurring' });

    const concludedGroup = await app!.inject({
      method: 'GET',
      url: `/api/businesses/${businessId}/queue/G1`,
    });
    expect(concludedGroup.json()).toMatchObject({
      reviewStatus: 'reviewed',
      decision: {
        decisionId: secondId,
        conclusion: 'appropriate-recurring',
        basis: 'Pattern confirmed',
        recordedBy: 'Auditor Two',
      },
    });

    const entryDecision = await app!.inject({
      method: 'POST',
      url: `/api/businesses/${businessId}/decisions/entry/E4`,
      payload: { conclusion: 'appropriate-other', basis: 'Reviewed separately' },
    });
    expect(entryDecision.statusCode).toBe(200);
    const entryDecisionId = entryDecision.json().decisionId as string;

    const changed = await app!.inject({
      method: 'PATCH',
      url: `/api/businesses/${businessId}/queue/G1/members`,
      payload: { add: ['E4'], remove: ['E3'] },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({
      superseded: secondId,
      supersededDecisions: expect.arrayContaining([secondId, entryDecisionId]),
      group: {
        groupId: 'G1',
        entryIds: ['E1', 'E2', 'E4'],
        reviewStatus: 'open',
        decision: null,
      },
    });

    const { rows: memberships } = await pool.query<{ group_id: string; entry_id: string; kind: string }>(
      `SELECT gm.group_id, gm.entry_id, rg.kind
       FROM group_members gm
       JOIN review_groups rg ON rg.dataset_id = gm.dataset_id AND rg.group_id = gm.group_id
       WHERE gm.dataset_id = $1 ORDER BY gm.entry_id`,
      [datasetId],
    );
    expect(memberships).toEqual([
      { group_id: 'G1', entry_id: 'E1', kind: 'group' },
      { group_id: 'G1', entry_id: 'E2', kind: 'group' },
      expect.objectContaining({ entry_id: 'E3', kind: 'individual' }),
      { group_id: 'G1', entry_id: 'E4', kind: 'group' },
    ]);
    expect(memberships.some((membership) => membership.group_id === 'G2')).toBe(false);

    const { rows: latest } = await pool.query<{ target_kind: string; target_id: string; conclusion: string }>(
      `SELECT DISTINCT ON (target_kind, target_id) target_kind, target_id, conclusion
       FROM decisions WHERE dataset_id = $1
       ORDER BY target_kind, target_id, recorded_at DESC, decision_id DESC`,
      [datasetId],
    );
    expect(latest).toEqual(expect.arrayContaining([
      { target_kind: 'group', target_id: 'G1', conclusion: 'reopened' },
      { target_kind: 'entry', target_id: 'E4', conclusion: 'reopened' },
    ]));
  });

  it('rejects invalid changes without altering membership', async () => {
    const before = await pool.query(
      `SELECT entry_id FROM group_members WHERE dataset_id = $1 AND group_id = 'G1' ORDER BY entry_id`,
      [datasetId],
    );
    const response = await app!.inject({
      method: 'PATCH',
      url: `/api/businesses/${businessId}/queue/G1/members`,
      payload: { add: ['missing-entry'], remove: ['E1'] },
    });
    expect(response.statusCode).toBe(422);
    const after = await pool.query(
      `SELECT entry_id FROM group_members WHERE dataset_id = $1 AND group_id = 'G1' ORDER BY entry_id`,
      [datasetId],
    );
    expect(after.rows).toEqual(before.rows);
  });
});
