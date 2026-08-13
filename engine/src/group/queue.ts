import type pg from 'pg';
import { buildStatus } from '../api/status.js';
import type { PopulationContext } from '../dataset.js';
import { recurrenceLabel } from './recurrence.js';

export interface QueueFilters {
  reviewStatus?: string;
  kind?: string;
}

export async function queryQueue(pool: pg.Pool, context: PopulationContext, filters: QueueFilters) {
  const where: string[] = ['rg.dataset_id = $1'];
  const values: unknown[] = [context.datasetId];
  let i = 2;

  if (filters.reviewStatus && filters.reviewStatus !== 'all') {
    where.push(`rg.review_status = $${i++}`);
    values.push(filters.reviewStatus);
  }
  if (filters.kind) {
    where.push(`rg.kind = $${i++}`);
    values.push(filters.kind);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const { rows } = await pool.query(
    `SELECT rg.group_id, rg.kind, rg.account_a, rg.account_b,
            rg.consistency_score::float, rg.consistency_detail, rg.recurrence,
            rg.review_status::text, rg.parent_group_id,
            COUNT(gm.entry_id)::int AS entry_count,
            array_agg(gm.entry_id ORDER BY gm.entry_id) AS entry_ids
     FROM review_groups rg
     JOIN group_members gm ON gm.dataset_id = rg.dataset_id AND gm.group_id = rg.group_id
     ${whereSql}
     GROUP BY rg.dataset_id, rg.group_id
     ORDER BY rg.consistency_score DESC, entry_count DESC`,
    values,
  );

  const { rows: summaryRows } = await pool.query<{
    total_flagged: string;
    reviewed: string;
    open: string;
    groups: string;
    deviations: string;
    individuals: string;
  }>(
    `SELECT
       (SELECT COUNT(DISTINCT gm.entry_id) FROM group_members gm WHERE dataset_id = $1)::text AS total_flagged,
       (SELECT COUNT(*) FROM review_groups WHERE dataset_id = $1 AND review_status = 'reviewed')::text AS reviewed,
       (SELECT COUNT(*) FROM review_groups WHERE dataset_id = $1 AND review_status = 'open')::text AS open,
       (SELECT COUNT(*) FROM review_groups WHERE dataset_id = $1 AND kind = 'group')::text AS groups,
       (SELECT COUNT(*) FROM review_groups WHERE dataset_id = $1 AND kind = 'deviation')::text AS deviations,
       (SELECT COUNT(*) FROM review_groups WHERE dataset_id = $1 AND kind = 'individual')::text AS individuals`,
    [context.datasetId],
  );

  const summary = summaryRows[0]!;

  const entryIdSet = new Set<string>();
  for (const row of rows) {
    for (const id of row.entry_ids as string[]) entryIdSet.add(id);
  }

  const rulesByEntry = await loadRulesFired(pool, context, [...entryIdSet]);
  const targets = rows.map((row) => ({
    targetKind: row.kind === 'group' ? 'group' : 'entry',
    targetId: row.kind === 'group' ? row.group_id : (row.entry_ids as string[])[0]!,
  }));
  const decisions = await loadActiveDecisions(pool, context, targets);
  const superseded = await loadSupersededDecisions(pool, context, targets);

  return {
    summary: {
      totalFlagged: Number(summary.total_flagged),
      reviewed: Number(summary.reviewed),
      open: Number(summary.open),
      groups: Number(summary.groups),
      deviations: Number(summary.deviations),
      individuals: Number(summary.individuals),
    },
    items: rows.map((row) => ({
      groupId: row.group_id,
      kind: row.kind,
      pair: `${row.account_a}↔${row.account_b}`,
      accountA: row.account_a,
      accountB: row.account_b,
      entryCount: row.entry_count,
      entryIds: row.entry_ids as string[],
      rulesFired: unionRules((row.entry_ids as string[]).flatMap((id) => rulesByEntry.get(id) ?? [])),
      consistency: {
        score: Number(row.consistency_score),
        detail: row.consistency_detail as string[],
      },
      recurrence: {
        ...(row.recurrence as object),
        label: recurrenceLabel(row.recurrence as { months: string[]; marks: number[]; byMonth: Record<string, number> }),
      },
      reviewStatus: row.review_status,
      parentGroupId: row.parent_group_id,
      decision: decisions.get(decisionKey(
        row.kind === 'group' ? 'group' : 'entry',
        row.kind === 'group' ? row.group_id : (row.entry_ids as string[])[0]!,
      )) ?? null,
      supersededDecisions: superseded.get(decisionKey(
        row.kind === 'group' ? 'group' : 'entry',
        row.kind === 'group' ? row.group_id : (row.entry_ids as string[])[0]!,
      )) ?? [],
    })),
  };
}

export async function queryQueueGroup(pool: pg.Pool, context: PopulationContext, groupId: string) {
  const { rows } = await pool.query(
    `SELECT rg.*, array_agg(gm.entry_id ORDER BY gm.entry_id) AS entry_ids
     FROM review_groups rg
     JOIN group_members gm ON gm.dataset_id = rg.dataset_id AND gm.group_id = rg.group_id
     WHERE rg.dataset_id = $1 AND rg.group_id = $2
     GROUP BY rg.dataset_id, rg.group_id`,
    [context.datasetId, groupId],
  );
  const row = rows[0];
  if (!row) return null;

  const entryIds = row.entry_ids as string[];
  const status = await buildStatus(pool, context.businessId);

  const { rows: deviations } = await pool.query(
    `SELECT rg.group_id, rg.consistency_detail, array_agg(gm.entry_id) AS entry_ids
     FROM review_groups rg
     JOIN group_members gm ON gm.dataset_id = rg.dataset_id AND gm.group_id = rg.group_id
     WHERE rg.dataset_id = $1 AND rg.parent_group_id = $2 AND rg.kind = 'deviation'
     GROUP BY rg.dataset_id, rg.group_id, rg.consistency_detail`,
    [context.datasetId, groupId],
  );

  const procedures = await rollupProcedures(pool, context, entryIds);
  const targetKind = row.kind === 'group' ? 'group' : 'entry';
  const targetId = row.kind === 'group' ? row.group_id : entryIds[0]!;
  const decisions = await loadActiveDecisions(pool, context, [{ targetKind, targetId }]);
  const superseded = await loadSupersededDecisions(pool, context, [{ targetKind, targetId }]);

  return {
    groupId: row.group_id,
    kind: row.kind,
    pair: `${row.account_a}↔${row.account_b}`,
    accountA: row.account_a,
    accountB: row.account_b,
    entryIds,
    entryCount: entryIds.length,
    groupingBasis: {
      pair: `${row.account_a}↔${row.account_b}`,
      detail: row.consistency_detail as string[],
      recurrence: row.recurrence,
    },
    consistency: {
      score: Number(row.consistency_score),
      detail: row.consistency_detail as string[],
    },
    procedures,
    excludedDeviations: deviations.map((d) => ({
      groupId: d.group_id,
      entryIds: d.entry_ids as string[],
      reasons: d.consistency_detail as string[],
    })),
    reviewStatus: row.review_status,
    canConclude: 'canConclude' in status ? status.canConclude : false,
    decision: decisions.get(decisionKey(targetKind, targetId)) ?? null,
    supersededDecisions: superseded.get(decisionKey(targetKind, targetId)) ?? [],
  };
}

function decisionKey(targetKind: string, targetId: string): string {
  return `${targetKind}:${targetId}`;
}

export interface SupersededDecision {
  decisionId: string;
  conclusion: string;
  basis: string;
  recordedBy: string | null;
  recordedAt: string;
  supersededAt: string;
  reason: string;
}

/**
 * A superseded conclusion stays in the table but stops being the active one, so
 * without this the record exists and nothing can reach it. Each `reopened` row
 * names the decision it replaced in `supersedes_id`.
 */
async function loadSupersededDecisions(
  pool: pg.Pool,
  context: PopulationContext,
  targets: Array<{ targetKind: string; targetId: string }>,
) {
  const map = new Map<string, SupersededDecision[]>();
  const groupIds = targets.filter((t) => t.targetKind === 'group').map((t) => t.targetId);
  const entryIds = targets.filter((t) => t.targetKind === 'entry').map((t) => t.targetId);
  if (groupIds.length === 0 && entryIds.length === 0) return map;

  const { rows } = await pool.query<{
    target_kind: string;
    target_id: string;
    decision_id: string;
    conclusion: string;
    basis: string;
    recorded_by: string | null;
    recorded_at: Date;
    superseded_at: Date;
    reason: string;
  }>(
    `SELECT prior.target_kind, prior.target_id, prior.decision_id, prior.conclusion, prior.basis,
            prior.record->>'recordedBy' AS recorded_by, prior.recorded_at,
            newer.recorded_at AS superseded_at, newer.basis AS reason
     FROM decisions newer
     JOIN decisions prior
       ON prior.dataset_id = newer.dataset_id AND prior.decision_id = newer.supersedes_id
     WHERE newer.dataset_id = $1
       AND newer.supersedes_id IS NOT NULL
       AND ((prior.target_kind = 'group' AND prior.target_id = ANY($2::text[]))
         OR (prior.target_kind = 'entry' AND prior.target_id = ANY($3::text[])))
     ORDER BY newer.recorded_at DESC`,
    [context.datasetId, groupIds, entryIds],
  );

  for (const row of rows) {
    const key = decisionKey(row.target_kind, row.target_id);
    const list = map.get(key) ?? [];
    list.push({
      decisionId: row.decision_id,
      conclusion: row.conclusion,
      basis: row.basis,
      recordedBy: row.recorded_by,
      recordedAt: row.recorded_at.toISOString(),
      supersededAt: row.superseded_at.toISOString(),
      reason: row.reason,
    });
    map.set(key, list);
  }
  return map;
}

async function loadActiveDecisions(
  pool: pg.Pool,
  context: PopulationContext,
  targets: Array<{ targetKind: string; targetId: string }>,
) {
  const map = new Map<string, {
    decisionId: string;
    conclusion: string;
    basis: string;
    recordedBy: string | null;
    recordedAt: string;
  }>();
  const groupIds = targets.filter((t) => t.targetKind === 'group').map((t) => t.targetId);
  const entryIds = targets.filter((t) => t.targetKind === 'entry').map((t) => t.targetId);
  if (groupIds.length === 0 && entryIds.length === 0) return map;

  const { rows } = await pool.query<{
    decision_id: string;
    target_kind: string;
    target_id: string;
    conclusion: string;
    basis: string;
    recorded_by: string | null;
    recorded_at: Date;
  }>(
    `SELECT DISTINCT ON (target_kind, target_id)
            decision_id, target_kind, target_id, conclusion, basis,
            record->>'recordedBy' AS recorded_by, recorded_at
     FROM decisions
     WHERE dataset_id = $1
       AND ((target_kind = 'group' AND target_id = ANY($2::text[]))
         OR (target_kind = 'entry' AND target_id = ANY($3::text[])))
     ORDER BY target_kind, target_id, recorded_at DESC, decision_id DESC`,
    [context.datasetId, groupIds, entryIds],
  );
  for (const row of rows) {
    if (row.conclusion === 'reopened') continue;
    map.set(decisionKey(row.target_kind, row.target_id), {
      decisionId: row.decision_id,
      conclusion: row.conclusion,
      basis: row.basis,
      recordedBy: row.recorded_by,
      recordedAt: row.recorded_at.toISOString(),
    });
  }
  return map;
}

async function rollupProcedures(pool: pg.Pool, context: PopulationContext, entryIds: string[]) {
  if (entryIds.length === 0) return [];

  const labels: Record<string, string> = {
    get_entry_lines: 'line detail retrieved',
    get_pair_history: 'pair history retrieved',
    get_pair_diff: 'prior-period comparison',
    get_similar_entries: 'similar entries retrieved',
    get_user_activity: 'preparer history',
    get_account_context: 'account context retrieved',
  };

  const { rows } = await pool.query<{ entry_id: string; case_file: { agent?: { plan?: Array<{ tool: string; executed: boolean }> } } }>(
    `SELECT entry_id, case_file FROM cases WHERE dataset_id = $1 AND entry_id = ANY($2::text[])`,
    [context.datasetId, entryIds],
  );
  const caseByEntry = new Map(rows.map((r) => [r.entry_id, r.case_file]));

  const toolCounts = new Map<string, { done: number; total: number }>();
  for (const tool of Object.keys(labels)) {
    toolCounts.set(tool, { done: 0, total: entryIds.length });
  }

  for (const entryId of entryIds) {
    const caseFile = caseByEntry.get(entryId);
    if (!caseFile) continue;
    const executed = new Set(
      (caseFile.agent?.plan ?? []).filter((s) => s.executed).map((s) => s.tool),
    );
    for (const tool of executed) {
      const cur = toolCounts.get(tool);
      if (cur) cur.done++;
    }
  }

  return [...toolCounts.entries()]
    .filter(([tool]) => labels[tool])
    .map(([tool, { done, total }]) => ({
      label: labels[tool]!,
      done,
      total,
    }));
}

async function loadRulesFired(pool: pg.Pool, context: PopulationContext, entryIds: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (entryIds.length === 0) return map;

  const { rows } = await pool.query<{ entry_id: string; rules: string[] }>(
    `SELECT entry_id, array_agg(DISTINCT rule) AS rules
     FROM scores WHERE dataset_id = $1 AND entry_id = ANY($2::text[])
     GROUP BY entry_id`,
    [context.datasetId, entryIds],
  );
  for (const row of rows) map.set(row.entry_id, row.rules);
  return map;
}

function unionRules(rules: string[]): string[] {
  return [...new Set(rules)].sort();
}

export async function getEntryGroup(pool: pg.Pool, context: PopulationContext, entryId: string) {
  const { rows } = await pool.query<{ group_id: string; is_deviation: boolean }>(
    `SELECT group_id, is_deviation FROM group_members WHERE dataset_id = $1 AND entry_id = $2 LIMIT 1`,
    [context.datasetId, entryId],
  );
  return rows[0] ?? null;
}
