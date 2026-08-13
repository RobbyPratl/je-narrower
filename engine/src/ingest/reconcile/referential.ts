import type { Db } from '../../db/client.js';
import { capFailures, okResult, type Check } from './check.js';

export const referentialCheck: Check = {
  id: 'referential',
  async run(db: Db, datasetId: string) {
    const { rows } = await db.query<{ scope: string; account: string }>(
      `SELECT DISTINCT e.period || '/' || l.account AS scope, l.account
       FROM lines l
       JOIN entries e ON e.dataset_id = l.dataset_id AND e.entry_id = l.entry_id
       WHERE l.dataset_id = $1
         AND NOT EXISTS (
         SELECT 1 FROM trial_balance tb
         WHERE tb.dataset_id = l.dataset_id
           AND tb.period = e.period
           AND tb.account = l.account
       )`,
      [datasetId],
    );

    if (rows.length === 0) {
      return okResult('referential', 'every GL account exists in period TB');
    }

    return {
      check: 'referential',
      ok: false,
      summary: `${rows.length} GL account(s) missing from TB`,
      metrics: { failures: rows.length },
      failures: capFailures(rows.map((r) => ({
        scope: r.scope,
        expected: 1,
        actual: 0,
        deltaCents: 0,
        detail: r.account,
      }))),
    };
  },
};
