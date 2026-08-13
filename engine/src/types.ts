export interface CheckFailure {
  scope: string;
  expected: number;
  actual: number;
  deltaCents: number;
  detail?: string;
}

export interface CheckResult {
  check: string;
  ok: boolean;
  summary: string;
  metrics: Record<string, number>;
  failures: CheckFailure[];
}

export interface ReconciliationState {
  reconciled: boolean;
  report: CheckResult[];
  grossDeltaCents: number;
  exceptions: Array<{ account: string; deltaCents: number; entryCount: number }>;
}

export interface PipelineState {
  ingested: boolean;
  projected: boolean;
  scored: boolean;
  investigated: boolean;
  grouped: boolean;
}

export interface SourceFile {
  file: string;
  sha256: string;
  rows: number;
}
