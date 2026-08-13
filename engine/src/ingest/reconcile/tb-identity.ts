import { config } from '../../config.js';
import type { Db } from '../../db/client.js';
import { capFailures, okResult, type Check } from './check.js';

export const tbIdentityCheck: Check = {
  id: 'tb_identity',
  async run(db: Db, datasetId: string) {
    const tol = config.reconcile.amountToleranceCents;
    const { rows } = await db.query<{ scope: string; delta: string }>(
      `SELECT period || '/' || account AS scope,
              ROUND((
                (opening_debit - opening_credit) +
                (period_debit - period_credit) -
                (closing_debit - closing_credit)
              ) * 100)::bigint AS delta
       FROM trial_balance
       WHERE dataset_id = $1
         AND ABS(ROUND((
                (opening_debit - opening_credit) +
                (period_debit - period_credit) -
                (closing_debit - closing_credit)
              ) * 100)) > $2`,
      [datasetId, tol],
    );

    if (rows.length === 0) {
      return okResult('tb_identity', 'trial balance identity holds for all accounts');
    }

    return {
      check: 'tb_identity',
      ok: false,
      summary: `${rows.length} TB account(s) fail identity`,
      metrics: { failures: rows.length },
      failures: capFailures(rows.map((r) => ({
        scope: r.scope,
        expected: 0,
        actual: Number(r.delta),
        deltaCents: Number(r.delta),
      }))),
    };
  },
};
