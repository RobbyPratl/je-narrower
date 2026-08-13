# Export Schema

Contract between the data-generation workstream and the ingest workstream.
Companion to `je-population-testing-scope.md` and `data-plan.md`.

Everything here describes the files **as they actually exist** in
`data/exports/`, generated from a live ERPNext v16.31.1 instance. Where the plan
and the result differ, the result is documented and the deviation called out.

---

## Files

| File | Rows | Bytes | Contents |
|---|---:|---:|---|
| `gl_p1.csv` | 2,628 | 866,460 | GL lines, 2025-01-01 → 2025-06-30 |
| `gl_p2.csv` | 2,757 | 925,860 | GL lines, 2025-07-01 → 2025-12-31 |
| `tb_p1.csv` | 31 | 3,298 | Trial balance, P1 |
| `tb_p2.csv` | 34 | 3,776 | Trial balance, P2 |
| `gl_p2_truncated.csv` | 2,619 | 876,381 | `gl_p2.csv` minus its last 138 rows — completeness-gate failure fixture |

Row counts exclude the header. All files are UTF-8, `\n`-terminated, RFC 4180
quoted, comma-separated, with a header row.

**One CSV row = one line. One file line = one CSV row.** Embedded newlines are
folded to ` | ` at export time (see `remarks` below), so a naive line-oriented
reader will not desynchronise. Quoted fields containing commas still occur (the
`against` column), so use a real CSV parser regardless.

Source: company **Meridian Trading Co.** only. The subsidiary
(*Meridian Logistics LLC*, 12 GL rows) never appears in these files.
Cancelled GL rows are excluded — there are none in this dataset (`is_cancelled = 0`
for every row).

---

## `gl_p1.csv` / `gl_p2.csv` / `gl_p2_truncated.csv`

One row per **GL Entry line**. Sorted by `posting_date`, `entry_id`,
`created_at`, `line_id`.

