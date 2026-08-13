import type { Db } from '../../db/client.js';
import { capFailures, okResult, type Check } from './check.js';

export const uniquenessCheck: Check = {
  id: 'uniqueness',
  async run(db: Db, datasetId: string) {
    const { rows: dupLines } = await db.query<{ line_id: string }>(
      `SELECT line_id FROM lines
       WHERE dataset_id = $1
       GROUP BY line_id HAVING COUNT(*) > 1`,
      [datasetId],
    );

    const { rows: spanPeriod } = await db.query<{ entry_id: string }>(
      `SELECT entry_id FROM entries
       WHERE dataset_id = $1
       GROUP BY entry_id HAVING COUNT(DISTINCT period) > 1`,
      [datasetId],
    );

    const failures = [
      ...dupLines.map((r) => ({
        scope: r.line_id,
        expected: 1,
        actual: 2,
        deltaCents: 0,
        detail: 'duplicate line_id',
      })),
      ...spanPeriod.map((r) => ({
        scope: r.entry_id,
        expected: 1,
        actual: 2,
        deltaCents: 0,
        detail: 'entry_id spans periods',
      })),
    ];

    if (failures.length === 0) {
      return okResult('uniqueness', 'line_id unique; entry_id period-exclusive');
    }

    return {
      check: 'uniqueness',
      ok: false,
      summary: `${failures.length} uniqueness violation(s)`,
      metrics: { failures: failures.length },
      failures: capFailures(failures),
    };
  },
};
