import type { PopulationStamp } from '@je-narrower/shared';
import type { CheckResult } from '../types.js';

export function tieoutFromReport(report: CheckResult[]): {
  grossDeltaCents: number;
  exceptions: Array<{ account: string; deltaCents: number }>;
} {
  const tieout = report.find((r) => r.check === 'gl_tb_tieout');
  const grossDeltaCents = tieout?.metrics.totalDeltaCents ?? 0;
  const seen = new Set<string>();
  const exceptions: Array<{ account: string; deltaCents: number }> = [];
  for (const f of tieout?.failures ?? []) {
    const account = f.detail ?? f.scope.split('/').slice(1).join('/');
    if (seen.has(account)) continue;
    seen.add(account);
    exceptions.push({ account, deltaCents: f.deltaCents });
  }
  return { grossDeltaCents, exceptions };
}

export function buildStamp(input: {
  datasetId: string;
  status: string;
  report: CheckResult[];
}): PopulationStamp {
  const { grossDeltaCents, exceptions } = tieoutFromReport(input.report);
  return {
    reconciled: input.status === 'reconciled',
    datasetId: input.datasetId,
    asOf: new Date().toISOString(),
    grossDeltaCents,
    exceptions,
  };
}
