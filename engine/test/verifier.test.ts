import { describe, it, expect } from 'vitest';
import type { CaseFile } from '../src/investigate/case-file.js';
import { verifyCaseFile } from '../src/investigate/verifier.js';

function baseCase(overrides: Partial<CaseFile> = {}): CaseFile {
  return {
    entryId: 'E-001',
    generatedAt: new Date().toISOString(),
    model: 'mock:test',
    population: {
      reconciled: true,
      datasetId: 'test',
      asOf: new Date().toISOString(),
      grossDeltaCents: 0,
      exceptions: [],
    },
    engine: { composite: 0.5, rules: [] },
    agent: {
      plan: [{ step: 1, tool: 'get_entry_lines', reason: 'baseline', executed: true }],
      findings: [],
    },
    verifier: { status: 'passed', checkedCitations: 0, failures: [] },
    review: { status: 'open', note: null, reviewedAt: null, populationReconciledAtReview: null },
    ...overrides,
  };
}

describe('verifier', () => {
  it('passes when all citations were retrieved', () => {
    const refs = new Set(['entry:E-001', 'line:L-001']);
    const caseFile = baseCase({
      agent: {
        plan: [],
        findings: [
          { text: 'Entry has one line.', citations: [{ kind: 'entry', ref: 'E-001' }] },
          { text: 'Line posts to cash.', citations: [{ kind: 'line', ref: 'L-001' }] },
        ],
      },
    });
    const result = verifyCaseFile(caseFile, refs);
    expect(result.ok).toBe(true);
    expect(result.failures).toHaveLength(0);
    expect(result.checkedCitations).toBe(2);
  });

  it('rejects citations not returned by tools', () => {
    const refs = new Set(['entry:E-001']);
    const caseFile = baseCase({
      agent: {
        plan: [],
        findings: [
          { text: 'Fabricated line reference.', citations: [{ kind: 'line', ref: 'L-999' }] },
        ],
      },
    });
    const result = verifyCaseFile(caseFile, refs);
    expect(result.ok).toBe(false);
    expect(result.failures[0]?.ref).toBe('L-999');
    expect(result.failures[0]?.error).toContain('not retrieved');
  });

  it('rejects case file with empty citations on a finding', () => {
    const refs = new Set<string>();
    const caseFile = baseCase({
      agent: {
        plan: [],
        findings: [{ text: 'No citations.', citations: [] as unknown as CaseFile['agent']['findings'][0]['citations'] }],
      },
    });
    const schema = verifyCaseFile(caseFile, refs);
    expect(schema.ok).toBe(false);
  });
});
