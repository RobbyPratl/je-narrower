# Technical Design — JE Population Testing Engine

Companion to `je-population-testing-scope.md` (the *what and why*) and `export-schema.md` (the data contract). This document is the *how*: full repository structure, what every file does, every table's DDL, every API endpoint and response shape, and the contracts between modules.

**Scope: everything except UI rendering.** The HTTP API and every JSON shape the UI consumes are specified here exactly — they are the contract the UI is being designed against. What is *not* here: components, layout, charts, Cytoscape wiring.

Out of scope remains identical to the scope doc: no adapter framework, no multi-user/engagement state, no auto-conclusions, no 3+ period trending, no scale beyond demo volume.

---

## 1. Stack and repository layout

**Design principles:** KISS and YAGNI govern — single package, no abstractions for futures the scope doc excludes, no override machinery anywhere. DRY where a duplicate would be *silently wrong* (`pairKey`, `config.ts`, one `PopulationStamp` constructor). OOP where a family of implementations shares one contract (the `Check` and `Rule` interfaces); plain functions everywhere else.

**Completeness is state, not permission.** The loaded dataset is the session; its reconciliation state is a property that travels with every output. The banner reports it live, artifacts (case files, review records) stamp it permanently at write time, and nothing blocks on it — a tool that reports facts, a human who decides, a record that remembers. There is no override button because nothing is being permitted.

Node 22 / TypeScript 5, single package (no monorepo — module boundaries are directories, not packages). Postgres 16 via `pg` with hand-written SQL migrations. Fastify for the HTTP API. Zod for runtime validation of API responses and the case-file schema. `csv-parse` for ingest (the `against` and `remarks` columns contain quoted commas — a naive `split(",")` is wrong; the export contract guarantees one CSV row per line, so a real parser is sufficient and streaming is unnecessary at 2.7k rows). Vitest for tests. `@anthropic-ai/sdk` for the investigation agent.

```
je-narrower/
├── docs/
│   ├── je-population-testing-scope.md      # product scope (exists)
│   ├── data-plan.md                        # data generation plan (exists)
│   ├── export-schema.md                    # ingest contract (exists)
│   └── technical-design.md                 # this file
├── data/
│   └── exports/                            # generated fixtures (exist)
│       ├── gl_p1.csv  gl_p2.csv  gl_p2_truncated.csv
│       └── tb_p1.csv  tb_p2.csv
├── infra/
│   ├── frappe_docker/                      # ERPNext compose (exists)
│   ├── scripts/                            # data generation scripts (exist)
│   └── docker-compose.yml                  # NEW: Postgres 16 for the engine
├── db/
│   └── migrations/
│       ├── 001_datasets.sql
│       ├── 002_core.sql                    # accounts, entries, lines
│       ├── 003_graph.sql                   # pairs, pair_diff, projection_skips
│       ├── 004_scores.sql
│       └── 005_cases.sql
├── src/
│   ├── config.ts
│   ├── db/
│   │   ├── client.ts
│   │   └── migrate.ts
│   ├── shared/
│   │   ├── pair-key.ts
│   │   ├── types.ts
│   │   └── money.ts
│   ├── ingest/                             # detailed design: docs/ingest-design.md
│   │   ├── index.ts                        # runIngest(): parse → load → reconcile
│   │   ├── schema.ts                       # export-schema.md as Zod schemas
│   │   ├── parse.ts
│   │   ├── load.ts
│   │   └── reconcile/                      # one file per completeness check
│   │       ├── index.ts  check.ts
│   │       ├── voucher-balance.ts  tb-identity.ts  gl-tb-tieout.ts
│   │       └── continuity.ts  referential.ts  uniqueness.ts
│   ├── profile/
│   │   └── profile.ts
│   ├── graph/
│   │   ├── project.ts
│   │   └── diff.ts
│   ├── scoring/
│   │   ├── run.ts
│   │   ├── composite.ts
│   │   └── rules/
│   │       ├── rule.ts                     # shared Rule interface
│   │       ├── pair-rarity.ts
│   │       ├── new-pair-emergence.ts
│   │       ├── benford-deviation.ts
│   │       ├── threshold-proximity.ts
│   │       ├── entry-size-outlier.ts
│   │       ├── round-amount.ts
│   │       ├── date-mismatch.ts
│   │       ├── off-hours.ts
│   │       └── unusual-user.ts
│   ├── agent/
│   │   ├── tools.ts
│   │   ├── plan.ts
│   │   ├── case-file.ts                    # Zod schema — the UI contract
│   │   ├── investigate.ts
│   │   └── verifier.ts
│   ├── api/
│   │   ├── server.ts
│   │   ├── stamp.ts
│   │   └── routes/
│   │       ├── status.ts
│   │       ├── profile.ts
│   │       ├── graph.ts
│   │       ├── entries.ts
│   │       ├── cases.ts
│   │       └── citations.ts
│   └── cli.ts
├── test/
│   ├── fixtures/
│   │   └── expected_scores.json            # golden file
│   ├── pair-key.test.ts
│   ├── ingest.test.ts
│   ├── completeness.test.ts
│   ├── projection.test.ts
│   ├── diff.test.ts
│   ├── scoring.golden.test.ts
│   ├── verifier.test.ts
│   └── api.stamp.test.ts
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

**Anti-wrapper property, stated as a test:** deleting `src/agent/` (and the two routes that call it) must leave everything else compiling and running — ingest, reconciliation, profile, graph, scoring, and all read-only API routes have zero imports from `src/agent/`. `src/agent/` imports from everywhere; nothing imports from it except `api/routes/cases.ts`.

**One writer per table:**

| Table | Sole writer |
|---|---|
| `datasets` | `ingest/load.ts` (loading/load_failed) + `ingest/reconcile/index.ts` (state) |
| `accounts`, `entries`, `lines` | `ingest/load.ts` |
| `pairs`, `projection_skips` | `graph/project.ts` |
| `pair_diff` | `graph/diff.ts` |
| `scores` | `scoring/run.ts` |
| `cases` | `agent/investigate.ts` + `api/routes/cases.ts` (human-review fields only) |

---

## 2. Database schema (`db/migrations/`)

The seven tables from the scope doc, reconciled against the real export, plus two operational tables (`datasets`, `projection_skips`) justified below. All DDL is authoritative here; migrations are plain SQL applied in filename order by `db/migrate.ts` (tracked in a `schema_migrations` table).

Money is `NUMERIC(14,2)` everywhere — never floats. Accounts are keyed by the full ERPNext string (`"4110 - Sales - MTC"`), which `export-schema.md` establishes as the join key (`account_number` is empty for the sales-tax account, so it cannot key).

### 001_datasets.sql

The completeness measurement needs somewhere to live as **state**. That is what `datasets` is: one row per loaded dataset (the session), carrying the reconciliation result that the banner reads live and every artifact stamps permanently.

```sql
CREATE TYPE dataset_status AS ENUM ('loading', 'load_failed', 'reconciled', 'unreconciled');

