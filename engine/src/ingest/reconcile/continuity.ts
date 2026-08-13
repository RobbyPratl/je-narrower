import { config } from '../../config.js';
import type { Db } from '../../db/client.js';
import { capFailures, okResult, type Check } from './check.js';

export const continuityCheck: Check = {
  id: 'continuity',
  async run(db: Db, datasetId: string) {
    const tol = config.reconcile.amountToleranceCents;
    const { rows: p1Open } = await db.query<{ account: string; delta: string }>(
      `SELECT account,
              ROUND((opening_debit - opening_credit) * 100)::bigint AS delta
       FROM trial_balance
       WHERE dataset_id = $1
         AND period = 'P1'
         AND ABS(ROUND((opening_debit - opening_credit) * 100)) > $2`,
      [datasetId, tol],
    );

    const { rows: carry } = await db.query<{ account: string; delta: string }>(
      `SELECT p2.account,
              ROUND((
                (p2.opening_debit - p2.opening_credit) -
                (p1.closing_debit - p1.closing_credit)
              ) * 100)::bigint AS delta
       FROM trial_balance p2
       JOIN trial_balance p1
         ON p1.dataset_id = p2.dataset_id
        AND p1.account = p2.account
        AND p1.period = 'P1'
       WHERE p2.dataset_id = $1
         AND p2.period = 'P2'
         AND ABS(ROUND((
                (p2.opening_debit - p2.opening_credit) -
                (p1.closing_debit - p1.closing_credit)
              ) * 100)) > $2`,
      [datasetId, tol],
    );

    const failures = [
      ...p1Open.map((r) => ({
        scope: `P1/${r.account}`,
        expected: 0,
        actual: Number(r.delta),
        deltaCents: Number(r.delta),
        detail: 'P1 opening should be zero',
      })),
      ...carry.map((r) => ({
        scope: r.account,
        expected: 0,
        actual: Number(r.delta),
        deltaCents: Number(r.delta),
        detail: 'P2 opening != P1 closing',
      })),
    ];

    if (failures.length === 0) {
      return okResult('continuity', 'period continuity holds');
    }

    return {
      check: 'continuity',
      ok: false,
      summary: `${failures.length} continuity failure(s)`,
      metrics: { failures: failures.length },
      failures: capFailures(failures),
    };
  },
};
