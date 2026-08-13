# Design Brief — Journal Entry Testing Workspace (v5)

## Principle

**The table is the application.** Rows and columns, always visible, always the thing you return to.

Everything else — the profile band, the graph, the memo drawer — is an **optional panel** the user toggles. Nothing is a page you navigate to. Nothing replaces the table.

Two features carry the "this isn't Excel" argument:

1. **The clearance memo** — auto-drafted, citation-backed rationale for why an entry or group was concluded. This is the differentiator. It lives in a drawer beside the table, not in a separate screen.
2. **The emergence graph** — account-pair diff across periods. This is the visual hook. It lives in a togglable panel.

Both are off by default. The user turns them on.

---

## The person

An audit associate doing journal entry testing. ~200 flagged entries out of ~50,000. Their session is: reconcile the population, review flagged patterns, conclude, get reviewed.

They read dense numeric tables all day and live in Excel — survey data shows 63% of auditors prefer Excel for visualization, equal across Big Four and non-Big Four. They will not learn a new paradigm. They will learn a better table.

**Why not Excel:** Excel finds the 203. It cannot investigate each one, group them by computed consistency, draft the clearing rationale with resolvable citations, or produce a decision record that survives to next year.

---

## Visual direction

### Avoid

Dark background with a neon accent. Warm cream with high-contrast serif and terracotta. Broadsheet hairline-rule newspaper layout. These are the three defaults every AI design tool produces.

No floating cards on gradients. No chat interface. No "AI" tab.

### Character

The auditor's vernacular: ruled ledger columns and **tick marks** — the annotation placed beside a figure to record that a human verified it. The tick mark is the signature element.

### Palette

Colour encodes **epistemic status**. Never hierarchy, never decoration.

| Token | Hex | Means |
|---|---|---|
| `ground` | `#F7F8F9` | Background. Cool paper, not cream. |
| `ink` | `#16181D` | Fact — sourced or computed. Checkable. |
| `mute` | `#8A9099` | Structure, axes, inactive marks. |
| `inferred` | `#4C5FD5` | Interpretation. Not checkable. |
| `signal` | `#C2410C` | Unusual, or deviating from a group. |
| `verified` | `#0F766E` | A human concluded. |

### Typography

- **UI:** neutral grotesque, slightly narrow. *Instrument Sans* or *Geist*. Not Inter.
- **Data:** monospace with tabular figures — every number, account code, entry ID, timestamp. *Commit Mono* or *Martian Mono*. Not JetBrains Mono.
- **Prose:** memo text and agent interpretation only. Grotesque, smaller, looser leading.

**Numbers are never set in the sans face.**

Scale: 11 / 12 / 13 / 15 / 20 / 28.

### Structure

1px rules at 6% ink. No shadows. No radius above 4px. Density is the aesthetic.

---

## Layout

```
+----------------------------------------------------------------------+
| STATUS BAR                                    [profile] [graph] [==]  |
+----------------------------------------------------------------------+
| PROFILE BAND (optional, collapsed by default)                        |
+----------------------------------------------------------------------+
|                                        |                             |
|  TABLE                                 |  MEMO DRAWER                 |
|  always visible                        |  (optional, opens on         |
|                                        |   entry/group select)        |
|                                        |                             |
+----------------------------------------------------------------------+
| GRAPH PANEL (optional, bottom drawer)                                |
+----------------------------------------------------------------------+
```

Three toggles in the status bar: **profile**, **graph**, **columns** (`==`). All state persists per user.

The table never disappears. Opening the graph shrinks it; opening the memo drawer narrows it. Neither replaces it.

---

## Status bar

`GET {base}/status` · `POST {base}/override`

One line when reconciled:

```
Reconciled . meridian-2025 . FY25 P1-P2 . 1,972 entries . 203 flagged     [profile] [graph] [==]
```

