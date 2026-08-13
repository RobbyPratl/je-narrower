export interface FlaggedEntry {
  entryId: string;
  period: string;
  user: string;
  amountCents: number;
  lineCount: number;
  effectiveDate: string;
  postedAt: Date;
  narration: string | null;
  rulesFired: string[];
  accountA: string;
  accountB: string;
}

export interface Recurrence {
  months: string[];
  marks: number[];
  byMonth: Record<string, number>;
}

export interface ConsistencyResult {
  score: number;
  detail: string[];
}

export interface GroupBuildResult {
  groups: number;
  deviations: number;
  individuals: number;
  totalFlagged: number;
}
