import { z } from 'zod';
import { PopulationStampSchema } from '@je-narrower/shared';

export const CitationSchema = z.object({
  kind: z.enum(['line', 'entry']),
  ref: z.string(),
});

export const CaseFileSchema = z.object({
  entryId: z.string(),
  generatedAt: z.string(),
  model: z.string(),
  population: PopulationStampSchema,
  engine: z.object({
    composite: z.number(),
    rules: z.array(z.object({
      rule: z.string(),
      group: z.enum(['population', 'parametric']),
      score: z.number(),
      weight: z.number(),
      inputs: z.record(z.unknown()),
    })),
  }),
  agent: z.object({
    plan: z.array(z.object({
      step: z.number(),
      tool: z.string(),
      reason: z.string(),
      executed: z.boolean(),
    })),
    findings: z.array(z.object({
      text: z.string(),
      citations: z.array(CitationSchema).min(1),
    })),
  }),
  computed: z.array(z.object({
    label: z.string(),
    value: z.string(),
    formula: z.string(),
    inputs: z.record(z.unknown()),
    citations: z.array(CitationSchema).min(1),
  })).optional(),
  verifier: z.object({
    status: z.enum(['passed', 'retried', 'escalated']),
    checkedCitations: z.number(),
    failures: z.array(z.object({ ref: z.string(), error: z.string() })),
  }),
  review: z.object({
    status: z.enum(['open', 'reviewed', 'escalated']),
    note: z.string().nullable(),
    reviewedAt: z.string().nullable(),
    populationReconciledAtReview: z.boolean().nullable(),
  }),
});

export type CaseFile = z.infer<typeof CaseFileSchema>;
export type Citation = z.infer<typeof CitationSchema>;

export const AgentOutputSchema = z.object({
  findings: z.array(z.object({
    text: z.string(),
    citations: z.array(CitationSchema.strict()).min(1),
  }).strict()).max(6),
}).strict();