When `canConclude` is false, expands to show `reconciliation` exceptions per account with `grossDeltaCents` as the headline and net stated separately. Offsetting differences summing to zero is common — never state one number the listed figures contradict.

Override form inline. The resulting `override.reason` and the `population` stamp print on every memo and decision record.

Pipeline state from `status.pipeline` renders as a stage strip; incomplete stages disable the relevant toggles rather than letting panels 409.

---

## The table

`GET {base}/queue` — rows are `items`, sorted by `consistency.score` descending.

```
+---------------------------------------------------------------------------------+
|  Reviewed 45 / 203  ####..........   [ open | reviewed | all ]  [ group | dev ]  |
+---------------------------------------------------------------------------------+
|                    J F M A M J J A S O N D   consist  amount        prep  status |
+---------------------------------------------------------------------------------+
| > 6210 / 2110  45  . . . . . . . . . . . .   ######   8.2-9.1k       R      open |
|   round_amount . off_hours                                                       |
|                                                                                  |
| > 5100 / 1590  12  . . . . . . . . . . . .   ######   4.0k         (sys)   open |
|   off_hours                                                                      |
|                                                                                  |
| ! 6210 / 2110   1  . . . . . . . O . . . .   ------   88.4k          M      open |
|   deviation . amt 5x group median . different preparer                           |
|                                                                                  |
| v 4010 / 2300   3  . . . . . . . . o o o .   ##....   25-40k        R,M    open |
|   pair_rarity . new_pair . round_amount                                          |
|     ACC-JV-0417  14 Sep  25,000.00  0.62  [rn c]                          open   |
|     ACC-JV-0463  28 Sep  25,000.00  0.62  [rn c]                          open   |
|     ACC-JV-0501  12 Oct  40,000.00  0.71  [rn c]                       reviewed  |
+---------------------------------------------------------------------------------+
```

Row `kind` drives treatment: `group` expands to entries, `deviation` gets `signal` styling and sits at its own row, `individual` renders inline.

Filter chips map directly to `reviewStatus` and `kind` query params.

### Column library — the customization surface

The `==` toggle opens a column configurator. Users pick which columns show, reorder by drag, and set density. **Saved views** persist a full configuration under a name.

| Column | Source | Default |
|---|---|---|
| Pair | `pair` | on |
| Entry count | `entryCount` | on |
| Cadence sparkline | `recurrence.marks` | on |
| Consistency bar | `consistency.score` | on |
| Rules fired | `rulesFired` | on |
| Amount range | derived from entries | on |
| Preparer | derived from entries | on |
| Review status | `reviewStatus` | on |
| Recurrence label | `recurrence.label` | off |
| Composite score | entry-level | off |
| Period | entry-level | off |
| Posted vs effective gap | entry-level | off |
| Line count | `lineCount` | off |
| Case status | `caseStatus` | off |

Density: **compact** (28px), **standard** (32px), **comfortable** (40px). Compact is the default — this audience wants more rows, not more air.

Two preset views ship: **Triage** (cadence, consistency, rules, status) and **Detail** (adds composite, period, line count, case status).

### Cell visuals

**Cadence sparkline** — one mark per entry from `recurrence.marks`, positioned by month across the shared axis in the header. Even spacing reads recurring; a cluster reads emergent; scatter reads neither. Mark size encodes amount; `signal` marks a deviating member.

Stacked on a **shared time axis**, these are the visualization. No separate chart needed.

**Consistency bar** — `consistency.score` as filled proportion. Solid means one decision; a gap means look closer. Hover shows `consistency.detail`.

**Amount range strip** — min–max with median marked. Narrow reads formulaic; wide reads ad hoc.

**Preparer chip** — initial for one, count badge for several, distinct glyph for a system account.

### Two rules for cell visuals

**Shared scale across rows, always.** Per-row auto-scaling makes the column lie — a tiny pattern and a huge one render identically. This is the most common inline-viz failure.

