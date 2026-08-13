# Module Design — Ingest & Reconciliation

Refines `technical-design.md` §4 down to file and function level. Where this doc and §4 differ, this doc wins.

**The module's one job:** turn the five export CSVs into a loaded population and *measure* whether it reconciles — writing that measurement as state that travels with every downstream output. **Completeness is state, not permission.** An unreconciled population is analyzed like any other; the banner reports the condition, and every artifact produced under it is stamped permanently. Refusal exists only for data that cannot be *read* (parse and load errors) — never as a judgment on data that can. Data completeness remains the AS 1105 obligation the project leans on; the permanent record, not a blocker, is how it is honored — a gate stops the action and leaves no trace once overridden; a stamp stops nothing and leaves one forever.

**Boundaries.** Ingest writes `datasets`, `accounts`, `entries`, `lines`, `trial_balance` — nothing else. It imports from `shared/` and `db/` only. Nothing downstream (graph, scoring, agent, API) is imported here, and the module never reads derived tables except to truncate them on reload.

---

## 1. File structure

```
src/ingest/
├── index.ts                  # runIngest() — the only public entry point
├── schema.ts                 # export-schema.md as code: Zod row schemas + types
├── parse.ts                  # CSV file → typed rows, or a precise list of violations
├── load.ts                   # typed rows → DB in one transaction; all derivations
└── reconcile/
    ├── index.ts              # runReconciliation() — executes checks, writes the state
    ├── check.ts              # Check interface, CheckResult type, report helpers
    ├── voucher-balance.ts    # check 1: Σdebit = Σcredit per voucher
    ├── tb-identity.ts        # check 2: opening + activity = closing, per account/period
    ├── gl-tb-tieout.ts       # check 3: GL activity sums = TB activity, per account/period
    ├── continuity.ts         # check 4: P2 opening = P1 closing; P1 opening = 0
    ├── referential.ts        # check 5: every GL account exists in that period's TB
    └── uniqueness.ts         # check 6: line_id global-unique; entry_id period-exclusive
```

