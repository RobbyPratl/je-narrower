import { z } from 'zod';

export const StampExceptionSchema = z.object({
  account: z.string(),
  deltaCents: z.number().int(),
});

export const PopulationStampSchema = z.object({
  reconciled: z.boolean(),
  datasetId: z.string(),
  asOf: z.string().datetime(),
  grossDeltaCents: z.number().int(),
  exceptions: z.array(StampExceptionSchema),
});

export type StampException = z.infer<typeof StampExceptionSchema>;
export type PopulationStamp = z.infer<typeof PopulationStampSchema>;