**Each answers a sentence.** *"It's monthly." "That one's five times the others." "Two preparers."* If you can't imagine the sentence, cut the column.

### Interaction

- Brush the header time axis → filters rows to that window
- Click a sparkline mark → that entry expands in place
- Click a row → expands to entries
- `j/k` move · `space` expand · `m` memo · `g` graph · `enter` open entry

Expansion happens **in place**. Nothing navigates away.

---

## Panel 1 — Memo drawer *(the differentiator)*

Opens on the right when an entry or group is selected. Toggleable; remembers its state.

This is the feature that answers "why not Excel." PCAOB's cited deficiencies in this area are rationale failures — limiting procedures without documenting an appropriate rationale — and no incumbent auto-drafts the clearing narrative.

### For an entry

`GET {base}/entries/:entryId` + `GET {base}/cases/:entryId`

```
+--------------------------------------------------+
| ACC-JV-0417 . 14 Sep 2025 . 25,000.00      [x]  |
+--------------------------------------------------+
| FLAGGED BY                          engine       |
|   pair_rarity          0.81  (i)                 |
|   new_pair             0.74  (i)                 |
|   round_amount         0.40  (i)                 |
|   composite            0.62                      |
+--------------------------------------------------+
| SOURCE FACTS                        ink . mono   |
|   posted 2025-09-14 02:00 by accountant@   [1]   |
|   narration "Q3 deferral adjustment"       [2]   |
|   2 lines . balanced                       [3]   |
+--------------------------------------------------+
| COMPUTED                            ink . mono   |
|   8x median for account 4010          f    [4]   |
|   preparer posts 4010 in 3% of cases  f    [5]   |
+--------------------------------------------------+
| INTERPRETATION                  inferred . sans  |
|   Consistent with a newly introduced deferral    |
|   process rather than an isolated adjustment.    |
|   Not independently verifiable.                  |
+--------------------------------------------------+
| VERIFIER                                         |
|   5 source rows resolved                         |
|   2 computations reproduced                      |
|   1 interpretation - unverifiable by design      |
+--------------------------------------------------+
| DRAFT MEMO                          editable     |
|   +--------------------------------------------+ |
|   | Entry ACC-JV-0417 was flagged for pair    | |
|   | rarity, new-pair emergence, and round     | |
|   | amount. The pairing 4010/2300 does not    | |
|   | appear in P1 [1]. The amount is 8x the    | |
|   | median for account 4010 [4]. Posted       | |
|   | 02:00 by accountant@ [1], who posts to    | |
|   | this account in 3% of cases [5].          | |
|   |                                            | |
|   | Population: reconciled, 1,972 entries,     | |
|   | gl_p1.csv sha256 a3f2...                   | |
|   +--------------------------------------------+ |
|                                                  |
| CONCLUSION                                       |
|   ( ) appropriate-recurring                      |
|   ( ) appropriate-adjustment                     |
|   ( ) appropriate-other                          |
|   ( ) requires-procedures                        |
|                                                  |
|            [ copy ]  [ record conclusion ]       |
+--------------------------------------------------+
```

**The four sections must not look alike** — they are different epistemic categories. Source facts are retrieved and citable. Computed facts are derived and their formula is inspectable. Interpretation is inference in `inferred`, explicitly labelled unverifiable. A citation proves an entry exists; it cannot prove an entry is appropriate.

**The draft memo assembles from the sections above it.** Citation markers stay live — clicking `[4]` in the memo calls `GET {base}/citations/:kind/:ref` and opens the source row in a popover. The user edits freely; the edited text posts as `basis` on `POST {base}/decisions/entry/:entryId`.

**Verifier states what it verified**, not a count. Naming the unverifiable inference reads as rigour.

### For a group

`GET {base}/queue/:groupId`

Same drawer, different content: `groupingBasis`, `consistency.detail` as a matrix, rolled-up `procedures`, `excludedDeviations` listed with links. Memo drafts from the group basis. Posts to `POST {base}/decisions/group/:groupId` with `entryIds` exactly as returned — re-fetch before submitting to avoid `422 stale_group`.

