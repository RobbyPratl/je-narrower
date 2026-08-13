import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { createBusiness, listBusinesses, listBusinessDatasets, requireBusiness } from '../business.js';
import { config } from '../config.js';
import {
  ApiError,
  requireCurrentPopulation,
  requirePipelineStage,
  updatePipeline,
} from '../dataset.js';
import { withTransaction } from '../db/client.js';
import {
  CONCLUSIONS,
  getDecision,
  recordEntryDecision,
  recordGroupDecision,
  reopenDecision,
} from '../decisions/record.js';
import { runDiff, runProjection } from '../graph/run.js';
import { runGrouping } from '../group/build.js';
import { queryQueue, queryQueueGroup } from '../group/queue.js';
import { updateGroupMembers } from '../group/members.js';
import { runIngest, runIngestFromUpload } from '../ingest/index.js';
import { runInvestigateBatch } from '../investigate/batch.js';
import { buildPopulationStamp, getCase, investigateEntry } from '../investigate/entry.js';
import { getJob } from '../jobs.js';
import { startPipelineRun, type RunFrom } from '../pipeline/run.js';
import { countFlagged, runScoring } from '../scoring/run.js';
import { resolveCitation } from './citations.js';
import { buildProfile, getEntry, queryEntries, queryGraph } from './queries.js';
import { buildStatus } from './status.js';

const businessParams = z.object({ businessId: z.string().min(1) });
const entryParams = businessParams.extend({ entryId: z.string().min(1) });
const jobParams = businessParams.extend({ jobId: z.string().min(1) });
const groupParams = businessParams.extend({ groupId: z.string().min(1) });
const decisionParams = businessParams.extend({ decisionId: z.string().min(1) });
const citationParams = businessParams.extend({ kind: z.string().min(1), ref: z.string().min(1) });

const businessBody = z.object({
  businessId: z.string().trim().min(1),
  name: z.string().trim().min(1),
  sourceCompany: z.string().trim().min(1).nullable().optional(),
});
const ingestBody = z.object({
  datasetId: z.string().min(1),
  gl: z.object({ p1: z.string().min(1), p2: z.string().min(1) }),
  tb: z.object({ p1: z.string().min(1), p2: z.string().min(1) }),
});
const overrideBody = z.object({ reason: z.string().trim().min(1) });
const investigateBody = z.object({
  limit: z.number().int().nonnegative().nullable().optional(),
  force: z.boolean().optional(),
});
const reinvestigateBody = z.object({ force: z.boolean().optional() });
const runBody = z.object({
  from: z.enum(['project', 'score', 'investigate', 'group']).optional(),
  investigateLimit: z.number().int().nonnegative().nullable().optional(),
});
const groupDecisionBody = z.object({
  conclusion: z.enum(CONCLUSIONS),
  basis: z.string().optional(),
  recordedBy: z.string().trim().min(1).optional(),
  entryIds: z.array(z.string().min(1)).min(1),
  excludedDeviations: z.array(z.string().min(1)).optional(),
});
const entryDecisionBody = z.object({
  conclusion: z.enum(CONCLUSIONS),
  basis: z.string().optional(),
  recordedBy: z.string().trim().min(1).optional(),
});
const reopenBody = z.object({ reason: z.string().trim().min(1) });
const optionalNumber = z.string().regex(/^\d+(?:\.\d+)?$/).transform(Number).optional();
const entriesQuery = z.object({
  period: z.string().optional(),
  account: z.string().optional(),
  minScore: optionalNumber,
  rule: z.string().optional(),
  sort: z.string().optional(),
  order: z.string().optional(),
  limit: z.string().regex(/^\d+$/).transform(Number).optional(),
  offset: z.string().regex(/^\d+$/).transform(Number).optional(),
});
const graphQuery = z.object({ mode: z.string().optional() });
const queueQuery = z.object({ reviewStatus: z.string().optional(), kind: z.string().optional() });
const memberChangeBody = z.object({
  add: z.array(z.string().min(1)).optional(),
  remove: z.array(z.string().min(1)).optional(),
}).refine((body) => (body.add?.length ?? 0) > 0 || (body.remove?.length ?? 0) > 0, {
  message: 'add or remove required',
});

