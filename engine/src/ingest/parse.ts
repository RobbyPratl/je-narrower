import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parse } from 'csv-parse/sync';
import { GL_COLUMNS, GlRowSchema, TB_COLUMNS, TbRowSchema, type GlRow, type TbRow } from './schema.js';

export interface ParseViolation {
  file: string;
  row: number;
  column: string | null;
  message: string;
}

export class ParseError extends Error {
  constructor(public violations: ParseViolation[]) {
    super(`parse failed with ${violations.length} violation(s)`);
    this.name = 'ParseError';
  }
}

const MAX_VIOLATIONS = 20;

function checkHeaders(file: string, headers: string[], expected: readonly string[]): ParseViolation[] {
  const headerSet = new Set(headers);
  const violations: ParseViolation[] = [];
  for (const col of expected) {
    if (!headerSet.has(col)) {
      violations.push({ file, row: 1, column: col, message: `missing column ${col}` });
    }
  }
  for (const col of headers) {
    if (!(expected as readonly string[]).includes(col)) {
      violations.push({ file, row: 1, column: col, message: `unexpected column ${col}` });
    }
  }
  return violations;
}

function parseRows<T>(
  file: string,
  raw: string,
  expected: readonly string[],
  schema: { safeParse: (row: unknown) => { success: boolean; data?: T; error?: { issues: Array<{ path: (string | number)[]; message: string }> } } },
): { rows: T[]; sha256: string } {
  const sha256 = createHash('sha256').update(raw).digest('hex');
  const records = parse(raw, { columns: true, bom: true, skip_empty_lines: true }) as Record<string, string>[];
  const headers = records.length > 0 ? Object.keys(records[0]!) : [];
  const headerViolations = checkHeaders(file, headers, expected);
  const violations: ParseViolation[] = [...headerViolations];

  if (violations.length > 0) throw new ParseError(violations);

  const rows: T[] = [];
  for (let i = 0; i < records.length; i++) {
    const result = schema.safeParse(records[i]);
    if (!result.success) {
      for (const issue of result.error!.issues) {
        if (violations.length >= MAX_VIOLATIONS) break;
        violations.push({
          file,
          row: i + 2,
          column: issue.path.length ? String(issue.path[0]) : null,
          message: issue.message,
        });
      }
      continue;
    }
    rows.push(result.data!);
  }

  if (violations.length > 0) throw new ParseError(violations);
  return { rows, sha256 };
}

export async function parseGlFile(path: string): Promise<{ rows: GlRow[]; sha256: string }> {
  const raw = await readFile(path, 'utf8');
  return parseGlContent(path, raw);
}

export async function parseTbFile(path: string): Promise<{ rows: TbRow[]; sha256: string }> {
  const raw = await readFile(path, 'utf8');
  return parseTbContent(path, raw);
}

export function parseGlContent(file: string, raw: string): { rows: GlRow[]; sha256: string } {
  return parseRows(file, raw, GL_COLUMNS, GlRowSchema);
}

export function parseTbContent(file: string, raw: string): { rows: TbRow[]; sha256: string } {
  return parseRows(file, raw, TB_COLUMNS, TbRowSchema);
}
