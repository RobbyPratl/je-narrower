# JE Population Testing — Scope & System Design

**Status:** Scoped, not built
**Purpose:** Portfolio demo — full-population journal entry testing, graph-forward, agentic investigation
**Target:** Clark (getclark.com) — Junior Software Engineer

---

## Claim

> Full-population JE testing: completeness gate, graph-based scoring across periods, agentic case files. The engine flags what's unusual, the agent gathers cited evidence, the auditor decides what it means.

**Not claimed:** that the graph is algorithmically required at this scale. It is the right structure and the right visualization. Traversal becomes essential only at hundreds of accounts with multi-hop paths. Say this plainly rather than overselling.

**Not built:** chatbot, conclusion engine, workpaper writer, or a miniature Clark (methodology, engagement state, sign-off workflow).

---

## Problem

Journal entry testing is required in every financial statement audit — AU-C 240 for nonissuers, AS 2401 for issuers. It is the designated procedure for detecting management override of controls, and PCAOB staff continue to flag it as a frequent source of inspection deficiencies.

Done manually it is sampling or Excel. Done LLM-first it produces hallucinated entries and uncitable claims. What's needed: a validated complete population, deterministic flags, agentic evidence gathering, and a human conclusion.

PCAOB amended AS 1105 and AS 2301 to cover technology-assisted analysis of electronic data, effective for audits of fiscal years beginning on or after December 15, 2025 — while being explicit that the amendments were not written to cover AI specifically. That is exactly the line this project builds to: machine analysis of the full population, human judgment on the conclusion.

---

## Source data

**ERPNext** (GPL v3, self-hosted). Stand up an instance, drive varied transaction volume through it, export the GL.

Provides:

- entry IDs grouping lines
- multi-line debit/credit entries
- posting user, timestamp, narration
- cost centers
- a real trial balance
- no PII (demo companies only)

The pairing distribution comes from ERPNext's posting logic, not from you. Sales invoices, purchases, payroll, and depreciation each post their own account patterns at their own frequencies, so rarity emerges from an accounting engine's behavior rather than being placed by hand. This is what defeats the "you planted the anomalies you then detect" objection.

**Two periods are a hard requirement**, not a nice-to-have — period comparison is a scoring input. Drive P1 volume, cut, then drive P2 including some deliberate structural change (new vendor category, new revenue line, new intercompany flow).

**Fallback:** Schreyer's public synthetic JE dataset (~533k line items, research-grade, citable) if ERPNext volume proves thin. Weakness: SAP-shaped anonymized categorical attributes, so account names aren't human-readable and the graph loses legibility.

**Rejected:** Oklahoma State GL (data.ok.gov) — real public double-entry data, but published as summarized ledger balances with no journal ID, one amount per row, and no user or timestamp. Already rolled up. Wrong granularity.

---

## Pipeline

```
ERPNext GL export (P1, P2) + trial balance
      │
  [1] Ingest ─────────── canonical schema; period tag on every entry
      │
  [2] Completeness ───── opening + activity = closing vs TB, per period
      │                  FAIL → hard block
      │
  [3] Profile ────────── counts, users, sources, dates, entry-size histogram
      │
  [4] Graph ──────────── store: entry ↔ account (star, lossless)
      │                  project: account ↔ account per period
      │                  diff: P1 pairs vs P2 pairs
      │
  [5] Score ─────────── population-relative rules + parametric rules
      │                 deterministic; golden-file tested
      │
  [6] UI ─────────────── profile → graph (P1/P2/Diff) → entry list → case file
      │
  [7] Agent ──────────── plan depends on which rules fired
      │
  [8] Verifier ───────── citations must resolve; retry once, then escalate
      │
  [9] Human ──────────── review / escalate / mark investigated
```

**Anti-wrapper test:** delete layers 7–8 and everything upstream still runs.

---

## Data model

| Table | Fields |
|---|---|
| `entries` | entry_id, **period**, posted_at, effective_date, user, source, narration |
| `lines` | line_id, entry_id, account, debit, credit, cost_center, memo |
| `accounts` | account, name, type, normal_balance |
| `pairs` | **period**, account_a, account_b, count, total_amount, first_seen, last_seen |
| `pair_diff` | account_a, account_b, status, p1_count, p2_count, volume_delta |
| `scores` | entry_id, rule, score, inputs |
| `cases` | entry_id, plan, findings, citations, verifier_status |