CREATE TABLE datasets (
  dataset_id     TEXT PRIMARY KEY,           -- caller-chosen label, e.g. 'meridian-2025'
  status         dataset_status NOT NULL,
  loaded_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_files   JSONB NOT NULL,             -- [{file, sha256, rows}] for provenance
  reconciliation JSONB NOT NULL DEFAULT '[]' -- CheckResult[] — see ingest-design §5
);
```

`load_failed` is the one genuinely blocking state, and it isn't a judgment: data that could not be *read* has nothing to analyze. `unreconciled` data is analyzed like any other.

Exactly one dataset is active at a time (demo scale); the API operates on the most recently loaded row. Reloading upserts the same `dataset_id` after truncating all downstream tables — every derived table is rebuildable, none is authoritative (per the scope doc).

### 002_core.sql

```sql
CREATE TYPE period_id AS ENUM ('P1', 'P2');

CREATE TABLE accounts (
  account        TEXT PRIMARY KEY,          -- "4110 - Sales - MTC"
  account_number TEXT,                      -- nullable: "ST 6% - MTC" has none
  name           TEXT NOT NULL,             -- "Sales"
  root_type      TEXT NOT NULL CHECK (root_type IN
                   ('Asset','Liability','Equity','Income','Expense')),
  account_type   TEXT,                      -- ERPNext subtype, nullable
  normal_balance TEXT NOT NULL CHECK (normal_balance IN ('debit','credit'))
                                            -- derived: Asset/Expense→debit, else credit
);

CREATE TABLE entries (
  entry_id       TEXT PRIMARY KEY,          -- voucher_no; never spans periods (verified)
  period         period_id NOT NULL,
  posted_at      TIMESTAMPTZ NOT NULL,      -- export created_at (entry timestamp)
  effective_date DATE NOT NULL,             -- export posting_date (accounting date)
  "user"         TEXT NOT NULL,
  source         TEXT NOT NULL,             -- export voucher_subtype (NOT voucher_type)
  voucher_type   TEXT NOT NULL,             -- kept for display/filtering
  narration      TEXT,
  line_count     INT NOT NULL,              -- denormalized; set at load
  total_amount   NUMERIC(14,2) NOT NULL     -- sum of debits (= sum of credits)
);
CREATE INDEX entries_period_idx ON entries (period);
CREATE INDEX entries_user_idx   ON entries ("user", period);

CREATE TABLE lines (
  line_id     TEXT PRIMARY KEY,
  entry_id    TEXT NOT NULL REFERENCES entries(entry_id),
  line_no     INT  NOT NULL,
  account     TEXT NOT NULL REFERENCES accounts(account),
  debit       NUMERIC(14,2) NOT NULL DEFAULT 0,
  credit      NUMERIC(14,2) NOT NULL DEFAULT 0,
  party_type  TEXT,
  party       TEXT,
  cost_center TEXT,                          -- NULL on ~half of rows; normal, not a defect
  memo        TEXT,                          -- export remarks
  CHECK (debit >= 0 AND credit >= 0),
  CHECK (NOT (debit > 0 AND credit > 0))     -- exactly one side non-zero (export invariant)
);
CREATE INDEX lines_entry_idx   ON lines (entry_id);
CREATE INDEX lines_account_idx ON lines (account);
CREATE INDEX lines_party_idx   ON lines (party) WHERE party IS NOT NULL;

-- Trial balance as imported: reconciliation's independent side.
CREATE TABLE trial_balance (
  period         period_id NOT NULL,
  account        TEXT NOT NULL,
  opening_debit  NUMERIC(14,2) NOT NULL,
  opening_credit NUMERIC(14,2) NOT NULL,
  period_debit   NUMERIC(14,2) NOT NULL,
  period_credit  NUMERIC(14,2) NOT NULL,
  closing_debit  NUMERIC(14,2) NOT NULL,
  closing_credit NUMERIC(14,2) NOT NULL,
  PRIMARY KEY (period, account)              -- deliberately NOT an FK to accounts:
);                                           -- TB may carry accounts with no GL activity
                                             -- (Contractor Services in P2 — the VANISHED case)
