import { z } from 'zod';
import { toCents } from '../money.js';

const Cents = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/)
  .transform(toCents);

function exactlyOneSide(
  row: { debit: number; credit: number },
  ctx: z.RefinementCtx,
): void {
  const hasDebit = row.debit > 0;
  const hasCredit = row.credit > 0;
  if (hasDebit === hasCredit) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'exactly one of debit/credit must be non-zero' });
  }
}

export const GL_COLUMNS = [
  'line_id', 'entry_id', 'period', 'voucher_type', 'voucher_subtype',
  'line_no', 'posting_date', 'created_at', 'user', 'account', 'account_number',
  'account_name', 'root_type', 'debit', 'credit', 'party_type', 'party',
  'against', 'cost_center', 'remarks', 'company',
] as const;

export const GlRowSchema = z
  .object({
    line_id: z.string().min(1),
    entry_id: z.string().min(1),
    period: z.enum(['P1', 'P2']),
    voucher_type: z.enum(['Sales Invoice', 'Purchase Invoice', 'Payment Entry', 'Journal Entry']),
    voucher_subtype: z.string().min(1),
    line_no: z.coerce.number().int().min(1),
    posting_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    created_at: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/),
    user: z.string().min(1),
    account: z.string().min(1),
    account_number: z.string(),
    account_name: z.string().min(1),
    root_type: z.enum(['Asset', 'Liability', 'Equity', 'Income', 'Expense']),
    debit: Cents,
    credit: Cents,
    party_type: z.enum(['Customer', 'Supplier']).or(z.literal('')),
    party: z.string(),
    against: z.string(),
    cost_center: z.string(),
    remarks: z.string(),
    company: z.string().min(1),
  })
  .superRefine(exactlyOneSide);

export type GlRow = z.infer<typeof GlRowSchema>;

export const TB_COLUMNS = [
  'account', 'account_number', 'account_name', 'root_type', 'account_type',
  'opening_debit', 'opening_credit', 'period_debit', 'period_credit',
  'closing_debit', 'closing_credit',
] as const;

export const TbRowSchema = z.object({
  account: z.string().min(1),
  account_number: z.string(),
  account_name: z.string().min(1),
  root_type: z.enum(['Asset', 'Liability', 'Equity', 'Income', 'Expense']),
  account_type: z.string(),
  opening_debit: Cents,
  opening_credit: Cents,
  period_debit: Cents,
  period_credit: Cents,
  closing_debit: Cents,
  closing_credit: Cents,
});

export type TbRow = z.infer<typeof TbRowSchema>;

export function deriveNormalBalance(rootType: GlRow['root_type']): 'debit' | 'credit' {
  return rootType === 'Asset' || rootType === 'Expense' ? 'debit' : 'credit';
}

export function emptyToNull(value: string): string | null {
  return value === '' ? null : value;
}