| # | Column | Type | Null? | Semantics |
|---:|---|---|---|---|
| 1 | `line_id` | string(10) | never | Primary key of the line. ERPNext `GL Entry.name` (a hash id). Unique across **both** periods — verified. Maps to `lines.line_id`. |
| 2 | `entry_id` | string | never | The voucher / journal entry id grouping the lines, e.g. `ACC-SINV-2025-00014`. Maps to `entries.entry_id`. **No entry_id appears in both periods** — verified — so period can be tagged per entry safely. |
| 3 | `period` | `P1` \| `P2` | never | Constant within a file. Present so concatenated files stay self-describing. |
| 4 | `voucher_type` | enum | never | ERPNext document type: `Sales Invoice`, `Purchase Invoice`, `Payment Entry`, `Journal Entry`. Four values only. |
| 5 | `voucher_subtype` | enum | never | The document's own sub-classification — the `entries.source` dimension. ERPNext records *every* manual entry as `voucher_type = Journal Entry` and keeps the real kind on the document, so this column recovers it: `Bank Entry`, `Cash Entry`, `Depreciation Entry`, `Journal Entry`, plus `Credit Note` for return invoices. For invoices and payments it equals `voucher_type`. **Use this, not `voucher_type`, when the rule cares about the source of an entry.** |
| 6 | `line_no` | int ≥ 1 | never | 1-based index of the line within its voucher, ordered by `created_at` then `line_id`. Contiguous `1..n` within every voucher — verified. Not an ERPNext field; assigned at export. |
| 7 | `posting_date` | `YYYY-MM-DD` | never | The **effective / accounting date**. Always inside the file's period. Maps to `entries.effective_date`. |
| 8 | `created_at` | `YYYY-MM-DD HH:MM:SS.ffffff` | never | The **entry timestamp** — when the document was keyed. Synthesised; see *Timestamp synthesis* below. Naive local time, no timezone offset, microsecond precision. Maps to `entries.posted_at`. May fall **outside** the period (batch entries dated 2025-12-31 carry a 2026-01-01 timestamp). |
| 9 | `user` | email | never | The posting user (`GL Entry.owner`). Four values, all `@meridian.example`. Maps to `entries.user`. |
| 10 | `account` | string | never | Full ERPNext account name, `"<number> - <name> - MTC"`, e.g. `4110 - Sales - MTC`. This is the join key to `tb_*.csv:account`. One exception carries no number: `ST 6% - MTC`. |
| 11 | `account_number` | string | **yes** | Numeric prefix, e.g. `4110`. Empty for `ST 6% - MTC`. |
| 12 | `account_name` | string | never | Human name without number or company suffix, e.g. `Sales`. Not unique on its own — prefer `account` as the key. |
| 13 | `root_type` | enum | never | `Asset`, `Liability`, `Equity`, `Income`, `Expense`. Gives `accounts.normal_balance`: Asset/Expense are debit-normal, the rest credit-normal. |
| 14 | `debit` | decimal(2dp) | never | ≥ 0. Exactly one of `debit`/`credit` is non-zero per row; the other is `0.0`. |
| 15 | `credit` | decimal(2dp) | never | ≥ 0. |
| 16 | `party_type` | `Customer` \| `Supplier` \| `""` | **yes** | Populated only on receivable/payable lines. |
| 17 | `party` | string | **yes** | Customer or supplier name. Empty on non-party lines. |
| 18 | `against` | string | **yes** | ERPNext's counter-account summary. **Heterogeneous and not a reliable key** — on receivable/payable lines it is a comma-separated list of account names (`"4120 - Service - MTC,4110 - Sales - MTC"`), on bank lines it is often a *party* name (`Ferrous Works`), and it is empty on some journal lines. Informational only: derive account pairings from the lines of the entry, never from this column. |
| 19 | `cost_center` | string | **yes** | e.g. `Sales Ops - MTC`, `Warehouse - MTC`, `Admin - MTC`. **Empty on roughly half the rows** (P1 1,273/2,628, P2 1,431/2,757) — ERPNext assigns no cost centre to receivable/payable control-account lines or to either side of a payment entry. Empty is normal, not a defect. |
| 20 | `remarks` | string | **yes** | Narration. For invoices and journal entries, the text set by the driver. For Payment Entries, ERPNext's generated three-part narration, folded to a single line with ` \| ` separators, e.g. `Amount USD 4351.12 received from Ferrous Works \| Transaction reference no ACH-25-00022 dated 2025-01-11 \| Amount USD 4351.12 adjusted against Sales Invoice ACC-SINV-2025-00022`. Contains commas — quoted. |
| 21 | `company` | string | never | Always `Meridian Trading Co.` |

### Invariants the ingest can rely on (all verified at export; export aborts on failure)

- Every voucher balances: `SUM(debit) = SUM(credit)` per `entry_id`, to 0.005.
- `line_id` unique across both periods; `entry_id` never spans periods.
- `line_no` contiguous `1..n` within each voucher.
- Exactly one of `debit`/`credit` non-zero per row.
- Every `account` in a GL file appears in that period's TB file (31/31 in P1,
  33/34 in P2 — the TB is a superset).
- `company` is single-valued.

`gl_p2_truncated.csv` satisfies all of the above **except** that it is missing
the last 138 rows (posting dates after 2025-12-28), so its activity no longer
agrees with `tb_p2.csv`. That is the point of the file.

---

## `tb_p1.csv` / `tb_p2.csv`

One row per account with any activity up to the end of the period. Sorted by
`account_number` (unnumbered accounts last).

| # | Column | Type | Semantics |
|---:|---|---|---|
| 1 | `account` | string | Join key to `gl_*.csv:account`. |
| 2 | `account_number` | string | May be empty. |
| 3 | `account_name` | string | Human name. |
| 4 | `root_type` | enum | `Asset` / `Liability` / `Equity` / `Income` / `Expense`. |
| 5 | `account_type` | string | ERPNext sub-classification: `Bank`, `Cash`, `Receivable`, `Payable`, `Tax`, `Depreciation`, `Accumulated Depreciation`, `Cost of Goods Sold`, `Chargeable`, or empty. |
| 6 | `opening_debit` | decimal | Balance brought forward, debit side. |
| 7 | `opening_credit` | decimal | Balance brought forward, credit side. |
| 8 | `period_debit` | decimal | Total debits posted **within** the period. |
| 9 | `period_credit` | decimal | Total credits posted **within** the period. |
| 10 | `closing_debit` | decimal | Balance carried forward, debit side. |
| 11 | `closing_credit` | decimal | Balance carried forward, credit side. |