```

The `entries` star and the `lines` spokes **are** the stored graph — entry node, edges to every account it touches, lossless at any entry size. No separate graph store is needed at this scale; `pairs` is the projection.

### 003_graph.sql

```sql
CREATE TABLE pairs (
  period       period_id NOT NULL,
  account_a    TEXT NOT NULL REFERENCES accounts(account),
  account_b    TEXT NOT NULL REFERENCES accounts(account),
  count        INT NOT NULL,                 -- number of entries containing this pairing
  total_amount NUMERIC(14,2) NOT NULL,       -- sum of pair weights (see §5)
  first_seen   DATE NOT NULL,
  last_seen    DATE NOT NULL,
  PRIMARY KEY (period, account_a, account_b),
  CHECK (account_a < account_b)              -- canonical ordering ENFORCED by the DB;
);                                           -- a mis-ordered write fails loudly

CREATE TYPE pair_status AS ENUM ('NEW', 'VANISHED', 'SHIFTED', 'STABLE');

CREATE TABLE pair_diff (
  account_a    TEXT NOT NULL,
  account_b    TEXT NOT NULL,
  status       pair_status NOT NULL,
  p1_count     INT NOT NULL,
  p2_count     INT NOT NULL,
  p1_amount    NUMERIC(14,2) NOT NULL,
  p2_amount    NUMERIC(14,2) NOT NULL,
  volume_delta NUMERIC(8,4),                 -- relative: (p2−p1)/p1; NULL when p1=0
  PRIMARY KEY (account_a, account_b),
  CHECK (account_a < account_b)
);