function parse<S extends z.ZodTypeAny>(schema: S, input: unknown, message = 'invalid request'): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) throw new ApiError(400, 'invalid_request', message);
  return result.data;
}

async function currentPopulation(
  pool: pg.Pool,
  businessId: string,
  stage?: Parameters<typeof requirePipelineStage>[1],
) {
  const population = await requireCurrentPopulation(pool, businessId);
  if (stage) requirePipelineStage(population, stage);
  return population;
}

export function registerRoutes(app: FastifyInstance, pool: pg.Pool, repoRoot?: string) {
  app.get('/api/businesses', async () => ({ businesses: await listBusinesses(pool) }));

  app.post('/api/businesses', async (req, reply) => {
    const business = await createBusiness(pool, parse(businessBody, req.body, 'businessId and name required'));
    return reply.code(201).send(business);
  });

  app.get('/api/businesses/:businessId/datasets', async (req) => {
    const { businessId } = parse(businessParams, req.params);
    return { datasets: await listBusinessDatasets(pool, businessId) };
  });

  app.post('/api/businesses/:businessId/datasets/ingest', async (req) => {
    const { businessId } = parse(businessParams, req.params);

    if (req.isMultipart()) {
      await requireBusiness(pool, businessId);
      const fields: Record<string, string> = {};
      const files: Record<string, Buffer> = {};
      const names: Record<string, string> = {};
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          files[part.fieldname] = await part.toBuffer();
          names[part.fieldname] = part.filename;
        } else {
          fields[part.fieldname] = String(part.value);
        }
      }
      const datasetId = fields.datasetId;
      if (!datasetId) throw new ApiError(400, 'invalid_request', 'datasetId required');
      for (const key of ['glP1', 'glP2', 'tbP1', 'tbP2']) {
        if (!files[key]) throw new ApiError(400, 'invalid_request', `${key} file required`);
      }
      return runIngestFromUpload(pool, {
        businessId,
        datasetId,
        files: { glP1: files.glP1!, glP2: files.glP2!, tbP1: files.tbP1!, tbP2: files.tbP2! },
        names: {
          glP1: names.glP1 ?? 'gl_p1.csv',
          glP2: names.glP2 ?? 'gl_p2.csv',
          tbP1: names.tbP1 ?? 'tb_p1.csv',
          tbP2: names.tbP2 ?? 'tb_p2.csv',
        },
      });
    }

    const body = parse(ingestBody, req.body, 'datasetId and gl.p1/p2, tb.p1/p2 required (or multipart upload)');
    await requireBusiness(pool, businessId);
    return runIngest(pool, {
      businessId,
      datasetId: body.datasetId,
      glFiles: [body.gl.p1, body.gl.p2],
      tbFiles: [body.tb.p1, body.tb.p2],
      repoRoot,
    });
  });

  app.get('/api/businesses/:businessId/status', async (req, reply) => {
    const { businessId } = parse(businessParams, req.params);
    await requireBusiness(pool, businessId);
    const status = await buildStatus(pool, businessId);
    if (status.status === 'empty') return reply.code(404).send({ error: 'no_dataset', message: 'no dataset loaded' });
    if (status.status === 'load_failed') {
      return reply.code(503).send({ error: 'load_failed', report: status.reconciliation });
    }
    return status;
  });

  app.post('/api/businesses/:businessId/override', async (req) => {
    const { businessId } = parse(businessParams, req.params);
    const body = parse(overrideBody, req.body, 'reason required');
    const population = await currentPopulation(pool, businessId);
    await pool.query(
      `UPDATE datasets SET override_reason = $1, override_at = now()
       WHERE business_id = $2 AND dataset_id = $3`,
      [body.reason, businessId, population.datasetId],
    );
    return buildStatus(pool, businessId);
  });

  app.post('/api/businesses/:businessId/datasets/project', async (req) => {
    const { businessId } = parse(businessParams, req.params);
    const population = await currentPopulation(pool, businessId, 'ingested');
    const result = await withTransaction(pool, async (db) => {
      const projection = await runProjection(db, population.datasetId);
      const diff = await runDiff(db, population.datasetId);
      return { pairs: projection.pairs, diff, skipped: projection.skipped };
    });
    await updatePipeline(pool, population, { projected: true, scored: false, investigated: false, grouped: false });
    return result;
  });

  app.post('/api/businesses/:businessId/datasets/score', async (req) => {
    const { businessId } = parse(businessParams, req.params);
    const population = await currentPopulation(pool, businessId, 'projected');
    const result = await withTransaction(pool, async (db) => runScoring(db, population.datasetId));
    const flagged = await countFlagged(pool, population.datasetId);
    await updatePipeline(pool, population, { scored: true, investigated: false, grouped: false });
    return {
      scored: result.scored,
      flagged,
      flagThreshold: config.scoring.flagThreshold,
      byRule: Object.entries(result.byRule).map(([rule, count]) => ({ rule, count })),
    };
  });

  app.get('/api/businesses/:businessId/profile', async (req) => {
    const { businessId } = parse(businessParams, req.params);
    return buildProfile(pool, await currentPopulation(pool, businessId, 'ingested'));
  });

  app.get('/api/businesses/:businessId/entries', async (req) => {
    const { businessId } = parse(businessParams, req.params);
    const population = await currentPopulation(pool, businessId, 'scored');
    return queryEntries(pool, population, parse(entriesQuery, req.query));
  });

  app.get('/api/businesses/:businessId/entries/:entryId', async (req, reply) => {
    const { businessId, entryId } = parse(entryParams, req.params);
    const entry = await getEntry(pool, await currentPopulation(pool, businessId), entryId);
    if (!entry) return reply.code(404).send({ error: 'not_found', message: 'entry not found' });
    return entry;
  });

  app.get('/api/businesses/:businessId/graph', async (req) => {
    const { businessId } = parse(businessParams, req.params);
    return queryGraph(pool, await currentPopulation(pool, businessId, 'projected'), parse(graphQuery, req.query));
  });

  app.post('/api/businesses/:businessId/datasets/investigate', async (req) => {
    const { businessId } = parse(businessParams, req.params);
    const body = parse(investigateBody, req.body ?? {});
    const limit = body.limit === undefined ? config.agent.initialBatchLimit : body.limit;
    const result = await runInvestigateBatch(
      pool,
      await currentPopulation(pool, businessId, 'scored'),
      limit,
      body.force ?? false,
    );
    return { jobId: result.jobId, status: 'running', total: result.total };
  });

  app.get('/api/businesses/:businessId/jobs/:jobId', async (req, reply) => {
    const { businessId, jobId } = parse(jobParams, req.params);
    const job = await getJob(pool, await currentPopulation(pool, businessId), jobId);
    if (!job) return reply.code(404).send({ error: 'not_found', message: 'job not found' });
    return job;
  });

  app.get('/api/businesses/:businessId/cases/:entryId', async (req, reply) => {
    const { businessId, entryId } = parse(entryParams, req.params);
    const caseFile = await getCase(pool, await currentPopulation(pool, businessId), entryId);
    if (!caseFile) return reply.code(404).send({ error: 'not_found', message: 'case not found' });
    return caseFile;
  });

  app.post('/api/businesses/:businessId/cases/:entryId/reinvestigate', async (req, reply) => {
    const { businessId, entryId } = parse(entryParams, req.params);
    const body = parse(reinvestigateBody, req.body ?? {});
    const population = await currentPopulation(pool, businessId, 'scored');
    const existing = await getCase(pool, population, entryId);
    if (existing && !body.force) {
      return reply.code(409).send({ error: 'conflict', message: 'case exists; pass force: true to reinvestigate' });
    }
    return investigateEntry(pool, population, entryId, await buildPopulationStamp(pool, population));
  });

  app.get('/api/businesses/:businessId/citations/:kind/:ref', async (req, reply) => {
    const { businessId, kind, ref } = parse(citationParams, req.params);
    const resolved = await resolveCitation(pool, await currentPopulation(pool, businessId), kind, ref);
    if (!resolved) return reply.code(404).send({ error: 'not_found', message: 'citation not found' });
    return resolved;
  });

  app.post('/api/businesses/:businessId/datasets/group', async (req) => {
    const { businessId } = parse(businessParams, req.params);
    return runGrouping(pool, await currentPopulation(pool, businessId, 'investigated'));
  });

  app.post('/api/businesses/:businessId/datasets/run', async (req) => {
    const { businessId } = parse(businessParams, req.params);
    const body = parse(runBody, req.body ?? {});
    const population = await currentPopulation(pool, businessId);
    const from: RunFrom = body.from ?? 'project';
    const required: Record<RunFrom, keyof typeof population.pipeline> = {
      project: 'ingested',
      score: 'projected',
      investigate: 'scored',
      group: 'investigated',
    };
    requirePipelineStage(population, required[from]);
    return startPipelineRun(pool, population, { from, investigateLimit: body.investigateLimit });
  });

  app.get('/api/businesses/:businessId/queue', async (req) => {
    const { businessId } = parse(businessParams, req.params);
    return queryQueue(pool, await currentPopulation(pool, businessId, 'grouped'), parse(queueQuery, req.query));
  });

  app.get('/api/businesses/:businessId/queue/:groupId', async (req, reply) => {
    const { businessId, groupId } = parse(groupParams, req.params);
    const group = await queryQueueGroup(pool, await currentPopulation(pool, businessId, 'grouped'), groupId);
    if (!group) return reply.code(404).send({ error: 'not_found', message: 'group not found' });
    return group;
  });

  app.patch('/api/businesses/:businessId/queue/:groupId/members', async (req) => {
    const { businessId, groupId } = parse(groupParams, req.params);
    const change = parse(memberChangeBody, req.body, 'add or remove required');
    return updateGroupMembers(pool, await currentPopulation(pool, businessId, 'grouped'), groupId, change);
  });

  app.post('/api/businesses/:businessId/decisions/group/:groupId', async (req) => {
    const { businessId, groupId } = parse(groupParams, req.params);
    const body = parse(groupDecisionBody, req.body, 'conclusion and entryIds required');
    return recordGroupDecision(pool, await currentPopulation(pool, businessId, 'grouped'), groupId, {
      conclusion: body.conclusion,
      basis: body.basis ?? '',
      recordedBy: body.recordedBy,
      entryIds: body.entryIds,
      excludedDeviations: body.excludedDeviations,
    });
  });

  app.post('/api/businesses/:businessId/decisions/entry/:entryId', async (req) => {
    const { businessId, entryId } = parse(entryParams, req.params);
    const body = parse(entryDecisionBody, req.body, 'conclusion required');
    return recordEntryDecision(pool, await currentPopulation(pool, businessId, 'grouped'), entryId, {
      conclusion: body.conclusion,
      basis: body.basis ?? '',
      recordedBy: body.recordedBy,
    });
  });

  app.post('/api/businesses/:businessId/decisions/:decisionId/reopen', async (req) => {
    const { businessId, decisionId } = parse(decisionParams, req.params);
    const body = parse(reopenBody, req.body, 'reason required');
    return reopenDecision(pool, await currentPopulation(pool, businessId), decisionId, body.reason);
  });

  app.get('/api/businesses/:businessId/decisions/:decisionId', async (req, reply) => {
    const { businessId, decisionId } = parse(decisionParams, req.params);
    const decision = await getDecision(pool, await currentPopulation(pool, businessId), decisionId);
    if (!decision) return reply.code(404).send({ error: 'not_found', message: 'decision not found' });
    return decision;
  });
}