`pairs` is keyed by period — that is what makes emergence computable. `pair_diff` derives from two periods of `pairs`. Both are rebuildable, neither authoritative.

**Canonical pair ordering:** sort `account_a` / `account_b` lexically on write, always. Otherwise the same pairing appears twice and the diff produces phantom emergence. Easy bug, silently wrong results.

---

## Completeness gate

Real trial balance tie-out: opening + activity = closing, per account, per period. Plus per-entry debits = credits.

Data completeness is a long-standing AS 1105 requirement — testing the entire population only helps if the population is validated as complete and accurate. Everything downstream is meaningless without it, so failure is a hard block, not a warning.

On failure the UI is visibly disabled, not just empty. **Demo this** by loading a deliberately truncated export. A tool refusing to analyze an unvalidated population is a better moment than any chart.

---

## Graph & projection

**Store the star.** Entry node → edges to every account it touches. Lossless, handles any entry size.

**Project to account pairs** for scoring and display: pair every debit account against every credit account within an entry, weighted by amount share, **within period**. Cap at N lines per entry and log what was skipped.

The entry-size histogram justifies the cap. This is the one real modeling decision in the project — the academic literature avoids it entirely by excluding entries above ~4 lines. Document that you didn't, and what the cap costs.

---

## Pair diff

```
status = NEW        p1_count = 0, p2_count > 0
       = VANISHED   p1_count > 0, p2_count = 0
       = SHIFTED    both > 0, |volume_delta| beyond tolerance
       = STABLE     otherwise
```

An entry's emergence score derives from the rarest-status pairing it contains. An entry introducing a NEW pairing scores highest; an entry using only STABLE pairings scores zero on this rule.

**Two caveats to state in the README:**

- **Cold start.** Every pairing in P1 is trivially new — there is no prior. Emergence only scores on P2. Three periods would let you distinguish "new in P2, persisted in P3" from "new in P2, gone by P3," which is more informative. Note as future work; don't pretend two periods is sufficient.
- **Business change is not fraud.** New product lines, new vendors, and new tax regimes all produce NEW pairings legitimately. This narrows attention; it does not conclude.

---

## Scoring

Deterministic. No model touches a score. Split explicitly into two groups — and say why in the README.

### Population-relative (no parameter you chose)

| Rule | Signal |
|---|---|
| Pair rarity | Account combination is rare within period |
| **New-pair emergence** | Combination absent in P1, present in P2 |
| Benford deviation | Leading-digit distribution by account vs. expected |
| Threshold proximity | Unnatural mass just under round boundaries |
| Entry-size outlier | Line count vs. population distribution |

### Parametric (you picked a number; a reviewer can argue with it)

| Rule | Signal |
|---|---|
| Round amount | At threshold |
| Date mismatch | Posting date ≠ effective date beyond tolerance |
| Off-hours | Weekend / outside business hours |
| Unusual user | Poster atypical for that account |

**Weight the population-relative group higher.** That calibration argument is worth more than the rule count.

Each rule emits score + inputs. Composite is a documented weighting, never learned. `expected_scores.json` locks it.

### Deliberately excluded

- **Isolation forest, autoencoders, any learned scoring.** The literature is full of it and every paper reports against injected anomalies because no labeled ground truth exists. It would also break the central claim — the moment a model assigns scores, "the engine is deterministic" stops being true.
- **Off-hours as a standalone flag.** Modern ERPs post automated batches overnight and on weekends. Expect this to fire on your own ERPNext automation, and say so in the README. Noticing that a classic rule has decayed is a better observation than shipping it uncritically.

---

## Investigation agent

Per entry, on click. Not batch.

**Tools**

| Tool | Returns |
|---|---|
| `get_entry_lines(entry_id)` | All lines + memos |
| `get_pair_history(pair)` | Occurrence history within period |
| `get_pair_diff(pair)` | Status and counts across both periods |
| `get_similar_entries(entry_id)` | Same account pattern historically |
| `get_user_activity(user, period)` | Poster's other entries |
| `get_account_context(account)` | Description, normal volume, typical counterparties |

