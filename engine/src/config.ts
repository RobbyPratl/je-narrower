export const config = {
  reconcile: {
    amountToleranceCents: 1,
  },
  projection: {
    capLines: null as number | null,
  },
  diff: {
    shiftedTolerance: 0.5,
  },
  scoring: {
    flagThreshold: Number(process.env.FLAG_THRESHOLD ?? 0.25),
  },
  rules: {
    thresholdBoundariesCents: [100_000, 500_000, 1_000_000, 5_000_000],
    thresholdProximityPct: 0.02,
    roundModulusCents: 100_000,
    dateMismatchMaxLagDays: 2,
    offHoursStart: 7,
    offHoursEnd: 20,
    unusualUserMinAccountEntries: 10,
    unusualUserMaxShare: 0.05,
    entrySizeOutlierPercentile: 0.99,
  },
  composite: {
    weights: {
      pair_rarity: 1.0,
      new_pair_emergence: 1.5,
      threshold_proximity: 1.0,
      entry_size_outlier: 0.75,
      round_amount: 0.5,
      date_mismatch: 0.5,
      off_hours: 0.25,
      unusual_user: 0.5,
    },
  },
  agent: {
    maxToolCalls: 12,
    verifierRetries: 1,
    initialBatchLimit: 25,
  },
  group: {
    minGroupSize: 3,
    amountBandRatio: 2,
    deviationAmountRatio: 3,
    monthEndWindowDays: 2,
  },
} as const;

/** Agent backend — env-driven so users can switch without code changes. Default: local Ollama. */
export type AgentProvider = 'ollama' | 'openai-compatible' | 'anthropic' | 'mock';

export const agentConfig = {
  provider: (process.env.AGENT_PROVIDER ?? (process.env.MODEL_BASE_URL ? 'openai-compatible' : 'ollama')) as AgentProvider,
  model: process.env.MODEL_NAME ?? process.env.AGENT_MODEL ?? 'llama3.2',
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434',
  modelBaseUrl: process.env.MODEL_BASE_URL?.replace(/\/$/, ''),
  modelApiKey: process.env.MODEL_API_KEY,
  modelTimeoutMs: Number(process.env.MODEL_TIMEOUT_MS ?? 30_000),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
} as const;

export type Period = 'P1' | 'P2';