One file per check for the same reason `scoring/rules/` is one file per rule: they share an interface (`Check` — the OOP boundary; everything else is plain functions), they are individually reported (the reconciliation report *is* the ⚠ banner's content), and adding a check for a future source touches one new file plus a registry line.

Dataset lifecycle owned by this module:

```
(no row) ──ingest──▶ loading ──reconcile──▶ reconciled
                        │
                        ├──────reconcile──▶ unreconciled     (analysis proceeds; stamp travels)
                        └──────load error─▶ load_failed      (reload: any state ──▶ loading)
```

---

## 2. `schema.ts` — the contract, executable

Zod schemas transliterated from `export-schema.md`'s column tables — this file is the single place the export contract exists as code, and the first thing that breaks if the data generation ever drifts.

```ts
export const GL_COLUMNS = ['line_id','entry_id','period','voucher_type','voucher_subtype',
  'line_no','posting_date','created_at','user','account','account_number','account_name',
  'root_type','debit','credit','party_type','party','against','cost_center','remarks',
  'company'] as const;

export const GlRowSchema = z.object({
  line_id: z.string().min(1),
  entry_id: z.string().min(1),
  period: z.enum(['P1', 'P2']),
  voucher_type: z.enum(['Sales Invoice','Purchase Invoice','Payment Entry','Journal Entry']),
  voucher_subtype: z.string().min(1),            // open set (Credit Note, Bank Entry, …)
  line_no: z.coerce.number().int().min(1),
  posting_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  created_at: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/),
  user: z.string().email(),
  account: z.string().min(1),
  account_number: z.string(),                    // may be empty (ST 6%)
  account_name: z.string().min(1),
  root_type: z.enum(['Asset','Liability','Equity','Income','Expense']),
  debit: Cents,                                  // see below
  credit: Cents,
  party_type: z.enum(['Customer','Supplier']).or(z.literal('')),
  party: z.string(),
  against: z.string(),                           // informational only — quirk 2
  cost_center: z.string(),                       // empty ≈ NULL — quirk 1
  remarks: z.string(),
  company: z.literal('Meridian Trading Co.'),
}).superRefine(exactlyOneSide);                  // debit XOR credit non-zero

export type GlRow = z.infer<typeof GlRowSchema>; // debit/credit already integer cents
```

- `Cents = z.string().regex(/^\d+(\.\d{1,2})?$/).transform(toCents)` — amounts leave this file as **integer cents**; no float ever exists. (`shared/money.ts` provides `toCents`.)
- `exactlyOneSide` enforces the export invariant (exactly one of debit/credit non-zero) at parse time, so `load.ts` and the DB `CHECK` are the second and third lines of defense, not the first.
- `TbRowSchema` mirrors the TB table analogously (six amount columns as `Cents`, same account fields).
- Timestamps are validated as *shape* only and stored as naive-local strings passed to `TIMESTAMPTZ` with the session timezone (quirk 6); no timezone math happens anywhere in ingest.
- Exports `deriveNormalBalance(rootType)` → `'debit' | 'credit'` (Asset/Expense → debit) — used by `load.ts`, unit-tested here.

---

## 3. `parse.ts` — file → typed rows, or a violation list

```ts
export interface ParseViolation { file: string; row: number;      // 1-based data row
                                  column: string | null; message: string; }
export class ParseError extends Error { violations: ParseViolation[] }  // capped at 20

export async function parseGlFile(path: string): Promise<{ rows: GlRow[];  sha256: string }>;
export async function parseTbFile(path: string): Promise<{ rows: TbRow[]; sha256: string }>;
```

Behavior, in order:

1. Read file once; compute `sha256` of raw bytes (provenance for `datasets.source_files`).
2. `csv-parse` with `{ columns: true, bom: true, relax_quotes: false }`. A real CSV parser is non-negotiable: `against` and `remarks` carry quoted commas. The export guarantees one CSV row per line (embedded newlines folded at export), so row-oriented parsing with no streaming is correct at this scale (2.8k rows/file).
3. **Header check first**: the header set must equal `GL_COLUMNS` exactly (order-insensitive). A missing or unexpected column is one violation naming the column — the clearest possible "the contract drifted" signal, caught before 2,600 per-row errors.
4. Validate every row against the Zod schema. **Collect violations rather than fail-fast** — up to 20, then abort collection — so a systematically broken file produces one useful report, not one error per run. Each violation carries file, row number, column (from the Zod path), and message.
5. Any violation ⇒ throw `ParseError`. **Partial data never reaches the DB** — parsing is all-or-nothing per ingest run.
6. Cross-file consistency (`period` constant within a file, GL file's period matches its filename role) is *not* checked here — parse validates rows in isolation; anything relational belongs to `load.ts` preconditions or reconciliation.

What parse deliberately does **not** do: no balancing, no TB math, no cross-references. Shape in, shape out. Reconciliation owns semantics.

---

## 4. `load.ts` — rows → DB, one transaction

```ts
export interface LoadInput {
  datasetId: string;
  gl: { p1: GlRow[]; p2: GlRow[] };
  tb: { p1: TbRow[]; p2: TbRow[] };
  sourceFiles: Array<{ file: string; sha256: string; rows: number }>;
}
export async function load(db: Db, input: LoadInput): Promise<void>;
```

Single `BEGIN … COMMIT`, steps in order:

1. **Reset.** Upsert `datasets` row (`status = 'loading'`, `source_files`, `reconciliation = []`). Truncate `lines`, `entries`, `accounts`, `trial_balance`, and every derived table (`pairs`, `pair_diff`, `projection_skips`, `scores`, `cases`) — a reload invalidates the world by construction; nothing downstream can survive a re-ingest.
2. **Accounts.** Distinct accounts from GL ∪ TB rows (TB is a superset — Contractor Services has a P2 TB row but no P2 GL rows). Fields from the row; `normal_balance` via `deriveNormalBalance`. Conflicting metadata for the same account string across files (different `root_type`, say) is a hard `LoadError` — it means the export is internally inconsistent, which the contract says cannot happen.
3. **Entries.** Group GL rows by `entry_id`; derive per the contract:
   - `period` from the rows (all rows of a voucher share it — enforced, `LoadError` otherwise),
   - `posted_at` ← `created_at`, `effective_date` ← `posting_date` (from `line_no = 1`; all lines of a voucher share both dates in this export — verified, not assumed: mismatch is a `LoadError`),
   - `source` ← `voucher_subtype` (**never** the `ACC-*` prefix and never `voucher_type` — quirks 7, and the rule that Credit Notes are distinguishable),
   - `line_count`, `total_amount` = Σ debit cents.
4. **Lines.** Bulk insert (single multi-row `INSERT`, ~5.4k rows — no COPY needed). Empty-string `party_type`/`party`/`cost_center` → `NULL` (quirk 1: NULL cost_center is normal). `memo` ← `remarks`.
5. **Trial balance.** Insert TB rows per period, amounts in cents.

Load performs **no balancing checks** — a voucher that doesn't balance loads fine and is then *reported by reconciliation*. This split is deliberate: the measurement must be able to describe a broken population, which it can't do if load refuses to store one. The only `LoadError`s are structural impossibilities (steps 2–3) that indicate contract drift, not data badness.

On any error: transaction rolls back **except** the `datasets` row, which is re-written as `load_failed` with a synthetic report entry (`check: 'load'`) so `/api/status` can explain what happened. `load_failed` is the one state with nothing to analyze — unreadable, not unreconciled.

---

## 5. `reconcile/` — measurement, not permission

### `check.ts`

```ts
export interface CheckResult {
  check: string;                     // 'voucher_balance' | 'tb_identity' | …
  ok: boolean;
  summary: string;                   // one human sentence: "947/947 P1 vouchers balance"
  metrics: Record<string, number>;   // machine-readable aggregates for the banner/report
  failures: Failure[];               // empty when ok; CAPPED at 50 with `truncated: n`
}
export interface Failure { scope: string;           // entry_id or account or period
                           expected: number; actual: number; deltaCents: number;
                           detail?: string; }

export interface Check {
  id: string;
  run(db: Db): Promise<CheckResult>;
}
```

Checks are pure reads over what `load.ts` wrote — SQL aggregations, compared in integer cents. `config.reconcile.amountToleranceAbs` (0.005 dollars) is honored as `|delta| ≤ 0.5 cents`; since every amount is 2dp, sums are exact integers and the tolerance effectively means *exact* on this source. The parameter exists for a future source with per-line rounding, and the README can say precisely that.

### The six checks

| File | Query shape | Fails when | Failure `scope` |
|---|---|---|---|
| `voucher-balance.ts` | `GROUP BY entry_id` over `lines` | Σdebit ≠ Σcredit | `entry_id` |
| `tb-identity.ts` | pure `trial_balance` scan | (open_d−open_c)+(per_d−per_c) ≠ (close_d−close_c) | `period/account` |
| `gl-tb-tieout.ts` | GL `GROUP BY account` FULL OUTER JOIN TB, per period | Σlines.debit ≠ tb.period_debit (or credit side) | `period/account` |
| `continuity.ts` | TB P1 FULL OUTER JOIN TB P2 | P2 opening ≠ P1 closing; or P1 opening ≠ 0 | `account` |
| `referential.ts` | GL accounts EXCEPT TB accounts, per period | a GL account missing from its period's TB | `period/account` |
| `uniqueness.ts` | dup scan on `line_id`; `entry_id` × period | any duplicate / any entry in both periods | offending id |

Notes that carry audit meaning:

- **`gl-tb-tieout` is the completeness check** — the one that catches missing rows, and the one `gl_p2_truncated.csv` fails: its GL activity disagrees with `tb_p2.csv` by $540,631.22 across the affected accounts. Its `metrics` include `totalDeltaCents`, so the banner can show the headline number.
- **`tb-identity` vs `gl-tb-tieout`**: identity proves the TB is *internally* coherent; tie-out proves the GL *agrees* with it. Truncating the GL breaks only the second — both exist so the report can say *which side* is wrong.
- **`referential` is one-directional on purpose.** TB ⊄ GL is legal (an account with opening balance and zero activity is exactly the VANISHED case); GL ⊄ TB is corruption.
- **What is deliberately absent:** no sequence-gap check (`ACC-*` series have gaps by construction — quirk 8; a gap is not a missing entry, the TB tie-out is the real completeness authority) and no cross-document timestamp-order check (quirk 9).

### `reconcile/index.ts`

```ts
export async function runReconciliation(db: Db, datasetId: string): Promise<ReconciliationState>;
// ReconciliationState = { reconciled: boolean; report: CheckResult[] }
```

Runs all six checks **unconditionally** (no short-circuit — the report should show everything at once, and green checks are evidence too), writes `report` to `datasets.reconciliation` and `reconciled`/`unreconciled` to `datasets.status` in one small transaction. Total runtime at this scale: milliseconds; no incremental mode needed.

Nothing is enforced here — or anywhere. The state's consumers are: the banner (`/api/status`, including per-account `exceptions` and `grossDeltaCents` assembled from `gl-tb-tieout`'s failures), the response header (`api/stamp.ts`), and the permanent artifact stamps (case files at investigation time, review records at decision time). One writer, many readers — and no override machinery exists, because nothing is being permitted. If someone concludes on an unreconciled population, the record says so, on every artifact, forever.

---

## 6. `index.ts` — the public surface

```ts
export interface IngestOptions { datasetId: string;
                                 glFiles: [string, string];   // P1, P2
                                 tbFiles: [string, string]; }
export async function runIngest(db: Db, opts: IngestOptions): Promise<ReconciliationState>;
```

`parse × 4 → load → runReconciliation`, mapping each outcome to its exit shape:

| Outcome | `datasets.status` | CLI behavior (`je ingest`) |
|---|---|---|
| `ParseError` | unchanged (nothing loaded) | exit 2, print violations table |
| `LoadError` | `load_failed` (synthetic report) | exit 2, print error |
| Unreconciled | `unreconciled` + full report | **exit 0, print ⚠ report** — expected demo path |
| Reconciled | `reconciled` | exit 0, print summary line per check |

Unreconciled exits 0 deliberately: it is not an error, it is a measured condition. The printed ⚠ block mirrors the banner — untied accounts with signed deltas, gross total, and the note that conclusions recorded now will be stamped "population not reconciled". `je demo-unreconciled` is just `runIngest` with `gl_p2_truncated.csv` in the P2 slot — no special code path; the demo is the ordinary machinery measuring, reporting, and stamping.

---

## 7. Tests (expands `technical-design.md` §9 rows 2–3)

| Test | Asserts |
|---|---|
| `schema.test.ts` | Column-set equality check fires on a renamed column; `Cents` rejects 3dp and negatives; XOR refinement; `deriveNormalBalance` table |
| `parse.test.ts` | Real `gl_p1.csv` → exactly 2,628 rows; quoted commas in `against`/`remarks` intact; violation collection caps at 20; ParseError row/column accuracy on a doctored file |
| `load.test.ts` | Round-trip counts (947/1,025 entries; 34 accounts incl. the GL-absent P2 Contractor Services); `source` = subtype (12 P1 Credit Notes distinct from Sales Invoices); empty strings → NULL; reload truncates a seeded `scores` row |
| `completeness.test.ts` | Full fixtures: all six checks `ok`, status `reconciled`. Truncated P2: exactly `gl_tb_tieout` fails, `totalDeltaCents = 54_063_122` with per-account exceptions, others still pass, status `unreconciled`, report persisted. Doctored single-line deletion: both `voucher_balance` *and* `gl_tb_tieout` fail (the report distinguishes an unbalanced voucher from a missing one) |
| `api.stamp.test.ts` | Unreconciled dataset: `X-Population: unreconciled` on every response; `/api/status` carries exceptions + gross; artifacts written in that state are stamped `reconciled: false` and a later clean reload never rewrites them |

Fixtures are the real exports plus two tiny doctored variants generated *in the test* (never checked in) by dropping/altering rows in memory — keeping the on-disk fixtures byte-identical to what the generation pipeline produced.

---

## 8. Sequencing

Build order within the module: `schema.ts` → `parse.ts` → migrations already exist → `load.ts` → `check.ts` + six checks → `reconcile/index.ts` → `index.ts` + CLI wiring. Roughly a day of focused work including tests; `schema.ts`+`parse.ts` are mechanical transliteration of `export-schema.md`, the reconciliation checks are six small SQL statements behind one interface, and the subtlety budget should be spent on `load.ts`'s derivations (step 3) and the test that proves the truncated file is reported unreconciled for exactly the right reason.
