import type pg from 'pg';
import { CaseFileSchema, type CaseFile, type Citation } from './case-file.js';
import type { PopulationContext } from '../dataset.js';

export interface VerifierResult {
  ok: boolean;
  failures: Array<{ ref: string; error: string }>;
  checkedCitations: number;
}

export function verifyCaseFile(
  caseFile: CaseFile,
  retrievedRefs: Set<string>,
): VerifierResult {
  const parsed = CaseFileSchema.safeParse(caseFile);
  if (!parsed.success) {
    return {
      ok: false,
      failures: [{ ref: 'schema', error: parsed.error.message }],
      checkedCitations: 0,
    };
  }

  const failures: Array<{ ref: string; error: string }> = [];
  let checked = 0;

  for (const finding of caseFile.agent.findings) {
    for (const citation of finding.citations) {
      checked++;
      const key = refKey(citation);
      if (!retrievedRefs.has(key)) {
        failures.push({ ref: citation.ref, error: 'citation not retrieved by any tool' });
      }
    }
  }

  return { ok: failures.length === 0, failures, checkedCitations: checked };
}

export function refKey(c: Citation): string {
  return `${c.kind}:${c.ref}`;
}

export async function resolveCitations(pool: pg.Pool, context: PopulationContext, citations: Citation[]): Promise<VerifierResult> {
  const failures: Array<{ ref: string; error: string }> = [];
  let checked = 0;

  for (const c of citations) {
    checked++;
    if (c.kind === 'line') {
      const { rows } = await pool.query(`SELECT 1 FROM lines WHERE dataset_id = $1 AND line_id = $2`, [context.datasetId, c.ref]);
      if (!rows[0]) failures.push({ ref: c.ref, error: 'line not found' });
    } else {
      const { rows } = await pool.query(`SELECT 1 FROM entries WHERE dataset_id = $1 AND entry_id = $2`, [context.datasetId, c.ref]);
      if (!rows[0]) failures.push({ ref: c.ref, error: 'entry not found' });
    }
  }

  return { ok: failures.length === 0, failures, checkedCitations: checked };
}

export async function verifyAgainstDb(pool: pg.Pool, context: PopulationContext, caseFile: CaseFile): Promise<VerifierResult> {
  const allCitations = caseFile.agent.findings.flatMap((f) => f.citations);
  return resolveCitations(pool, context, allCitations);
}
