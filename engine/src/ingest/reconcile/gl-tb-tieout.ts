import { config } from '../../config.js';
import type { Db } from '../../db/client.js';
import { capFailures, okResult, type Check } from './check.js';

export const glTbTieoutCheck: Check = {
  id: 'gl_tb_tieout',
  async run(db: Db, datasetId: string) {
    const tol = config.reconcile.amountToleranceCents;
    const { rows } = await db.query<{
      scope: string;
      account: string;
      period: string;
      gl_debit: string | null;
      tb_debit: string | null;
      gl_credit: string | null;
      tb_credit: string | null;
    }>(
      `WITH gl AS (
         SELECT e.period, l.account,
                ROUND(SUM(l.debit) * 100)::bigint AS gl_debit,
                ROUND(SUM(l.credit) * 100)::bigint AS gl_credit
         FROM lines l
         JOIN entries e ON e.dataset_id = l.dataset_id AND e.entry_id = l.entry_id
         WHERE l.dataset_id = $1
         GROUP BY e.period, l.account
       ), tb AS (
         SELECT * FROM trial_balance WHERE dataset_id = $1
       )
       SELECT gl.period || '/' || COALESCE(gl.account, tb.account) AS scope,
              COALESCE(gl.account, tb.account) AS account,
              COALESCE(gl.period::text, tb.period::text) AS period,
              gl.gl_debit::text, tb.period_debit AS tb_debit,
              gl.gl_credit::text, tb.period_credit AS tb_credit
       FROM gl
       FULL OUTER JOIN tb
         ON tb.period = gl.period AND tb.account = gl.account
       WHERE ABS(COALESCE(gl.gl_debit, 0) - ROUND(COALESCE(tb.period_debit, 0) * 100)) > $2
          OR ABS(COALESCE(gl.gl_credit, 0) - ROUND(COALESCE(tb.period_credit, 0) * 100)) > $2`,
      [datasetId, tol],
    );

    const failures = rows.map((r) => {
      const glDebit = Number(r.gl_debit ?? 0);
      const tbDebit = Math.round(Number(r.tb_debit ?? 0) * 100);
      const glCredit = Number(r.gl_credit ?? 0);
      const tbCredit = Math.round(Number(r.tb_credit ?? 0) * 100);
      const debitDelta = glDebit - tbDebit;
      const creditDelta = glCredit - tbCredit;
      const deltaCents = Math.abs(debitDelta) >= Math.abs(creditDelta) ? debitDelta : creditDelta;
      return {
        scope: r.scope,
        expected: tbDebit || tbCredit,
        actual: glDebit || glCredit,
        deltaCents,
        detail: r.account,
      };
    });

    const totalDeltaCents = failures.reduce((sum, f) => sum + Math.abs(f.deltaCents), 0);

    if (failures.length === 0) {
      return okResult('gl_tb_tieout', 'GL activity ties to trial balance', { totalDeltaCents: 0 });
    }

    return {
      check: 'gl_tb_tieout',
      ok: false,
      summary: `${failures.length} account(s) do not tie`,
      metrics: { failures: failures.length, totalDeltaCents },
      failures: capFailures(failures),
    };
  },
};
