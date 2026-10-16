import { z } from 'zod';

/**
 * Who or what is making a change. Every mutation requires one; it is stored on the record and
 * in the audit log. Authentication (M3) will build USER actors from the signed-in user.
 */
export const actorSchema = z
  .object({
    type: z.enum(['USER', 'EXCEL_SYNC', 'IMPORT', 'SYSTEM']),
    id: z.string().min(1).max(100).optional(),
    label: z.string().min(1).max(200).optional(),
  })
  .refine((actor) => actor.type !== 'USER' || Boolean(actor.id), {
    message: 'USER actors must have an id',
    path: ['id'],
  });
export type Actor = z.infer<typeof actorSchema>;

/**
 * Where a record came from. Imported records keep their workbook/sheet/row origin and a link to
 * the raw source rows, which are stored separately from verified operational records.
 */
export const provenanceSchema = z.object({
  sourceType: z.enum(['PMS_UI', 'EXCEL_SYNC', 'HISTORICAL_IMPORT', 'SYSTEM']),
  importBatchId: z
    .string()
    .regex(/^[a-f0-9]{24}$/)
    .optional(),
  rawSourceRowIds: z
    .array(z.string().regex(/^[a-f0-9]{24}$/))
    .max(50)
    .optional(),
  workbook: z.string().min(1).max(200).optional(),
  sheet: z.string().min(1).max(200).optional(),
  rowNumber: z.number().int().min(1).optional(),
  legacyRefs: z
    .array(z.object({ field: z.string().min(1).max(100), value: z.string().max(500) }))
    .max(50)
    .optional(),
});
export type Provenance = z.infer<typeof provenanceSchema>;

export const mutationContextSchema = z.object({
  actor: actorSchema,
  correlationId: z.string().min(1).max(100).optional(),
  requestId: z.string().min(1).max(100).optional(),
  provenance: provenanceSchema.optional(),
});
export type MutationContext = z.infer<typeof mutationContextSchema>;