**Plan depends on which rules fired.** This is what makes it an agent rather than a fixed function:

- **Emergence** → `get_pair_diff` → `get_account_context` on both accounts → `get_similar_entries` (*did anything like this exist before under a different pairing?*)
- **Rare pairing** → `get_pair_history` → `get_similar_entries`
- **Off-hours / unusual user** → `get_user_activity` → their other entries that period
- **Large multi-line** → `get_entry_lines` → `get_account_context`

**Log the plan.** Showing why it looked where it looked is more interesting than the findings.

**Output:** structured case file — facts, each carrying a row or entry citation. No fraud conclusion. No intent characterization. No workpaper.

---

## Verifier

Code, not judgment. Every citation must resolve to a real row or the case file does not render.

On failure: retry once with the error in context, then escalate to human with the raw trace. Never silently drops.

---

## UI

No chat window anywhere.

### Completeness banner

Persistent strip. Source, entries per period, TB status. Red disables everything below it.

### Population profile

Row of small dense charts, readable in five seconds:

- **Entry-size histogram** — most important; justifies the projection cap
- Entries and lines by month
- Top accounts by volume
- Benford chart
- Flag count by rule

### Graph canvas

Account-pair graph. Node size = account volume. Layout pre-computed and cached — don't make the viewer watch it settle.

Three modes:

- **P1** / **P2** — edge thickness = frequency, edge color = rarity
- **Diff** *(default)* — edges colored by status: NEW hot, VANISHED ghosted, SHIFTED gradient, STABLE muted

Diff is default because it's the most informative view and it's how auditors actually think: *what changed?*

Controls:

- **Score threshold slider** — drag up, routine structure fades, emergent edges remain. Best interaction in the demo.
- Filter by rule
- Click edge → filtered entry list
- Hover → pair name, counts in both periods, first-seen date

### Entry list

Sortable: entry_id, period, date, accounts touched, amount, score, rules fired, status. Selection synced bidirectionally with the graph — highlight in one, highlight in the other.

### Case file panel

Slides in from the right. Four visually distinct sections, because their epistemic status differs:

1. **Engine** (deterministic) — score with per-rule breakdown, each showing the actual inputs that triggered it. No prose.
2. **Agent** (retrieved) — the plan it chose and why, then findings. Every fact carries an inline citation chip; click to open the source row. Facts without chips cannot render.
3. **Verifier** — badge: passed / retried / escalated. On escalate, show the raw trace.
4. **Human** — mark reviewed, escalate, add note. Terminal; nothing above it is editable.

The visual separation is the argument. A reviewer should tell at a glance which parts a model touched.

---

## Build order

Each step demos on its own.

1. ERPNext setup, two periods of transactions with deliberate P2 structural change, GL export
2. Ingest + completeness gate + golden test — *demos alone*
3. Profile + entry-size histogram
4. Graph build + per-period projection + pair diff
5. Scoring, both rule groups + golden test — *demos alone*
6. Graph UI with diff mode — *demos without agent*
7. Agent + verifier
8. Case file panel, README, demo script

---

## Out of scope

- Adapter framework (canonical schema only, one source)
- Multi-user, engagement state, methodology, workpapers, sign-off workflow
- Auto-conclusions, intent characterization
- Three-plus period trending
- Scale beyond demo volume

---

## Stack

Node / TypeScript end-to-end. Postgres. Cytoscape.js for the graph.

---

## Success criteria

- Completeness gate blocks a truncated export; passes a good one
- Graph renders; emergent pairings visible as hot edges in diff mode
- Scoring deterministic; test suite matches golden file
- Click entry → agent case file with valid citations
- Verifier rejects an uncited case file in test
- Three-minute walkthrough without opening a chat window

---

## Open items before building

- Confirm ERPNext demo data volume and GL export schema
- Verify the PCAOB AS 1105 / AS 2301 amendment details and inspection-deficiency claims directly at pcaobus.org before any of it goes in an email
- Decide the projection cap N from the actual entry-size distribution, not in advance
