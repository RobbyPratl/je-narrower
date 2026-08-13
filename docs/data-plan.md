# ERPNext Data Generation Plan

Companion to `je-population-testing-scope.md`. Defines what transaction volume gets driven through ERPNext and how the two periods differ. The pairing distribution comes from ERPNext's posting logic; this plan only decides *what business activity happens*, never which account pairs result.

## Instance

- frappe/erpnext v16.31.1 via frappe_docker `pwd.yml`, site `frontend`, http://localhost:8080
- Driver scripts run inside the backend container via `bench --site frontend execute` / console — no REST auth needed, and `frappe.set_user()` lets us post as distinct users.

## Periods

Single fiscal year 2025, one company ("Meridian Trading Co." or similar, demo-only, no PII).

- **P1:** 2025-01-01 → 2025-06-30
- **P2:** 2025-07-01 → 2025-12-31

Opening balances for P1 are zero (new company), so the completeness tie-out (opening + activity = closing) is still exercised per account; P2 opens with P1 closings.

## Posting users

Documents are posted by distinct users so the unusual-user rule has a population to work with:

| User | Posts |
|---|---|
| ar.clerk@ | Sales invoices, incoming payments |
| ap.clerk@ | Purchase invoices, outgoing payments |
| controller@ | Manual JEs, accruals, corrections |
| batch.bot@ | Depreciation, payroll batches, recurring entries |

## Transaction mix (monthly, both periods)

| Activity | Volume/month | ERPNext doctype |
|---|---|---|
| Sales invoices, varied items/qty/customer | 30–50 | Sales Invoice |
| Customer payments | most invoices, some partial/late | Payment Entry |
| Purchase invoices, varied suppliers | 20–35 | Purchase Invoice |
| Supplier payments | most invoices | Payment Entry |
| Payroll batch (salary exp / payable / withholding) | 1 | Journal Entry |
| Depreciation | 1 | Journal Entry |
| Accruals / prepaid amortization / corrections | 2–5 | Journal Entry |

Target: roughly 1,500–2,500 GL entries and 6–10k GL lines across the year — enough for the entry-size histogram, Benford by account, and pair rarity to be meaningful at demo scale.

Amounts derive from item prices × randomized quantities with price variance — multiplicative, so leading-digit distribution emerges naturally rather than being sampled from a target.

Payroll note: the HRMS app is not installed (separate app since v14), so payroll posts as monthly journal entries by `batch.bot@`. Say this in the README rather than pretending the payroll module ran.

## P2 structural changes (deliberate, documented)

These create the NEW / VANISHED / SHIFTED population for the pair diff. They are business changes, not planted anomalies — which pairs they produce is still up to ERPNext.

1. **New revenue line** — new item group ("Installation Services") mapped to a new income account; sales begin mid-P2.
2. **New vendor category** — equipment leasing begins in P2 (new expense account, new supplier).
3. **New intercompany flow** — subsidiary company created; monthly intercompany JEs (receivable/payable) start in P2.
4. **Vanished activity** — a P1 contractor expense stops entirely after June (contract ended).
5. **Shifted volume** — one product line's sales roughly double in P2 (growth), one supplier's volume drops sharply.

## Timestamp synthesis (documented, not hidden)

All documents are generated in one sitting, so `creation` timestamps must be rewritten to match posting dates (direct SQL on `tabGL Entry`/document tables after posting). Assignment is by role, not per-entry hand-placement:

- Clerk-posted docs: business hours, weekdays, jittered
- batch.bot@ docs: overnight windows (01:00–04:00), some weekends — which is exactly why the scope doc expects the off-hours rule to fire on automation; that observation goes in the README.

This is synthesis of *when*, applied uniformly by role. It does not touch which accounts pair or which entries score.

## Exports (deliverable to ingest workstream)

Per period: GL export (entry id, account, debit, credit, posting date, creation timestamp, user, voucher type, narration, cost center) and trial balance (opening / debit / credit / closing per account). Plus a deliberately truncated GL variant for the completeness-gate failure demo. Export schema gets documented in `docs/export-schema.md` once real exports exist.