**Signed-net convention.** Opening and closing are stored as a net figure split
across two columns: at most one of each pair is non-zero, the other is `0.0`.
Read them as `opening = opening_debit - opening_credit`. Both are `0.0` when the
balance is exactly nil. `period_debit` / `period_credit` are gross totals and are
routinely both non-zero.

### The completeness identity

```
opening_debit - opening_credit
  + period_debit - period_credit
  = closing_debit - closing_credit          -- per account, per period
```

This holds by construction: the TB is computed from `tabGL Entry` sums, not
asserted independently. It is checked per account before the files are written.
Also verified:

- **P1 opening is zero for every account** — the company is new, there are no
  pre-2025 postings. This still exercises the gate: `0 + activity = closing`.
- **P2 opening equals P1 closing, per account** — 31 accounts carried forward.
- **`SUM(closing_debit) - SUM(closing_credit) = 0`** for both periods.
- **TB period activity reconciles to the GL export**, both sides:
  P1 `6,214,183.87`, P2 `6,588,106.32`.
- **Every account in a GL file appears in that period's TB.** The reverse does
  not hold: `tb_p2.csv` carries 34 accounts against 33 in `gl_p2.csv`, because
  `5226 - Contractor Services - MTC` has an opening balance carried from P1 but
  no P2 activity. An account row with zero `period_debit` and zero
  `period_credit` is expected — it is exactly the VANISHED case.

Note there is **no year-end close** in this dataset. P2 closing balances on
income and expense accounts are cumulative full-year figures, not zeroed to
retained earnings. Two periods inside one fiscal year is the plan's design; a
closing entry would have made the P2 pair diff meaningless.

---

## Population as generated

### Vouchers and lines, by period and voucher type

| | P1 vouchers | P1 lines | P2 vouchers | P2 lines |
|---|---:|---:|---:|---:|
| Sales Invoice | 325 | 1,231 | 339 | 1,261 |
| Payment Entry | 381 | 762 | 468 | 936 |
| Purchase Invoice | 186 | 453 | 156 | 362 |
| Journal Entry | 55 | 182 | 62 | 198 |
| **Total** | **947** | **2,628** | **1,025** | **2,757** |

Whole year: **1,972 vouchers / 5,385 GL lines** across **34 accounts**.

By `voucher_subtype`:

| Subtype | P1 vouchers | P2 vouchers |
|---|---:|---:|
| Sales Invoice | 313 | 327 |
| Credit Note | 12 | 12 |
| Purchase Invoice | 186 | 156 |
| Payment Entry | 381 | 468 |
| Journal Entry | 37 | 44 |
| Bank Entry | 6 | 10 |
| Cash Entry | 6 | 2 |
| Depreciation Entry | 6 | 6 |

### Entry-size distribution (lines per voucher)

This is the histogram the projection cap decision should be made from — **not**
decided in advance.

| Lines | P1 vouchers | P2 vouchers |
|---:|---:|---:|
| 2 | 567 | 650 |
| 3 | 150 | 149 |
| 4 | 146 | 153 |
| 5 | 64 | 59 |
| 6 | 12 | 7 |
| 7 | 2 | 1 |
| 9 | 6 | 6 |
| **max** | **9** | **9** |

Two-line vouchers dominate (~62%), which is what a real ERP population looks
like: every payment entry is exactly two lines. The 9-line vouchers are the
monthly overhead allocations. At this scale an uncapped projection is
tractable — pairing every debit against every credit peaks at 4×5 = 20 pairs on
a 9-line entry.

### Posting users