-- The cap's audit trail: what the projection skipped and why (scope doc: "log what was skipped").
CREATE TABLE projection_skips (
  entry_id   TEXT NOT NULL,
  period     period_id NOT NULL,
  line_count INT NOT NULL,
  cap        INT NOT NULL,
  skipped_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

The scope doc's "canonical pair ordering, sort lexically on write, always" is enforced three ways: the shared `pairKey()` function (§3), the `CHECK (account_a < account_b)` constraints, and a unit test. The silently-wrong-diff bug the doc warns about is made structurally impossible.

### 004_scores.sql

```sql
CREATE TABLE scores (
  entry_id TEXT NOT NULL REFERENCES entries(entry_id),
  rule     TEXT NOT NULL,                    -- rule id, e.g. 'pair_rarity'
  score    NUMERIC(6,4) NOT NULL,            -- 0..1, rule-normalized
  inputs   JSONB NOT NULL,                   -- the actual numbers that produced the score
  PRIMARY KEY (entry_id, rule)
);
CREATE INDEX scores_rule_idx ON scores (rule, score DESC);
```

**Composite is computed on read, never stored.** `scores` holds only per-rule emissions; the composite is a documented weighting (`config.ts`) applied in SQL/TS at query time. Rationale: reweighting is then a config change plus golden-file update, not a re-scoring run, and the table stays a pure record of what each deterministic rule saw. The golden file locks both: per-rule scores *and* the composite computed from them.

### 005_cases.sql

```sql
CREATE TYPE verifier_status AS ENUM ('passed', 'retried', 'escalated');
CREATE TYPE review_status   AS ENUM ('open', 'reviewed', 'escalated');

CREATE TABLE cases (
  entry_id        TEXT PRIMARY KEY REFERENCES entries(entry_id),
  case_file       JSONB NOT NULL,            -- validated CaseFile (§7) — the UI contract
  plan            JSONB NOT NULL,            -- duplicated from case_file for queryability
  verifier_status verifier_status NOT NULL,
  verifier_trace  JSONB,                     -- raw trace; populated when escalated
  model           TEXT NOT NULL,             -- model id used
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Human layer (terminal; nothing above it is editable — scope doc §UI/4)
  review_status   review_status NOT NULL DEFAULT 'open',
  review_note     TEXT,
  reviewed_at     TIMESTAMPTZ,
  review_population_reconciled BOOLEAN      -- stamped at review time; NULL until reviewed.
);                                          -- "Conclusions recorded now will be stamped
                                            --  'population not reconciled'" — permanently.
```

Re-investigating an entry replaces the machine columns and **resets the human columns only with an explicit `force` flag** — a reviewed case is not silently clobbered.

---

## 3. Shared core (`src/config.ts`, `src/shared/`)

### `config.ts`

Every number a reviewer could argue with lives here, exported as one frozen object, imported everywhere, never inlined. Defaults chosen against the real population (1,972 vouchers / 5,385 lines / 34 accounts):

```ts
export const config = {
  reconcile: {
    amountToleranceAbs: 0.005,        // per-voucher balance + TB identity tolerance
  },
  projection: {
    capLines: null as number | null,  // null = uncapped. Real max is 9 lines → 20 pairs;
                                      // the histogram justifies uncapped at demo scale.
                                      // Set a number to enable capping + skip logging.
  },
  diff: {
    shiftedTolerance: 0.5,            // |volume_delta| > 50% ⇒ SHIFTED
    minPairAmount: 0,                 // no floor at demo scale
  },
  rules: {
    rarity:      { maxCountForMax: 1 },     // count=1 in period ⇒ score 1.0
    benford:     { minLines: 100 },         // per-account minimum n; below it, no score.
                                            // 34 accounts, most thin — this threshold is
                                            // why Benford won't fire noise on tiny accounts
    threshold:   { boundaries: [1000, 5000, 10000, 50000], proximityPct: 0.02 },
    roundAmount: { modulus: 1000 },         // amount % 1000 === 0 (and >= modulus)
    dateMismatch:{ maxLagDays: 2 },         // posted_at date − effective_date > 2 days
    offHours:    { start: 7, end: 20, weekendCounts: true },  // [07:00,20:00) local
    unusualUser: { minAccountEntries: 10, maxUserShare: 0.05 },
  },
  composite: {
    // Population-relative weighted higher than parametric — the calibration argument
    // the scope doc says to make explicitly.
    weights: {
      pair_rarity: 1.0, new_pair_emergence: 1.5, benford_deviation: 1.0,
      threshold_proximity: 1.0, entry_size_outlier: 0.75,
      round_amount: 0.5, date_mismatch: 0.5, off_hours: 0.25, unusual_user: 0.5,
    },
  },
  agent: {
    model: 'claude-opus-5',
    maxToolCalls: 12,
    verifierRetries: 1,               // retry once with the error in context, then escalate
  },
} as const;
```

`off_hours` gets the lowest weight deliberately: the scope doc flags it as a decayed rule, and the dataset proves it — 100% of off-hours lines belong to `batch.bot`. It is implemented (it is in the scope doc's parametric table), weighted near zero, and the README makes the observation. That is the resolution of the doc's apparent tension between listing the rule and excluding it "as a standalone flag": it exists, it is never standalone, and it cannot dominate a composite.

### `shared/pair-key.ts`

The one function the scope doc warns about, existing exactly once:

```ts
/** Canonical account pairing: lexical sort, always. (a,b) and (b,a) are the same pair. */
export function pairKey(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}
```

Used by `graph/project.ts`, `graph/diff.ts`, `scoring/rules/pair-rarity.ts`, `scoring/rules/new-pair-emergence.ts`, and `agent/tools.ts` (`get_pair_history` / `get_pair_diff` normalize their inputs through it, so the agent cannot query a phantom reversed pair). `test/pair-key.test.ts` locks it.

### `shared/types.ts`, `shared/money.ts`

`types.ts`: the row types (`Entry`, `Line`, `Account`, `Pair`, `PairDiff`, `Score`) and enums, mirrored from the DDL — single source for every module. `money.ts`: `NUMERIC` strings from `pg` are parsed to integer *cents* (`toCents`/`fromCents`); no floating-point arithmetic ever touches an amount. All comparisons (balance checks, tolerances) happen in cents.

---

## 4. Ingest and reconciliation (`src/ingest/`)

> **This section is the summary; `docs/ingest-design.md` is the authoritative module design** (file-level structure, function signatures, check definitions, failure taxonomy). Where they differ, the module doc wins.

### `parse.ts`

Streams a GL or TB CSV through `csv-parse` (headers on, `bom: true`) and validates each row against a Zod schema derived from `export-schema.md`: column presence, `period ∈ {P1,P2}`, date formats, exactly-one-of debit/credit non-zero, amounts parseable to cents. Returns typed rows; any schema violation is a fatal parse error naming row number and column — malformed input never reaches the DB. Handles quirk 6 (naive local timestamps → stored as-is with the session timezone) and treats `against` as informational text only (quirk 2: never a key).

### `load.ts`

Loads parsed rows in one transaction: derive `accounts` (with `normal_balance` from `root_type`), aggregate `entries` from lines (line_count, total_amount, `source` ← `voucher_subtype` per quirk 7's guidance that prefixes are not authoritative), insert `lines`, insert `trial_balance`. Records file SHA-256s into `datasets.source_files`. Sets `datasets.status = 'loading'`. Truncates all derived tables (pairs, pair_diff, scores, cases, projection_skips) — a reload invalidates everything downstream by construction.

### `reconcile/` — six checks, one file each

Pure measurement over what `load.ts` wrote, each check returning a `CheckResult { check, ok, detail }`:

1. **Per-voucher balance** — Σdebit = Σcredit per `entry_id`, tolerance `amountToleranceAbs`.
2. **TB internal identity** — per account, per period: `opening + activity = closing` (signed-net convention from export-schema).
3. **GL↔TB activity tie-out** — per account, per period: Σ(lines.debit) = tb.period_debit and likewise credit. **This is the check the truncated fixture fails** — its GL is missing $540,631.22 of activity that `tb_p2.csv` still asserts.
4. **Continuity** — P2 opening = P1 closing per account; P1 opening = 0.
5. **Referential** — every GL account exists in that period's TB (TB is a superset; the reverse is *not* checked — a TB account with zero activity is the VANISHED case, not an error).
6. **Uniqueness** — `line_id` globally unique, `entry_id` period-exclusive.

All six run unconditionally; the outcome is **state, not permission**: all ok ⇒ `datasets.status = 'reconciled'`, otherwise `'unreconciled'`, with the full `CheckResult[]` (per-account deltas included) persisted to `datasets.reconciliation`. Nothing downstream blocks on it — analysis proceeds either way, and §8's stamp machinery carries the state onto every response and permanently onto every artifact. The unreconciled load is a first-class demo path: the tool analyzes the population it has, and the record forever says what that population was.

Quirk handling assignment (export-schema §quirks): 1 nullable cost_center → DDL; 2 `against` not a key → parse.ts; 3 created_at outside period → period comes only from the `period` column, never derived from timestamps (load.ts); 4 Fairbanks settlement payments in P2 → *not* ingest's problem: VANISHED is computed from billing **pairings**, and a Payment Entry (Bank↔Creditors) never contains the Contractor Services pairing, so the diff is naturally immune — stated here so nobody "fixes" it; 5 no opening voucher → the continuity check expects zero P1 opening; 6 naive timestamps → parse.ts; 7 prefixes not authoritative → load.ts uses voucher_subtype; 8 series gaps ≠ missing entries → completeness is TB-based, never sequence-based (explicitly *not* a check); 9 created_at not causally ordered across documents → no rule or tool compares `posted_at` across linked documents; sequence logic keys on `effective_date`.

---

## 5. Profile and graph (`src/profile/`, `src/graph/`)

### `profile/profile.ts`

Read-only aggregate queries feeding `GET /api/profile` (§8): entry-size histogram (the projection cap's justification), entries/lines by month, top accounts by volume, per-account Benford leading-digit distributions (only accounts meeting `benford.minLines`), flag counts by rule, per-user posting stats. No table writes.

### `graph/project.ts`

Builds `pairs` per period. For each entry: debit lines D, credit lines C (grouped by account first, so an account appearing on two lines contributes once with summed amounts). If `capLines` is set and `|D|+|C| > capLines`, log to `projection_skips` and skip. Otherwise emit every (d, c) cross pair through `pairKey()`, weighted by amount share:

```
weight(d, c) = amount_d × amount_c / total          where total = Σ debits = Σ credits
```

The weights of one entry's pairs sum exactly to the entry's total — the projection distributes each entry's value across its pairings without inflating it. Upserts into `pairs` accumulate `count`, `total_amount`, `first_seen`/`last_seen` (from `effective_date`). Worst case in this population: a 9-line voucher → 4×5 = 20 pairs; uncapped is the measured-and-justified default, and the cap stays a config parameter with its audit table — exactly the "decide N from the actual distribution" posture the scope doc requires.

### `graph/diff.ts`

Full outer join of P1 pairs against P2 pairs on `(account_a, account_b)`:

```
NEW       p1_count = 0 AND p2_count > 0
VANISHED  p1_count > 0 AND p2_count = 0
SHIFTED   both > 0 AND |volume_delta| > config.diff.shiftedTolerance
STABLE    otherwise                       (volume_delta = (p2_amount − p1_amount) / p1_amount)
```

Writes `pair_diff`. The README caveats (cold start — P1 pairings are trivially new, emergence only scores P2; business change ≠ fraud) are documentation obligations, not code.

---

## 6. Scoring (`src/scoring/`)

### `rules/rule.ts`

```ts
export interface Rule {
  id: string;                               // matches a key of config.composite.weights
  group: 'population' | 'parametric';
  /** Deterministic. Reads DB, returns one emission per flagged entry.
      Entries not emitted score 0 for this rule. */
  run(db: Db, period: Period): Promise<Array<{ entryId: string; score: number; inputs: object }>>;
}
```

Every rule normalizes to [0,1] and records in `inputs` the actual numbers behind the score — the UI's Engine section renders `inputs` verbatim, no prose. No model touches any of this.

**Population-relative** (no chosen parameter, or parameter derived from the population):

- `pair-rarity.ts` — entry's rarest pairing by within-period count; score = 1/count (count 1 ⇒ 1.0). `inputs: {pair, count, periodPairTotal}`.
- `new-pair-emergence.ts` — P2 entries only. Rarest-status pairing the entry contains: NEW ⇒ 1.0, VANISHED-adjacent n/a, SHIFTED ⇒ scaled |volume_delta| capped at 0.5, STABLE-only ⇒ no emission. `inputs: {pair, status, p1Count, p2Count, volumeDelta}`.
- `benford-deviation.ts` — per account meeting `minLines`, χ² of first-digit distribution vs Benford; entries on flagged accounts score by normalized account deviation. `inputs: {account, n, chi2, worstDigit, observedPct, expectedPct}`.
- `threshold-proximity.ts` — line amounts within `proximityPct` *under* a boundary; score = closeness. `inputs: {amount, boundary, gapPct}`.
- `entry-size-outlier.ts` — line_count percentile within the period's own histogram; emission only above P99 (in this population: 7+ lines). `inputs: {lineCount, percentile, histogramMax}`.

**Parametric** (a reviewer can argue with the number — which lives in config, not in the rule):

- `round-amount.ts` — total_amount ≥ modulus and ≡ 0 (mod modulus). `inputs: {amount, modulus}`.
- `date-mismatch.ts` — `date(posted_at) − effective_date > maxLagDays`. `inputs: {postedAt, effectiveDate, lagDays}`. (Two known benign sources exist in this data — late clerk entries and weekend-dated payments keyed Monday; the rule fires on both, the agent's job is to distinguish.)
- `off-hours.ts` — posted_at outside [start,end) or weekend. `inputs: {postedAt, hour, isWeekend}`. Weight 0.25 — see §3.
- `unusual-user.ts` — for each (account, user): user's share of that account's entries < `maxUserShare` given ≥ `minAccountEntries` on the account. Catches the controller's ~2% AR postings. `inputs: {account, user, userCount, accountCount, share}`.

### `run.ts`, `composite.ts`

`run.ts` executes all nine rules per period inside one transaction, replacing `scores` wholesale — scoring is idempotent and rerunnable. `composite.ts` exports one function used by both the API and the golden test:

```
composite(entry) = Σ (weights[rule] × score[rule]) / Σ weights[all rules]
```

Documented weighting, never learned, locked by `expected_scores.json` — which stores, for every scored entry: each rule score, its inputs, and the composite. Any drift in a rule, a weight, or the projection fails the golden test loudly.

---

## 7. Investigation agent and verifier (`src/agent/`)

Per entry, on demand (API-triggered), never batch. Claude Opus 5 (`config.agent.model`) via `@anthropic-ai/sdk`'s beta tool runner; adaptive thinking on by default. The agent retrieves and cites; it never scores, never concludes fraud, never characterizes intent.

### `tools.ts`

Six read-only tools, each a typed SQL query wrapped with `betaZodTool` — schemas identical to the scope doc's table:

| Tool | Query behavior |
|---|---|
| `get_entry_lines(entry_id)` | All lines + memos + entry header |
| `get_pair_history(account_a, account_b, period)` | Normalized via `pairKey`; occurrence list with dates and entry ids within period |
| `get_pair_diff(account_a, account_b)` | Status + counts + volume_delta across both periods |
| `get_similar_entries(entry_id, limit=10)` | Entries sharing the same *account set* (exact-set match first, then same rarest pair), both periods |
| `get_user_activity(user, period)` | Poster's entry list + per-account distribution for the period |
| `get_account_context(account)` | Account row + per-period volume, entry count, top counterparty accounts by pair weight |

Every tool result row carries the `line_id`s / `entry_id`s it came from — that is what makes citation possible. Tool results are the *only* facts the agent may state.

### `plan.ts`

Deterministic mapping from fired rules to an ordered investigation plan — the scope doc's routing, verbatim: emergence → `get_pair_diff` → `get_account_context` (both accounts) → `get_similar_entries`; rare pairing → `get_pair_history` → `get_similar_entries`; off-hours/unusual-user → `get_user_activity`; large multi-line → `get_entry_lines` → `get_account_context`. Multiple fired rules concatenate (deduplicated, score-descending by rule). The plan — with a one-line rationale per step — goes into the system prompt *and* into the case file: this is the "log the plan" requirement, and it is what makes the agent's behavior legible. The model may make additional calls (to `maxToolCalls`); the plan is the spine, the log records what actually ran.

### `case-file.ts` — the UI's contract

```ts
export const Citation = z.object({
  kind: z.enum(['line', 'entry']),
  ref: z.string(),                          // line_id or entry_id — must resolve (§verifier)
});

/** Completeness state, stamped permanently onto artifacts at write time.
    State, not permission: nothing blocks; the record remembers. Built by exactly
    one constructor (api/stamp.ts buildStamp) — DRY where drift would be silent. */
export const PopulationStamp = z.object({
  reconciled: z.boolean(),
  datasetId: z.string(),
  asOf: z.string(),                         // when reconciliation was computed
  grossDeltaCents: z.number(),              // 0 when reconciled
  exceptions: z.array(z.object({            // untied accounts, from gl-tb-tieout
    account: z.string(),
    deltaCents: z.number(),
  })),
});

export const CaseFile = z.object({
  entryId: z.string(),
  generatedAt: z.string(),                  // ISO
  model: z.string(),
  // 0. POPULATION — completeness state at investigation time. Permanent.
  population: PopulationStamp,
  // 1. ENGINE — deterministic; copied from scores, never model-produced
  engine: z.object({
    composite: z.number(),
    rules: z.array(z.object({
      rule: z.string(), group: z.enum(['population', 'parametric']),
      score: z.number(), weight: z.number(),
      inputs: z.record(z.unknown()),        // rendered verbatim; no prose
    })),
  }),
  // 2. AGENT — retrieved; every fact carries citations
  agent: z.object({
    plan: z.array(z.object({
      step: z.number(), tool: z.string(),
      reason: z.string(),                   // why the plan looked here
      executed: z.boolean(),
    })),
    findings: z.array(z.object({
      text: z.string(),                     // one factual statement, no conclusions
      citations: z.array(Citation).min(1),  // structurally: no chip, no finding
    })),
  }),
  // 3. VERIFIER — code, not judgment
  verifier: z.object({
    status: z.enum(['passed', 'retried', 'escalated']),
    checkedCitations: z.number(),
    failures: z.array(z.object({ ref: z.string(), error: z.string() })),
  }),
  // 4. HUMAN — terminal layer; served alongside, written only via review endpoint
  review: z.object({
    status: z.enum(['open', 'reviewed', 'escalated']),
    note: z.string().nullable(),
    reviewedAt: z.string().nullable(),
    populationReconciledAtReview: z.boolean().nullable(),  // stamped when the human decides
  }),
});
```

The four sections *are* the epistemic separation the scope doc's UI wants — the JSON structure enforces it before any rendering exists. The agent produces only `agent.findings` + executed-plan flags (via structured output, `output_config.format` from the Zod schema); `engine` is copied from the DB by `investigate.ts`; `verifier` and `review` are written by their own layers.

### `investigate.ts`

Orchestration: load entry + fired rules → build plan → run tool loop (system prompt states the role, the plan, the citation requirement, and the prohibition on conclusions/intent) → parse structured output into `CaseFile.agent` → assemble full case file → hand to verifier → upsert `cases`. Failure of the model call itself (refusal, overload after SDK retries) records an `escalated` case with the error in `verifier_trace` — never a silent drop.

### `verifier.ts`

Code, not judgment, exactly as scoped:

1. Schema-validate the case file (Zod).
2. Resolve every citation: `line` refs against `lines.line_id`, `entry` refs against `entries.entry_id`. A finding whose citation does not resolve is a failure.
3. Cross-check: each `line` citation's entry must be reachable from the tools that actually ran (the tool log records returned ids) — the agent cannot cite a row it never retrieved.
4. On any failure: **one** retry (`verifierRetries`) — the agent is re-invoked with the failure list appended to the conversation. Pass on retry ⇒ `status: 'retried'`.
5. Fail again ⇒ `status: 'escalated'`, raw model trace stored in `cases.verifier_trace`, case file saved *with empty findings* (an escalated case renders its trace, not unverified claims).

`test/verifier.test.ts` proves the rejection path with a deliberately uncited case file — success criterion 5 from the scope doc.

---

## 8. HTTP API (`src/api/`)

Fastify on `:4000`, JSON only, no auth (single-user demo). All routes under `/api`. Zod-validated responses. **This section plus §7's `CaseFile` is the complete UI contract.**

### `stamp.ts` — state, not permission

No route blocks on completeness. Two mechanisms, one source of truth:

- **Live state:** a Fastify `onSend` hook adds `X-Population: reconciled | unreconciled` to every response; the banner's detail (per-account deltas, gross) comes from `/api/status`. The "show N entries" drill-down under an untied account is the existing `GET /api/entries?account=&period=` filter — no new endpoint (YAGNI).
- **Permanent state:** `buildStamp()` — the *only* constructor of `PopulationStamp` (DRY) — is called by the two artifact writers: case creation (§7) and review recording. Once written, a stamp is never updated, even if the dataset is later reloaded and reconciles: the record says what was true when the conclusion was formed.

The only 4xx tied to dataset state is `404` when nothing is loaded, and `503`-shaped refusal on `load_failed` — unreadable data has nothing to serve. An *unreconciled* population changes what the record says, never what the tool does.

### Routes

**`GET /api/status`** — the completeness banner's data source. Always available.

```jsonc
{
  "dataset": "meridian-2025",
  "status": "reconciled" | "unreconciled" | "loading" | "load_failed" | "empty",
  "loadedAt": "…",
  "source": { "files": [{ "file": "gl_p1.csv", "sha256": "…", "rows": 2628 }] },
  "periods": [
    { "period": "P1", "entries": 947,  "lines": 2628, "tied": true },
    { "period": "P2", "entries": 1025, "lines": 2757, "tied": false }
  ],
  "reconciliation": [ /* CheckResult[] — full report incl. per-check metrics */ ],
  // when unreconciled, the banner's content is right here:
  "exceptions": [ { "account": "1310 - Debtors - MTC", "deltaCents": 418000,
                    "entryCount": 12 } ],
  "grossDeltaCents": 836000
}
```

**`GET /api/profile`** — the five dense charts' data, one call: `entrySizeHistogram: [{lines, count}]` per period, `byMonth: [{month, entries, lines}]`, `topAccounts: [{account, name, totalAmount, lineCount}]`, `benford: [{account, n, observed: [9 pcts], expected: [9 pcts], chi2}]`, `flagCounts: [{rule, group, count}]`.

**`GET /api/graph?mode=p1|p2|diff&minScore=0&rule=`** — Cytoscape-ready elements. Nodes: `{ id: account, label: name, rootType, volume }` (volume = period pair-weight sum; diff mode uses P1+P2). Edges keyed `a↔b`: P1/P2 mode `{ source, target, count, totalAmount, rarity }` (rarity = 1/count normalized); diff mode `{ source, target, status, p1Count, p2Count, volumeDelta, firstSeen }`. `minScore` filters edges to those appearing in at least one entry with composite ≥ threshold — the score-threshold slider is a server-side filter, one refetch per drag-release. `rule=` limits to entries where that rule fired.

**`GET /api/entries?period=&minScore=&rule=&account=&pair=&sort=&order=&limit=&offset=`** — the entry list. Rows: `{ entryId, period, effectiveDate, postedAt, user, source, lineCount, totalAmount, accounts: [..], composite, rulesFired: [..], caseStatus: null | verifier_status, reviewStatus }`. `pair=a↔b` powers click-edge→filtered-list; the graph⇄list bidirectional sync is two instances of the same filter parameter.

**`GET /api/entries/:id`** — header + lines (with all line fields) + per-rule scores with inputs + composite. The pre-agent drill-down.

**`GET /api/cases/:entryId`** — `200` with the stored `CaseFile`, or `404 { investigated: false }`.

**`POST /api/cases/:entryId`** — run the investigation (the click). Synchronous; returns the finished `CaseFile` (agent latency is the demo's "watch it work" moment; the plan is visible in the response). `409` if already investigated and `force: true` not passed. On an unreconciled population the investigation runs normally — and the case file carries `population.reconciled = false`, permanently.

**`POST /api/cases/:entryId/review`** — the human layer, the only mutable thing above the machine record: body `{ action: 'reviewed' | 'escalated' | 'reopen', note?: string }` → updates `review_*` columns, returns the updated `CaseFile.review`. The decision record stamps the population state at the moment of decision (`review_population_reconciled` ← current dataset state) — "conclusions recorded now will be stamped 'population not reconciled'" is this column. Terminal in the epistemic ordering: it never touches the machine sections.

**`GET /api/citations/:kind/:ref`** — citation-chip resolution: `line` → the full line row + its parent entry header; `entry` → entry header + line summaries. This is what "click a chip to open the source row" calls.

### `server.ts`, `cli.ts`

`server.ts` wires routes, the stamp hook, and error mapping (Zod validation failure on a response is a 500 with the schema path — a contract violation is a bug, not a client error). `cli.ts` is the pipeline entrypoint:

```
je migrate                      # apply db/migrations
je ingest --gl data/exports/gl_p1.csv data/exports/gl_p2.csv \
          --tb data/exports/tb_p1.csv data/exports/tb_p2.csv \
          --dataset meridian-2025          # parse → load → reconcile
je project                      # pairs (both periods) + diff
je score                        # all rules + nothing else
je serve                        # API
je demo-unreconciled            # ingest with gl_p2_truncated.csv — the stamp demo
```

Stages require *loaded* data (`status` ∉ {loading, load_failed, empty}) but never a *reconciled* one: `project` and `score` run on an unreconciled population exactly as on a clean one, printing the ⚠ condition as they do. Order is still enforced (ingest before project before score); judgment is not.

---

## 9. Testing

| Test | Locks |
|---|---|
| `pair-key.test.ts` | Canonical ordering; property-tested (any a,b → sorted, symmetric) |
| `ingest.test.ts` | Real `gl_p1.csv` parses to exactly 2,628 typed rows; quoted commas in `against`/`remarks` survive; schema violations fail loudly |
| `completeness.test.ts` | Full fixtures: all 6 checks ok, state `reconciled`; `gl_p2_truncated.csv`: tie-out reports the $540,631.22 delta with per-account exceptions, state `unreconciled`, report persisted |
| `projection.test.ts` | Hand-computed pair weights for a known 4-line voucher; weights sum to entry total; cap + skip-log path with `capLines` forced low |
| `diff.test.ts` | The five materialized structural changes land in the right buckets: Installation Revenue / Equipment Lease / Intercompany pairs NEW, Contractor Services pairs VANISHED, Premium-Widget-driven Sales pairs SHIFTED; Fairbanks July payments do **not** un-VANISH anything |
| `scoring.golden.test.ts` | Every rule score + inputs + composite over the full real population ≡ `expected_scores.json`, byte-stable. The determinism claim, as CI |
| `verifier.test.ts` | Uncited finding ⇒ rejected; bad ref ⇒ retry path; second failure ⇒ escalated with trace; valid file ⇒ passed. Agent mocked — no API key in CI |
| `api.stamp.test.ts` | Unreconciled dataset: every response carries `X-Population: unreconciled`; `/api/status` carries exceptions + gross; a case investigated in that state embeds `population.reconciled = false`; a review records `review_population_reconciled = false`; a later reload never rewrites either stamp |

The real exports are the fixture set — checked in (1.7 MB), regenerable via `infra/scripts/run_all.sh`. `expected_scores.json` is generated once by running the scorer and reviewed by hand before committing; from then on it only changes deliberately.

The agent itself is exercised by a smoke script (`test/agent.smoke.ts`, run manually with a key), not CI — its correctness surface is the verifier, which *is* in CI.

---

## 10. Build order (revised for what already exists)

Data generation (old step 1) is **done**. Each remaining step demos on its own:

1. Scaffold + migrations + `config.ts` + `pair-key.ts` (§1–3)
2. Ingest + reconciliation + its tests — *demos alone: the truncated export loads, the ⚠ report names the untied accounts and the gross delta*
3. Profile queries + `/api/status` + `/api/profile` + stamp hook
4. Projection + diff + tests — *demos alone: the five structural changes surfacing*
5. Scoring + composite + golden file — *demos alone: deterministic top-N list*
6. Entries/graph endpoints (UI can begin integrating against real responses here)
7. Agent + verifier + case/citation/review endpoints
8. README (caveats: cold start, business-change-≠-fraud, off-hours decay, payroll-as-JE, timestamp synthesis) + demo script

Steps 2, 4, 5 are independent after step 1 and can run as parallel workstreams; 6 needs 4+5; 7 needs 6's data model in place.

---

## 11. Success criteria → where they land

| Scope-doc criterion | Mechanism |
|---|---|
| ~~Gate blocks truncated export~~ **revised:** truncated export loads, is analyzed, and every artifact permanently carries "population not reconciled" | §4 tie-out; `stamp.ts`; `completeness.test.ts` + `api.stamp.test.ts`; `je demo-unreconciled` |
| Graph renders; emergent pairings hot in diff | §5 diff + `GET /api/graph?mode=diff`; `diff.test.ts` |
| Scoring deterministic; suite matches golden | §6; `scoring.golden.test.ts` |
| Click entry → case file with valid citations | §7 + `POST /api/cases/:id` |
| Verifier rejects uncited case file in test | §7 verifier; `verifier.test.ts` |
| Three-minute walkthrough, no chat window | No conversational endpoint exists anywhere in §8 |
