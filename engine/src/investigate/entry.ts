import type pg from 'pg';
import type { PopulationStamp } from '@je-narrower/shared';
import { agentConfig, config } from '../config.js';
import { compositeSubquery } from '../scoring/run.js';
import { buildStamp } from '../api/stamp.js';
import { resolvePopulation, type PopulationContext } from '../dataset.js';
import type { CheckResult } from '../types.js';
import type { CaseFile } from './case-file.js';
import type { Citation } from './case-file.js';
import { buildPlan, ruleGroup, ruleWeight } from './plan.js';
import { generateFindings, type GenerateInput, type GenerateOutput } from './provider.js';
import { runTool, type ToolName } from './tools.js';
import { verifyAgainstDb, verifyCaseFile, refKey as citationKey } from './verifier.js';

export async function listFlaggedEntries(
  pool: pg.Pool,
  context: PopulationContext,
  limit?: number | null,
  includeInvestigated = false,
): Promise<string[]> {
  const sql = compositeSubquery('$1');
  let query = `SELECT sub.entry_id FROM (${sql}) sub WHERE sub.composite >= $2`;
  const params: unknown[] = [context.datasetId, config.scoring.flagThreshold];
  if (!includeInvestigated) {
    query += ` AND NOT EXISTS (
      SELECT 1 FROM cases c
      WHERE c.dataset_id = sub.dataset_id AND c.entry_id = sub.entry_id
    )`;
  }
  query += ' ORDER BY sub.composite DESC, sub.entry_id';
  if (limit != null) {
    query += ` LIMIT $3`;
    params.push(limit);
  }
  const { rows } = await pool.query<{ entry_id: string }>(query, params);
  return rows.map((r) => r.entry_id);
}

async function loadEngine(pool: pg.Pool, context: PopulationContext, entryId: string) {
  const sql = compositeSubquery('$1');
  const [{ rows: scores }, { rows: composite }] = await Promise.all([
    pool.query<{ rule: string; score: string; inputs: Record<string, unknown> }>(
      `SELECT rule, score::text, inputs FROM scores WHERE dataset_id = $1 AND entry_id = $2`,
      [context.datasetId, entryId],
    ),
    pool.query<{ composite: string }>(
      `SELECT composite::text FROM (${sql}) sub WHERE entry_id = $2`,
      [context.datasetId, entryId],
    ),
  ]);
  return {
    composite: Number(composite[0]?.composite ?? 0),
    rules: scores.map((s) => ({
      rule: s.rule,
      group: ruleGroup(s.rule),
      score: Number(s.score),
      weight: ruleWeight(s.rule),
      inputs: s.inputs ?? {},
    })),
    firedRules: scores.map((s) => ({ rule: s.rule, inputs: s.inputs ?? {} })),
  };
}

type EngineRule = Awaited<ReturnType<typeof loadEngine>>['rules'][number];

const DETERMINISTIC_RULES = new Set(['round_amount', 'off_hours', 'date_mismatch']);

export function buildDeterministicFindings(
  entryId: string,
  rules: EngineRule[],
): Array<{ text: string; citations: Citation[] }> | null {
  if (rules.length !== 1 || !DETERMINISTIC_RULES.has(rules[0]!.rule)) return null;

  const [{ rule, inputs }] = rules;
  const citation: Citation[] = [{ kind: 'entry', ref: entryId }];
  if (rule === 'round_amount') {
    const amount = Number(inputs.amountCents);
    if (!Number.isFinite(amount)) return null;
    return [{
      text: `Entry amount is exactly ${(amount / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}.`,
      citations: citation,
    }];
  }
  if (rule === 'off_hours') {
    const postedAt = String(inputs.postedAt ?? '');
    const hour = Number(inputs.hour);
    if (!postedAt || !Number.isFinite(hour)) return null;
    const timing = inputs.isWeekend === true ? 'on a weekend' : `during hour ${hour}`;
    return [{ text: `Entry was posted ${timing} at ${postedAt}.`, citations: citation }];
  }

  const lagDays = Number(inputs.lagDays);
  const effectiveDate = String(inputs.effectiveDate ?? '');
  const postedAt = String(inputs.postedAt ?? '');
  if (!Number.isFinite(lagDays) || !effectiveDate || !postedAt) return null;
  return [{
    text: `Entry was posted ${lagDays} days after its ${effectiveDate} effective date, at ${postedAt}.`,
    citations: citation,
  }];
}

