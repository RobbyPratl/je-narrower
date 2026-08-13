import { describe, it, expect } from 'vitest';
import { computeConsistency, deviationReasons } from '../src/group/consistency.js';
import { splitDeviations } from '../src/group/deviations.js';
import { buildRecurrence, recurrenceLabel } from '../src/group/recurrence.js';
import type { FlaggedEntry } from '../src/group/types.js';

function entry(overrides: Partial<FlaggedEntry> & { entryId: string }): FlaggedEntry {
  return {
    period: 'P2',
    user: 'Alice',
    amountCents: 100_000,
    lineCount: 2,
    effectiveDate: '2025-01-31',
    postedAt: new Date('2025-01-31T10:00:00Z'),
    narration: null,
    rulesFired: ['round_amount'],
    accountA: '6210',
    accountB: '2110',
    ...overrides,
  };
}

describe('group consistency', () => {
  it('scores tight clusters highly', () => {
    const cluster = [
      entry({ entryId: 'E1', amountCents: 100_000 }),
      entry({ entryId: 'E2', amountCents: 102_000 }),
      entry({ entryId: 'E3', amountCents: 98_000 }),
    ];
    const result = computeConsistency(cluster);
    expect(result.score).toBeGreaterThan(0.9);
    expect(result.detail.some((d) => d.includes('single preparer'))).toBe(true);
  });

  it('splits amount and preparer deviations', () => {
    const cluster = [
      entry({ entryId: 'E1' }),
      entry({ entryId: 'E2' }),
      entry({ entryId: 'E3' }),
      entry({ entryId: 'E4', amountCents: 500_000, user: 'Bob' }),
    ];
    const { members, deviations } = splitDeviations(cluster);
    expect(members).toHaveLength(3);
    expect(deviations).toHaveLength(1);
    expect(deviationReasons(deviations[0]!.entry, 100_000, 'Alice').length).toBeGreaterThan(0);
  });

  it('builds monthly recurrence marks', () => {
    const recurrence = buildRecurrence([
      entry({ entryId: 'E1', effectiveDate: '2025-01-15' }),
      entry({ entryId: 'E2', effectiveDate: '2025-01-28' }),
      entry({ entryId: 'E3', effectiveDate: '2025-02-28' }),
    ]);
    expect(recurrence.byMonth['2025-01']).toBe(2);
    expect(recurrence.byMonth['2025-02']).toBe(1);
  });

  it('counts inactive calendar months as gaps', () => {
    const recurrence = buildRecurrence([
      entry({ entryId: 'E1', effectiveDate: '2025-01-15' }),
      entry({ entryId: 'E2', effectiveDate: '2025-03-15' }),
    ]);
    expect(recurrence.months).toEqual(['2025-01', '2025-02', '2025-03']);
    expect(recurrence.marks).toEqual([1, 0, 1]);
    expect(recurrenceLabel(recurrence)).toBe('observed in multiple months');
  });
});