| User | P1 vouchers | P1 lines | P2 vouchers | P2 lines |
|---|---:|---:|---:|---:|
| `ar.clerk@meridian.example` | 550 | 1,663 | 636 | 1,847 |
| `ap.clerk@meridian.example` | 332 | 745 | 322 | 694 |
| `controller@meridian.example` | 38 | 136 | 35 | 120 |
| `batch.bot@meridian.example` | 27 | 84 | 32 | 96 |

### Amounts

Line amounts range from `0.69` to `47,106.69`. They derive from
quantity × jittered unit price — multiplicative, so the leading-digit
distribution emerges from the arithmetic rather than being sampled toward a
target. Nothing was fitted to Benford.

---

## Deliberate interventions (the complete list)

Only two kinds of intervention exist in this dataset. **No anomaly was planted.**
Which account pairs result from any of these is decided by ERPNext's posting
logic, not by the generator.

### 1. P2 structural changes — business events, as they materialised

| # | Change | How it shows up |
|---|---|---|
| 1 | **New revenue line.** Installation Services sold from August 2025. | `4140 - Installation Revenue - MTC`: **0 lines in P1, 31 lines / $39,829 across 31 P2 invoices**, first 2025-08-05. Often billed alongside a product line, so it pairs with Debtors, ST 6% and Sales. |
| 2 | **New vendor category.** Equipment leasing begins in P2; new supplier *Sterling Equipment Leasing*. | `5227 - Equipment Lease Expense - MTC`: **0 in P1, 12 lines / $78,107 in P2**. Supplier is a P2-only party — 0 purchase invoices in P1, 12 in P2. |
| 3 | **New intercompany flow.** Subsidiary *Meridian Logistics LLC* charged a monthly management fee from July. | `1320 - Intercompany Receivable - MTC`: **0 in P1, 6 lines / $63,094 in P2**, posted by the controller. The mirror entry lives in the subsidiary's books and is **not** in these files. |
| 4 | **Vanished activity.** The *Fairbanks Consulting* contract ends 30 June. | `5226 - Contractor Services - MTC`: **18 lines / $135,978 in P1, 0 in P2**. Supplier billed 18 purchase invoices in P1, **0 in P2**. ⚠️ *Fairbanks still appears as a `party` on 4 Payment Entries in early July* (5–22 July), settling its final P1 invoices. That is correct accounting, not a leak — a VANISHED test on **billing** holds, a naive test on "party never appears in P2" does not. |
| 5 | **Shifted volume.** One product line grows, one supplier shrinks. | *Premium Widget* quantity sold **905 → 1,842** (2.03×). *Orchard Wholesale* purchase invoices **48 → 18**; Cost of Goods Sold $634,604 → $423,213. |

Expected pair-diff outcome: NEW edges around Installation Revenue, Equipment
Lease Expense and Intercompany Receivable; VANISHED around Contractor Services;
SHIFTED on the Sales/Debtors and COGS/Creditors edges.

### 2. Timestamp synthesis

Every document was generated in one sitting, so raw `creation` values clustered
in a few minutes of real time and carried no information. `created_at` is
rewritten by SQL after posting, **by role, uniformly** — never per entry:

| Owner | Window |
|---|---|
| `ar.clerk`, `ap.clerk` | 08:00–18:30, weekdays only |
| `controller` | 07:30–19:30, weekdays only |
| `batch.bot` | **01:00–04:00 on the day after the posting date** |

Every value is a pure function of `md5(voucher_name, posting_date, owner)`, so
the step is deterministic and idempotent — rerunning produces byte-identical
timestamps. It touches only *when*; it does not move an amount, an account or a
pairing.

Resulting texture:

| | P1 | P2 |
|---|---:|---:|
| Lines outside 07:00–19:59 | 84 / 2,628 (3.2%) | 96 / 2,757 (3.5%) |
| Lines with a weekend `created_at` | 32 | 32 |
| Lines with `created_at` ≥ 2 days after `posting_date` | 205 (7.8%) | 195 (7.1%) |

**The off-hours population is exactly and only `batch.bot`.** 100% of its lines
are off-hours, and 36% land on a weekend, because month-end batches dated the
last business day get a next-day timestamp that frequently falls on a Saturday.
This is the automation-decay effect the scope doc predicts: the classic
off-hours rule, run on this population, returns the robot and nothing else. That
observation belongs in the README.