export async function buildPopulationStamp(pool: pg.Pool, context: PopulationContext): Promise<PopulationStamp> {
  const dataset = await resolvePopulation(pool, context.businessId, context.datasetId);
  return buildStamp({
    datasetId: dataset.datasetId,
    status: dataset.status,
    report: (dataset.reconciliation ?? []) as CheckResult[],
  });
}

export async function investigateEntry(
  pool: pg.Pool,
  context: PopulationContext,
  entryId: string,
  population: PopulationStamp,
  options: InvestigationOptions = {},
): Promise<CaseFile> {
  const { rows: entryRows } = await pool.query<{
    entry_id: string;
    period: string;
    user: string;
  }>(`SELECT entry_id, period::text, "user" FROM entries WHERE dataset_id = $1 AND entry_id = $2`, [context.datasetId, entryId]);

  const entry = entryRows[0];
  if (!entry) throw new Error(`entry not found: ${entryId}`);

  const engine = await loadEngine(pool, context, entryId);
  const deterministicFindings = buildDeterministicFindings(entryId, engine.rules);
  if (deterministicFindings) {
    const retrievedRefs = new Set([`entry:${entryId}`]);
    let caseFile = assembleCaseFile({
      entryId,
      population,
      engine,
      executedPlan: [],
      findings: deterministicFindings,
      verifierStatus: 'passed',
      failures: [],
      checkedCitations: 0,
      model: 'template:deterministic',
    });
    const verify = mergeVerify(
      verifyCaseFile(caseFile, retrievedRefs),
      await verifyAgainstDb(pool, context, caseFile),
    );
    caseFile = assembleCaseFile({
      entryId,
      population,
      engine,
      executedPlan: [],
      findings: verify.ok ? deterministicFindings : [],
      verifierStatus: verify.ok ? 'passed' : 'escalated',
      failures: verify.failures,
      checkedCitations: verify.checkedCitations,
      model: 'template:deterministic',
    });
    await upsertCase(pool, context, entryId, caseFile, [], verify.ok ? null : { failures: verify.failures });
    return caseFile;
  }
  const planSteps = buildPlan(entryId, entry.period, entry.user, engine.firedRules);

  const retrievedRefs = new Set<string>();
  const toolResults: Array<{ tool: string; data: unknown }> = [];
  const executedPlan: CaseFile['agent']['plan'] = [];

  for (let i = 0; i < planSteps.length; i++) {
    const step = planSteps[i]!;
    try {
      const result = await runTool(pool, context, step.tool as ToolName, step.args);
      for (const ref of result.refs) retrievedRefs.add(citationKey(ref));
      toolResults.push({ tool: step.tool, data: result.data });
      executedPlan.push({
        step: i + 1,
        tool: step.tool,
        reason: step.reason,
        executed: true,
      });
    } catch (err) {
      executedPlan.push({
        step: i + 1,
        tool: step.tool,
        reason: step.reason,
        executed: false,
      });
      throw err;
    }
  }

  retrievedRefs.add(`entry:${entryId}`);
  const allowedCitations = citationAllowlist(entryId, retrievedRefs);

  let verifierStatus: CaseFile['verifier']['status'] = 'passed';
  let failures: CaseFile['verifier']['failures'] = [];
  let findings: CaseFile['agent']['findings'] = [];
  let verifierTrace: unknown = null;

  try {
    const generate = options.generate ?? generateFindings;
    let output = await generate({ entryId, toolResults, allowedCitations });
    findings = output.findings;

    let caseFile = assembleCaseFile({
      entryId,
      population,
      engine,
      executedPlan,
      findings,
      verifierStatus: 'passed',
      failures: [],
      checkedCitations: 0,
      model: options.model,
    });

    let verify = verifyCaseFile(caseFile, retrievedRefs);
    let dbVerify = await verifyAgainstDb(pool, context, caseFile);
    verify = mergeVerify(verify, dbVerify);

    if (!verify.ok && config.agent.verifierRetries > 0) {
      output = await generate({
        entryId,
        toolResults,
        allowedCitations,
        verifierFailures: verify.failures.map((f) => `${f.ref}: ${f.error}`),
      });
      findings = output.findings;
      caseFile = assembleCaseFile({
        entryId,
        population,
        engine,
        executedPlan,
        findings,
        verifierStatus: 'retried',
        failures: [],
        checkedCitations: 0,
        model: options.model,
      });
      verify = verifyCaseFile(caseFile, retrievedRefs);
      dbVerify = await verifyAgainstDb(pool, context, caseFile);
      verify = mergeVerify(verify, dbVerify);
      verifierStatus = verify.ok ? 'retried' : 'escalated';
    } else if (!verify.ok) {
      verifierStatus = 'escalated';
    }

    if (!verify.ok) {
      failures = verify.failures;
      findings = [];
      verifierTrace = { failures: verify.failures, raw: output.raw };
    } else {
      failures = [];
    }

    caseFile = assembleCaseFile({
      entryId,
      population,
      engine,
      executedPlan,
      findings,
      verifierStatus,
      failures,
      checkedCitations: verify.checkedCitations,
      model: options.model,
    });

    await upsertCase(pool, context, entryId, caseFile, planSteps, verifierTrace);
    return caseFile;
  } catch (err) {
    const caseFile = assembleCaseFile({
      entryId,
      population,
      engine,
      executedPlan,
      findings: [],
      verifierStatus: 'escalated',
      failures: [{ ref: 'agent', error: err instanceof Error ? err.message : String(err) }],
      checkedCitations: 0,
      model: options.model,
    });
    verifierTrace = { error: err instanceof Error ? err.message : String(err) };
    await upsertCase(pool, context, entryId, caseFile, planSteps, verifierTrace);
    return caseFile;
  }
}

