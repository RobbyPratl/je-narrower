import { config } from '../../config.js';
import type { Db } from '../../db/client.js';
import { capFailures, okResult, type Check } from './check.js';

export const voucherBalanceCheck: Check = {
  id: 'voucher_balance',
  async run(db: Db, datasetId: string) {
    const tol = config.reconcile.amountToleranceCents;
    const { rows } = await db.query<{ entry_id: string; debit: string; credit: string }>(
      `SELECT entry_id,
              ROUND(SUM(debit) * 100)::bigint AS debit,
              ROUND(SUM(credit) * 100)::bigint AS credit
       FROM lines
       WHERE dataset_id = $1
       GROUP BY entry_id
       HAVING ABS(ROUND(SUM(debit) * 100) - ROUND(SUM(credit) * 100)) > $2`,
      [datasetId, tol],
    );

    if (rows.length === 0) {
      const { rows: total } = await db.query<{ n: string }>(
        'SELECT COUNT(*)::text AS n FROM entries WHERE dataset_id = $1',
        [datasetId],
      );
      return okResult('voucher_balance', `${total[0]?.n ?? 0} vouchers balance`, { vouchers: Number(total[0]?.n ?? 0) });
    }

    return {
      check: 'voucher_balance',
      ok: false,
      summary: `${rows.length} voucher(s) out of balance`,
      metrics: { failures: rows.length },
      failures: capFailures(rows.map((r) => ({
        scope: r.entry_id,
        expected: Number(r.debit),
        actual: Number(r.credit),
        deltaCents: Number(r.debit) - Number(r.credit),
      }))),
    };
  },
};
