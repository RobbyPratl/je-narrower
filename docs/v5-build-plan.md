# Figma v5 build plan

## Verdict: rebuild, not revision

v5 inverts the hierarchy. The table becomes the application; profile band, graph and memo are optional panels, all off by default. Screens A/B/C from v1 are structurally obsolete.

### What survives

- **All 14 text styles** — unchanged. Same faces (Instrument Sans / Martian Mono), same 11/12/13/15/20/28 scale.
- **Reusable code** — tick mark vector, chip and bar patterns, the collision-avoiding label placer, the deterministic force-directed layout.

### What changes

| Token | v1 | v5 |
|---|---|---|
| `ground` | #F7F8F9 | unchanged |
| `ink` | computed values | **fact — sourced or computed, checkable** |
| `slate` | #1C2128 graph canvas | **deleted** — no dark surface exists in v5 |
| `retrieved` | #4C5FD5 "agent produced" | **renamed `inferred`**, same hex, narrower meaning: interpretation, *not checkable* |
| `mute` | — | **new** #8A9099 structure, axes, inactive marks |
| `signal` | anomaly severity | unusual **or deviating from a group** |
| `verified` | human sign-off | a human **concluded** |

The `retrieved`→`inferred` split is the substantive one. In v1 everything the agent touched was blue. In v5 source facts *and* computed facts are `ink` (both checkable — computed facts expose their formula), and only unverifiable interpretation is blue. That is a stricter, better epistemics.

Renaming and deleting variables is safe: the v1 screens were built with raw hex fills, nothing is bound.

### Structural changes

- Row model: entries → **account-pair groups**, with `kind` driving treatment (group / deviation / individual)
- New cell visuals: cadence sparkline on a **shared time axis**, consistency bar, amount range strip, preparer chip
- Column configurator + saved views + three densities (compact 28 default)
- Case file panel → **memo drawer**: flagged by / source facts / computed / interpretation / verifier / draft memo / conclusion
- Graph moves from full-bleed dark centrepiece to an optional bottom drawer on `ground`
- Copy: "Mark reviewed" → **"Record conclusion"**. Never "clear."

## Deliverables

| Screen | Contents |
|---|---|
| **W1 Default** | Status bar (reconciled, one line) + table only, compact 28px, all panels closed. The thesis screen. |
| **W2 Working** | Memo drawer open on ACC-JV-0417, graph bottom drawer open, table narrowed but present. Both differentiators visible. |
| **W3 States** | Unreconciled status bar with per-account exceptions + inline override, column configurator, `422 stale_group` diff, empty state. |

## Fixture

Straight from v5's ASCII and `api-reference.md` — these agree:

- 1,972 entries (P1 947 + P2 1025), 203 flagged, 45 reviewed / 158 open
- 12 groups, 8 deviations, 15 individuals
- `meridian-2025`, FY25 P1–P2
- ACC-JV-0417 sits in group **4010 / 2300** with 0463 and 0501 — *not* in 6210/2110 as in v1
- 6210 / 2110 is the 45-entry recurring group **plus** a separate deviation row (88.4k, 5× group median, different preparer)

Note: v5's ASCII draws row 4's cadence at Sep/Oct/Nov, but its child rows are 14 Sep / 28 Sep / 12 Oct. I follow the child dates — the cadence column exists to show the entries, so internal consistency wins over the sketch.

Amounts display from integer cents. Graph `volume`/`volumeDelta`/`totalAmount` are decimal base currency — the 100× trap called out in v5.

## Call sequence

Each call ends with one screenshot. No intermediate verification — that is what made v1 expensive.

1. **Foundations + W1** — tokens, text styles, status bar, table with all cell visuals *(script written: `v5-script-1.js`)*
2. **W2** — memo drawer + graph drawer, table narrowed
3. **W3** — states
4. **Fix pass** — reserve
5. **Fix pass** — reserve

Estimate **5 calls**, vs ~15 for v1 at the same scope.

Discipline that makes blind scripting work, learned from v1:
- Auto-layout stacking only — no manual y math (this is what broke the v1 states plate)
- Resolve nodes by name, never by stored id (ids change on rebuild/clone)
- `query()` attribute selectors silently fail on values containing spaces — use `findAll` with a predicate
- Shared scales as module constants, never per-row — v5 names per-row auto-scaling as the most common inline-viz failure

## Budget

6 calls/month on Pro + Collab; 5 spent 11 Aug. Roughly one left, and one call cannot build anything standalone.

| Path | Result |
|---|---|
| **Full seat on Pro** | 200/day. Definitive. |
| **`mcp` team probe** | That Starter team carries its own 20/month *if* quota is per-plan. Costs 2 calls to test: `create_new_file` there, then a trivial `use_figma`. Both succeed → ~18 calls, enough to build. Second fails → quota is per-user, and the spent call had no standalone use anyway. |
| **Wait for Sept** | 6/month on Collab still cannot fund a 5-call build with fixes. Only viable combined with the `mcp` team. |
