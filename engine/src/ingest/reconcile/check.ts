import type { Db } from '../../db/client.js';
import type { CheckResult } from '../../types.js';

export interface Check {
  id: string;
  run(db: Db, datasetId: string): Promise<CheckResult>;
}

export function okResult(check: string, summary: string, metrics: Record<string, number> = {}): CheckResult {
  return { check, ok: true, summary, metrics, failures: [] };
}

export function capFailures<T>(failures: T[], limit = 50): T[] {
  return failures.slice(0, limit);
}