The consistency matrix is the visual proof of the grouping claim: entries as rows, attributes as columns, cells shaded by agreement. A tight group reads as a solid field; a deviation is a hole in it. Fill density, not colour alone.

### API note

The memo drafts client-side from the existing case file — no new endpoint required. If it moves server-side later, `GET {base}/cases/:entryId/memo` is the natural shape.

---

## Panel 2 — Graph *(the visual hook)*

`GET {base}/graph?mode=diff` — bottom drawer, toggleable, off by default.

Diff is the default mode because emergence is the interesting signal: an account pair that did not exist in P1 and appears in P2 is the structural signature of a new process — or of override.

- Nodes from `nodes`, sized by `volume`, labelled by `label`, grouped by `rootType`
- Edges by `status`: **NEW** in `signal` at full weight, **VANISHED** ghosted to 20%, **SHIFTED** at half, **STABLE** in `mute`
- Mode switch: `diff` / `p1` / `p2`. Period modes colour edges by `rarity` and weight by `count`.
- Hover an edge → `p1Count`, `p2Count`, `volumeDelta`
- **Click an edge → the table filters to those entries.** This is what keeps it a tool rather than a picture.
- Layout pre-computed and cached. Never animate the settle.

**Unit warning:** graph `volume`, `volumeDelta`, and `totalAmount` are decimal base currency; entries and lines are integer cents. Normalize at the client boundary or ship a 100× bug.

---

## Panel 3 — Profile band *(optional)*

`GET {base}/profile` — collapsed by default, expands under the status bar.

Four small charts from what's served: entry-size histogram (leftmost — it justifies the projection cap), entries by month, top accounts, flag counts by rule. No legends, no gridlines, one number under each.

---

## Customization summary

| Surface | What's configurable | Persists |
|---|---|---|
| Columns | which, order, density | per user |
| Saved views | named column + filter + sort presets | per user |
| Panels | profile / graph / memo open state | per user |
| Graph | mode, edge status filter | per session |
| Table | sort, filters, page size | per session |

Ships with **Triage** and **Detail** presets. Users can save their own.

This is the honest answer to "isn't this just Excel" on the customization axis: Excel is configurable but nothing survives the file being re-sent. Here the configuration is a named view that persists across engagements and across people.

---

## State transitions

| Event | Behaviour |
|---|---|
| Conclusion recorded | Group frozen with its `entryIds`. Later entries do not join retroactively. |
| Reopen | `POST {base}/decisions/:decisionId/reopen` with reason. Prior record superseded, never deleted. |
| Group membership changed | `422 stale_group` — re-fetch and show a diff of what changed before resubmitting. |
| Already reviewed | `409 already_reviewed` — surface the existing decision with a reopen action. |
| Population unreconciled | `403 population_incomplete` — offer the override form inline. |
| Pipeline incomplete | `409 pipeline_incomplete` returns the `pipeline` object — disable the relevant toggle, don't fail the panel. |

Every decision carries the `population` stamp and the file hashes from `status.source.files`.

---

## Copy rules

- Sentence case. Active voice.
- A button's word is the resulting state's word. "Record conclusion" produces "Concluded."
- Never "clear" — clearing implies dismissal, concluding implies judgment.
- Errors name what happened and what it affects. No apologies, never vague.
- Empty states are instructions: *"Create a business and ingest a population to begin."*
- Never "AI-powered," never "insights," never "smart."
- The product never says something is wrong. It says *flagged*, *unusual*, *deviates*, *emerged*. The associate concludes.

---

## Quality floor

Desktop only, 1280 minimum. Full keyboard navigation of the table. Visible focus everywhere. Reduced motion respected — in-place expansion and drawer slide are the only animation.

Density is the aesthetic. If a screen feels roomy, it is wrong.
