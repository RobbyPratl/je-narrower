import type { Db } from '../../db/client.js';
import type { ReconciliationState } from '../../types.js';
import { continuityCheck } from './continuity.js';
import type { Check } from './check.js';
import { glTbTieoutCheck } from './gl-tb-tieout.js';
import { referentialCheck } from './referential.js';
import { tbIdentityCheck } from './tb-identity.js';
import { uniquenessCheck } from './uniqueness.js';
import { voucherBalanceCheck } from './voucher-balance.js';

const CHECKS: Check[] = [
  voucherBalanceCheck,
  tbIdentityCheck,
  glTbTieoutCheck,
  continuityCheck,
  referentialCheck,
  uniquenessCheck,
];

export async function runReconciliation(
  db: Db,
  businessId: string,
  datasetId: string,
): Promise<ReconciliationState> {
  const report = [];
  for (const check of CHECKS) {
    report.push(await check.run(db, datasetId));
  }

  const tieout = report.find((r) => r.check === 'gl_tb_tieout');
  const grossDeltaCents = tieout?.metrics.totalDeltaCents ?? 0;

  const exceptions: ReconciliationState['exceptions'] = [];
  if (tieout && !tieout.ok) {
    for (const f of tieout.failures) {
      const account = f.detail ?? f.scope.split('/').slice(1).join('/');
      const period = f.scope.startsWith('P1') ? 'P1' : 'P2';
      const { rows } = await db.query<{ n: string }>(
        `SELECT COUNT(DISTINCT l.entry_id)::text AS n
         FROM lines l
         JOIN entries e ON e.dataset_id = l.dataset_id AND e.entry_id = l.entry_id
         WHERE l.dataset_id = $1 AND l.account = $2 AND e.period = $3`,
        [datasetId, account, period],
      );
      exceptions.push({
        account,
        deltaCents: f.deltaCents,
        entryCount: Number(rows[0]?.n ?? 0),
      });
    }
  }

  const reconciled = report.every((r) => r.ok);
  const status = reconciled ? 'reconciled' : 'unreconciled';

  await db.query(
    `UPDATE datasets SET is_current = false
     WHERE business_id = $1 AND dataset_id <> $2 AND is_current`,
    [businessId, datasetId],
  );
  await db.query(
    `UPDATE datasets
     SET status = $3, reconciliation = $4::jsonb, is_current = true
     WHERE business_id = $1 AND dataset_id = $2`,
    [businessId, datasetId, status, JSON.stringify(report)],
  );

  return { reconciled, report, grossDeltaCents, exceptions };
}