The date-mismatch counts have **two** sources, and the ingest should not read
them as one signal:

1. **Deliberate:** ~5% of clerk-entered *invoices* are timestamped 2–10 days
   after their posting date (late entry / backdating texture).
2. **Incidental and legitimate:** payment entries whose posting date falls on a
   weekend get the next business day's timestamp — a Saturday-dated payment
   keyed on Monday reads as a 2-day gap.

---

## Known quirks worth knowing before writing the ingest

1. **`cost_center` is empty on control-account lines.** Receivable and payable
   lines carry no cost centre — ERPNext does not assign one. Do not treat empty
   as a data error.
2. **`against` is not a key.** Mixed content (account lists *and* party names).
   Build pairings from the entry's own lines.
3. **`created_at` can fall outside the period.** 18 P2 rows carry a 2026
   timestamp — batch entries posted 2025-12-31 get the next-day overnight
   window. Period tagging must key off `posting_date` / the `period` column,
   never `created_at`.
4. **`account_number` is empty for `ST 6% - MTC`.** Sort and join on `account`.
5. **No opening-balance voucher exists.** P1 opens at zero because the company
   is new, not because an opening entry was posted. There is no
   `Opening Entry` voucher to filter out.
6. **Timestamps are naive local time**, no offset, microsecond precision.
   Parse as local, not UTC.
7. **`entry_id` prefixes encode the type**: `ACC-SINV-` sales invoices *and
   credit notes*, `ACC-PINV-` purchase invoices, `ACC-PAY-` payments, `ACC-JV-`
   journal entries. Convenient, but `voucher_type` / `voucher_subtype` are
   authoritative — a credit note is an `ACC-SINV-`.
8. **Series numbers have gaps.** Failed inserts during development consumed
   sequence numbers. `entry_id` is a unique identifier, not a dense counter, and
   a gap is not a missing entry.
9. **`created_at` ordering is not causally consistent across linked documents.**
   Timestamps are synthesised per document from its own
   `(name, posting_date, owner)`, with no cross-document constraint, so the
   late-entry texture can put a payment's `created_at` a little before the
   `created_at` of the invoice it settles. Measured: **10 of 849 payment
   references (1.2%)** — 5 against sales invoices, 5 against purchase invoices.
   Credit notes are unaffected (0). Nothing downstream should compare
   `created_at` *between* documents or infer an entry order from it; every rule
   that cares about sequence must key off `posting_date`. Flagged rather than
   fixed: constraining it would have meant abandoning the pure-function
   determinism that makes the synthesis idempotent and auditable.

---

## Reproducing

```
./infra/scripts/run_all.sh            # from an empty site
./infra/scripts/run_all.sh --reset    # re-drive transactions on an existing one
```

Pipeline, all inside `erpnext-backend-1`, ~5 minutes end to end:

| Script | Does |
|---|---|
| `setup_site.py` | Completes the setup wizard — installs ERPNext fixtures, creates *Meridian Trading Co.* (`MTC`, "Standard with Numbers" chart) and FY2025. Required: a bare site has no UOMs, item groups or warehouse types, and creating a Company directly fails with `LinkValidationError: Could not find Warehouse Type: Transit`. |
| `seed_master.py` | Subsidiary, 4 users, 3 cost centres, 10 extra accounts, sales-tax template, 15 customers, 12 suppliers, 12 non-stock items. |
| `drive.py` | `run("P1")` / `run("P2")`. Seeded RNG per month, resumable, ~1m40s per period. |
| `timestamps.py` | Role-based `created_at` synthesis. |
| `export.py` | 24 sanity checks, then the five CSVs. Aborts without writing if any check fails. |

Determinism: the RNG is seeded per calendar month (`Random(20250000 + month)`),
so a month re-driven from scratch reproduces the same business activity.
Document ids will differ, because ERPNext's naming series is global and
monotonic — so exports are reproducible in *shape and totals*, not byte-for-byte
in `entry_id`.