export interface InvestigationOptions {
  generate?: (input: GenerateInput) => Promise<GenerateOutput> | GenerateOutput;
  model?: string;
}

function citationAllowlist(entryId: string, refs: Set<string>): Citation[] {
  const target: Citation = { kind: 'entry', ref: entryId };
  const others: Citation[] = [];
  for (const value of refs) {
    const separator = value.indexOf(':');
    if (separator < 0) continue;
    const kind = value.slice(0, separator);
    const ref = value.slice(separator + 1);
    if (kind !== 'line') continue;
    others.push({ kind: 'line', ref });
    if (others.length === 19) break;
  }
  return [target, ...others];
}

function assembleCaseFile(input: {
  entryId: string;
  population: PopulationStamp;
  engine: Awaited<ReturnType<typeof loadEngine>>;
  executedPlan: CaseFile['agent']['plan'];
  findings: CaseFile['agent']['findings'];
  verifierStatus: CaseFile['verifier']['status'];
  failures: CaseFile['verifier']['failures'];
  checkedCitations: number;
  model?: string;
}): CaseFile {
  return {
    entryId: input.entryId,
    generatedAt: new Date().toISOString(),
    model: input.model ?? `${agentConfig.provider}:${agentConfig.model}`,
    population: input.population,
    engine: {
      composite: input.engine.composite,
      rules: input.engine.rules,
    },
    agent: {
      plan: input.executedPlan,
      findings: input.findings,
    },
    verifier: {
      status: input.verifierStatus,
      checkedCitations: input.checkedCitations,
      failures: input.failures,
    },
    review: {
      status: 'open',
      note: null,
      reviewedAt: null,
      populationReconciledAtReview: null,
    },
  };
}

function mergeVerify(
  a: { ok: boolean; failures: Array<{ ref: string; error: string }>; checkedCitations: number },
  b: { ok: boolean; failures: Array<{ ref: string; error: string }>; checkedCitations: number },
) {
  const failures = [...a.failures, ...b.failures];
  return {
    ok: a.ok && b.ok,
    failures,
    checkedCitations: a.checkedCitations + b.checkedCitations,
  };
}

async function upsertCase(
  pool: pg.Pool,
  context: PopulationContext,
  entryId: string,
  caseFile: CaseFile,
  plan: unknown,
  verifierTrace: unknown,
) {
  await pool.query(
    `INSERT INTO cases (dataset_id, entry_id, case_file, plan, verifier_status, verifier_trace, model, review_status)
     VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6::jsonb, $7, 'open')
     ON CONFLICT (dataset_id, entry_id) DO UPDATE SET
       case_file = EXCLUDED.case_file,
       plan = EXCLUDED.plan,
       verifier_status = EXCLUDED.verifier_status,
       verifier_trace = EXCLUDED.verifier_trace,
       model = EXCLUDED.model,
       created_at = now(),
       review_status = 'open',
       review_note = NULL,
       reviewed_at = NULL,
       review_population_reconciled = NULL`,
    [
      context.datasetId,
      entryId,
      JSON.stringify(caseFile),
      JSON.stringify(plan),
      caseFile.verifier.status,
      verifierTrace ? JSON.stringify(verifierTrace) : null,
      caseFile.model,
    ],
  );
}

export async function getCase(pool: pg.Pool, context: PopulationContext, entryId: string): Promise<CaseFile | null> {
  const { rows } = await pool.query<{ case_file: CaseFile }>(
    `SELECT case_file FROM cases WHERE dataset_id = $1 AND entry_id = $2`,
    [context.datasetId, entryId],
  );
  return rows[0]?.case_file ?? null;
}
