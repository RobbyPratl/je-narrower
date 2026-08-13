import type pg from 'pg';
import { getCurrentPopulation } from '../dataset.js';
import { tieoutFromReport } from './stamp.js';
import type { CheckResult } from '../types.js';

export { buildStamp, tieoutFromReport } from './stamp.js';

export async function buildStatus(pool: pg.Pool, businessId: string) {
  const population = await getCurrentPopulation(pool, businessId);
  if (!population) {
    return { status: 'empty' as const };
  }

  if (population.status === 'load_failed') {
    return {
      status: 'load_failed' as const,
      dataset: population.datasetId,
      reconciliation: population.reconciliation as CheckResult[],
    };
  }

  const report = (population.reconciliation ?? []) as CheckResult[];
  const { grossDeltaCents, exceptions: tieoutExceptions } = tieoutFromReport(report);

  const [periodStats, exceptionCounts] = await Promise.all([
    pool.query<{ period: string; entries: string; lines: string }>(
      `SELECT e.period::text,
              COUNT(DISTINCT e.entry_id)::text AS entries,
              COUNT(l.line_id)::text AS lines
       FROM entries e
       LEFT JOIN lines l ON l.dataset_id = e.dataset_id AND l.entry_id = e.entry_id
       WHERE e.dataset_id = $1 GROUP BY e.period`,
      [population.datasetId],
    ),
    pool.query<{ account: string; period: string; n: string }>(
      `SELECT l.account, e.period::text, COUNT(DISTINCT l.entry_id)::text AS n
       FROM lines l
       JOIN entries e ON e.dataset_id = l.dataset_id AND e.entry_id = l.entry_id
       WHERE l.dataset_id = $1 GROUP BY l.account, e.period`,
      [population.datasetId],
    ),
  ]);

  const tiedByPeriod: Record<string, boolean> = { P1: true, P2: true };
  for (const f of report.find((r) => r.check === 'gl_tb_tieout')?.failures ?? []) {
    const period = f.scope.startsWith('P1') ? 'P1' : 'P2';
    tiedByPeriod[period] = false;
  }

  const countMap = new Map(
    exceptionCounts.rows.map((r) => [`${r.period}:${r.account}`, Number(r.n)]),
  );

  const exceptions = tieoutExceptions.map((ex) => ({
    ...ex,
    entryCount:
      countMap.get(`P1:${ex.account}`) ??
      countMap.get(`P2:${ex.account}`) ??
      0,
  }));

  const canConclude = population.status === 'reconciled' || population.overrideReason !== null;

  return {
    status: population.status,
    businessId: population.businessId,
    dataset: population.datasetId,
    loadedAt: population.loadedAt.toISOString(),
    pipeline: population.pipeline,
    source: { files: population.sourceFiles },
    periods: periodStats.rows.map((r) => ({
      period: r.period,
      entries: Number(r.entries),
      lines: Number(r.lines),
      tied: tiedByPeriod[r.period] ?? true,
    })),
    reconciliation: report,
    exceptions,
    grossDeltaCents,
    canConclude,
    override: population.overrideReason
      ? { reason: population.overrideReason, at: population.overrideAt?.toISOString() ?? null }
      : null,
  };
}
