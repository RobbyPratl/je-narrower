import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import type { PopulationContext } from '../src/dataset.js';
import { buildDeterministicFindings, listFlaggedEntries } from '../src/investigate/entry.js';
import { buildAgentPrompt } from '../src/investigate/provider.js';
import { getEntryLines, getPairHistory, getUserActivity, TOOL_SAMPLE_LIMIT } from '../src/investigate/tools.js';

const context: PopulationContext = {
  businessId: 'cost-test',
  datasetId: 'cost-test-dataset',
  pipeline: { ingested: true, projected: true, scored: true, investigated: false, grouped: false },
};

function poolWithQuery(query: (sql: string, params?: unknown[]) => Promise<unknown>): pg.Pool {
  return { query } as unknown as pg.Pool;
}

describe('investigation cost controls', () => {
  it('uses deterministic findings for a sole simple parametric rule', () => {
    const findings = buildDeterministicFindings('E1', [{
      rule: 'round_amount',
      group: 'parametric',
      score: 1,
      weight: 0.5,
      inputs: { amountCents: 2_500_000 },
    }]);

    expect(findings).toEqual([{
      text: 'Entry amount is exactly 25,000.00.',
      citations: [{ kind: 'entry', ref: 'E1' }],
    }]);
    expect(buildDeterministicFindings('E1', [
      { rule: 'round_amount', group: 'parametric', score: 1, weight: 0.5, inputs: { amountCents: 100_000 } },
      { rule: 'pair_rarity', group: 'population', score: 1, weight: 1, inputs: {} },
    ])).toBeNull();
  });

  it('skips existing cases before applying the batch limit unless forced', async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [{ entry_id: 'E1' }] }));
    const pool = poolWithQuery(query);

    await listFlaggedEntries(pool, context, 25);
    expect(query.mock.calls[0]![0]).toContain('NOT EXISTS');
    expect(query.mock.calls[0]![0]).toContain('LIMIT $3');
    expect(query.mock.calls[0]![1]).toEqual([context.datasetId, config.scoring.flagThreshold, 25]);

    query.mockClear();
    await listFlaggedEntries(pool, context, null, true);
    expect(query.mock.calls[0]![0]).not.toContain('NOT EXISTS');
    expect(query.mock.calls[0]![0]).not.toContain('LIMIT');
  });

  it('caps entry-line evidence while retaining the exact total', async () => {
    const lines = Array.from({ length: 100 }, (_, i) => ({
      line_id: `L${i}`,
      line_no: i + 1,
      account: '1000',
      debit: '1',
      credit: '0',
    }));
    const pool = poolWithQuery(async (sql) => sql.includes('FROM entries')
      ? { rows: [{ entry_id: 'E1', line_count: 100 }] }
      : { rows: lines });

    const result = await getEntryLines(pool, context, 'E1');
    const data = result.data as { lines: unknown[]; lineSummary: { total: number; omitted: number } };
    expect(data.lines).toHaveLength(TOOL_SAMPLE_LIMIT);
    expect(data.lineSummary).toEqual({ total: 100, returned: TOOL_SAMPLE_LIMIT, omitted: 85 });
    expect(result.refs).toHaveLength(TOOL_SAMPLE_LIMIT + 1);
  });

  it('replaces large pair and user corpora with aggregates plus 15 citeable samples', async () => {
    const manyEntries = Array.from({ length: 600 }, (_, i) => ({
      entry_id: `E${i}`,
      effective_date: '2026-01-01',
      total_amount: '100',
      user: 'u',
      source: 'journal',
    }));
    const pairPool = poolWithQuery(async (sql) => sql.includes('COUNT(*)')
      ? { rows: [{ occurrence_count: 600, total_amount: '60000', average_amount: '100' }] }
      : { rows: manyEntries });
    const pair = await getPairHistory(pairPool, context, '1000', '2000', 'P1');
    const pairData = pair.data as { recentOccurrences: unknown[]; summary: { occurrence_count: number } };
    expect(pairData.summary.occurrence_count).toBe(600);
    expect(pairData.recentOccurrences).toHaveLength(TOOL_SAMPLE_LIMIT);
    expect(pair.refs).toHaveLength(TOOL_SAMPLE_LIMIT);

    const userPool = poolWithQuery(async (sql) => {
      if (sql.includes('COUNT(*)') && !sql.includes('GROUP BY')) return { rows: [{ entry_count: 600 }] };
      if (sql.includes('JOIN lines')) return { rows: manyEntries.slice(0, 30).map((_, i) => ({ account: `${i}`, entry_count: 1 })) };
      if (sql.includes('GROUP BY source')) return { rows: manyEntries.slice(0, 30).map((_, i) => ({ source: `${i}`, entry_count: 1 })) };
      return { rows: manyEntries };
    });
    const activity = await getUserActivity(userPool, context, 'u', 'P1');
    const activityData = activity.data as { recentEntries: unknown[]; topAccounts: unknown[]; topSources: unknown[] };
    expect(activityData.recentEntries).toHaveLength(TOOL_SAMPLE_LIMIT);
    expect(activityData.topAccounts).toHaveLength(10);
    expect(activityData.topSources).toHaveLength(10);
    expect(activity.refs).toHaveLength(TOOL_SAMPLE_LIMIT);
    expect(JSON.stringify(activity.data).length).toBeLessThan(JSON.stringify({ entries: manyEntries }).length / 10);
  });

  it('gives the model a concise valid citation example', () => {
    const prompt = buildAgentPrompt({
      entryId: 'E1',
      toolResults: [{ tool: 'get_entry_lines', data: { entry: { entry_id: 'E1', line_count: 2 } } }],
    });
    expect(prompt.system).toContain('a valid response');
    expect(prompt.system).toContain('Never invent or transform a citation ref');
    expect(prompt.user).toContain('"entryId":"E1"');
  });
});
