# API Reference

HTTP API for the JE Population Testing engine. Fastify listens on `:4000` by default. The API has no authentication layer.

All routes start with `/api`. Requests and responses are JSON except for the multipart ingest option. Dates are ISO 8601 strings after serialization. Monetary values are integer cents unless an endpoint says otherwise.

## Ownership model

A business is the stable owner of one or more datasets:

- Create the business before ingesting data.
- Every population route contains `:businessId` in the URL.
- Each business has at most one current dataset.
- Analysis routes always use that current dataset; they do not accept `datasetId` as a query or body override.
- `datasetId` is globally unique.
- Source and generated identifiers—entries, lines, accounts, groups, jobs, and decisions—only need to be unique inside a dataset.
- Ingesting or rebuilding one dataset does not delete or update another dataset's rows.

The former singleton routes such as `/api/status`, `/api/entries`, and `/api/datasets/ingest` are no longer registered.

In the abbreviated routes below, `{base}` means:

```text
/api/businesses/:businessId
```

## Pipeline

```text
ingest
  └─ project       requires ingested
       └─ score    requires projected
            └─ investigate   requires scored; asynchronous
                 └─ group     requires investigated
```

Pipeline progress is stored on the current dataset and returned by `{base}/status`.

## Businesses

### `GET /api/businesses`

Returns all businesses:

```jsonc
{
  "businesses": [
    {
      "businessId": "meridian",
      "name": "Meridian Trading",
      "sourceCompany": "Meridian Trading Co.",
      "createdAt": "2026-08-12T12:00:00.000Z"
    }
  ]
}
```

### `POST /api/businesses`

Creates a business.

```jsonc
{
  "businessId": "meridian",
  "name": "Meridian Trading",
  "sourceCompany": "Meridian Trading Co."
}
```

`sourceCompany` is optional. When it is omitted, the first successful ingest claims the single company value found in the two GL files. Later ingests must match it exactly.

Returns the created business with status `201`. A duplicate `businessId` returns `409 business_exists`.

### `GET {base}/datasets`

Lists metadata for every dataset owned by the business:

```jsonc
{
  "datasets": [
    {
      "datasetId": "meridian-2025",
      "status": "reconciled",
      "loadedAt": "2026-08-12T12:05:00.000Z",
      "current": true,
      "pipeline": {
        "ingested": true,
        "projected": true,
        "scored": false,
        "investigated": false,
        "grouped": false
      }
    }
  ]
}
```

## Ingest and analysis

### `POST {base}/datasets/ingest`

Parses two GL and two trial-balance CSVs, replaces the target dataset's rows, runs reconciliation, and makes that dataset current.

JSON request; paths may be absolute or relative to the server working directory:

```jsonc
{
  "datasetId": "meridian-2025",
  "gl": {
    "p1": "/path/to/gl_p1.csv",
    "p2": "/path/to/gl_p2.csv"
  },
  "tb": {
    "p1": "/path/to/tb_p1.csv",
    "p2": "/path/to/tb_p2.csv"
  }
}
```

Multipart request fields:

| Field | Type | Required |
|---|---|---|
| `datasetId` | text | yes |
| `glP1` | file | yes |
| `glP2` | file | yes |
| `tbP1` | file | yes |
| `tbP2` | file | yes |

The GL files must contain exactly one company between them. That company must match the business's `sourceCompany`, if already assigned. A dataset ID owned by another business is rejected.

Response:

```jsonc
{
  "businessId": "meridian",
  "datasetId": "meridian-2025",
  "status": "reconciled",
  "summary": {
    "entries": { "P1": 947, "P2": 1025 },
    "lines": { "P1": 2628, "P2": 2757 },
    "accounts": 34,
    "checksPassed": 6,
    "checksFailed": 0
  },
  "reconciled": true,
  "report": [],
  "grossDeltaCents": 0,
  "exceptions": []
}
```

`status` is `reconciled` or `unreconciled`. Parse failures return `400 parse_error`; load and company-validation failures return `422 load_error`.

### `POST {base}/datasets/project`

Requires `pipeline.ingested`. Rebuilds `pairs`, `pair_diff`, and `projection_skips` for the current dataset.

```jsonc
{
  "pairs": { "P1": 842, "P2": 891 },
  "diff": { "NEW": 12, "VANISHED": 8, "SHIFTED": 15, "STABLE": 856 },
  "skipped": 0
}
```

### `POST {base}/datasets/score`

Requires `pipeline.projected`. Replaces scores for the current dataset and computes the flagged count.

```jsonc
{
  "scored": 1972,
  "flagged": 203,
  "flagThreshold": 0.35,
  "byRule": [{ "rule": "round_amount", "count": 87 }]
}
```

### `POST {base}/datasets/investigate`

Requires `pipeline.scored`. Starts asynchronous investigation of flagged entries.

```jsonc
{ "limit": 25, "force": false }
```

When `limit` is omitted, the endpoint seeds case files for the highest 25 composites. A non-negative integer selects another batch size; explicit `null` selects every flagged entry. Existing cases are skipped before the limit is applied, preserving token spend and review state. Set `force: true` to include and overwrite existing cases.

```jsonc
{ "jobId": "job-a1b2c3d4", "status": "running", "total": 203 }
```

Poll the returned job through `GET {base}/jobs/:jobId`.

### `POST {base}/datasets/group`

Requires `pipeline.investigated`. Rebuilds the review queue for the current dataset.

```jsonc
{
  "groups": 12,
  "deviations": 8,
  "individuals": 15,
  "totalFlagged": 203
}
```

### `POST {base}/datasets/run`

Runs the requested stage and every later stage in one asynchronous job.

```jsonc
{ "from": "project", "investigateLimit": null }
```

`from` is `project`, `score`, `investigate`, or `group`; it defaults to `project`. The prerequisite for the selected starting stage must already be complete. When `investigateLimit` is omitted, investigation uses the top-25 seed. Explicit `null` processes every remaining flagged entry. Existing cases are skipped.

```jsonc
{ "jobId": "job-a1b2c3d4" }
```

### `GET {base}/jobs/:jobId`

Returns a job from the current dataset:

```jsonc
{
  "jobId": "job-a1b2c3d4",
  "kind": "investigate",
  "status": "running",
  "stage": "investigate",
  "progress": { "done": 47, "total": 203, "current": "ACC-JV-0042" },
  "error": null,
  "result": null,
  "startedAt": "2026-08-12T12:10:00.000Z",
  "finishedAt": null
}
```

`status` is `running`, `done`, or `failed`. A completed investigation job has `{ passed, retried, escalated }` in `result`; a completed pipeline run has results keyed by stage.

## Status and override

### `GET {base}/status`

Returns completeness and current-population state:

```jsonc
{
  "status": "reconciled",
  "businessId": "meridian",
  "dataset": "meridian-2025",
  "loadedAt": "2026-08-12T12:05:00.000Z",
  "pipeline": {
    "ingested": true,
    "projected": true,
    "scored": true,
    "investigated": false,
    "grouped": false
  },
  "source": {
    "files": [{ "file": "gl_p1.csv", "sha256": "...", "rows": 2628 }]
  },
  "periods": [
    { "period": "P1", "entries": 947, "lines": 2628, "tied": true },
    { "period": "P2", "entries": 1025, "lines": 2757, "tied": true }
  ],
  "reconciliation": [],
  "exceptions": [],
  "grossDeltaCents": 0,
  "canConclude": true,
  "override": null
}
```

An existing business without a current dataset returns `404 no_dataset`. A current failed population returns `503 load_failed` with its reconciliation report.

### `POST {base}/override`

Allows conclusions on the current unreconciled population.

```jsonc
{ "reason": "In-transit items confirmed with client" }
```

Returns the full status response with `canConclude: true` and:

```jsonc
{
  "override": {
    "reason": "In-transit items confirmed with client",
    "at": "2026-08-12T12:20:00.000Z"
  }
}
```

## Profile, entries, and graph

### `GET {base}/profile`

Requires `pipeline.ingested`. Returns:

```jsonc
{
  "entrySizeHistogram": [{ "period": "P1", "lines": 2, "count": 500 }],
  "byMonth": [{ "month": "2025-01", "entries": 80, "lines": 210 }],
  "topAccounts": [{ "account": "1000", "name": "Cash", "totalAmount": 120000, "lineCount": 40 }],
  "flagCounts": [{ "rule": "pair_rarity", "group": "population", "count": 15 }]
}
```

### `GET {base}/entries`

Requires `pipeline.scored`.

Query parameters:

| Parameter | Meaning |
|---|---|
| `period` | Exact period, normally `P1` or `P2` |
| `account` | Entries containing this account |
| `minScore` | Minimum composite score |
| `rule` | Entries where this rule fired |
| `sort` | `date`, `amount`, or composite by default |
| `order` | `asc`; every other value defaults to descending |
| `limit` | Page size; default `50` |
| `offset` | Page offset; default `0` |

```jsonc
{
  "total": 203,
  "rows": [
    {
      "entryId": "ACC-JV-0042",
      "period": "P2",
      "effectiveDate": "2025-07-31",
      "postedAt": "2025-08-01T02:00:00.000Z",
      "user": "accountant@example.com",
      "source": "Journal Entry",
      "lineCount": 2,
      "totalAmount": 250000,
      "composite": 0.62,
      "rulesFired": ["round_amount", "off_hours"],
      "caseStatus": null,
      "reviewStatus": "open"
    }
  ]
}
```

### `GET {base}/entries/:entryId`

Returns the entry header, lines, scores, composite, and queue membership. Returns `404 not_found` when the entry is absent from the current dataset.

```jsonc
{
  "entry": {
    "entryId": "ACC-JV-0042",
    "period": "P2",
    "effectiveDate": "2025-07-31",
    "postedAt": "2025-08-01T02:00:00.000Z",
    "user": "accountant@example.com",
    "source": "Journal Entry",
    "voucherType": "Journal Entry",
    "narration": "Accrual",
    "lineCount": 2,
    "totalAmount": 250000
  },
  "lines": [
    {
      "lineId": "line-1",
      "lineNo": 1,
      "account": "1000",
      "debit": 250000,
      "credit": 0,
      "partyType": null,
      "party": null,
      "costCenter": null,
      "memo": "Accrual"
    }
  ],
  "scores": [{ "rule": "round_amount", "score": 1, "inputs": {} }],
  "composite": 0.62,
  "groupId": "grp-a1b2c3d4",
  "isDeviation": false
}
```

### `GET {base}/graph`

Requires `pipeline.projected`. `mode` is `p1`, `p2`, or `diff`; it defaults to `diff`.

Diff response:

```jsonc
{
  "mode": "diff",
  "nodes": [{ "id": "1000", "label": "Cash", "rootType": "Asset", "volume": 1200.5 }],
  "edges": [
    {
      "id": "1000↔2000",
      "source": "1000",
      "target": "2000",
      "status": "NEW",
      "p1Count": 0,
      "p2Count": 4,
      "volumeDelta": 500.25
    }
  ]
}
```

Period modes return edge fields `count`, `totalAmount`, and `rarity` instead of diff fields. Graph `volume`, `volumeDelta`, and `totalAmount` are decimal base-currency units, not cents.

## Cases and citations

### `GET {base}/cases/:entryId`

Returns the stored case file or `404 not_found`. A case file contains:

- `entryId`, `generatedAt`, and `model`
- an immutable `population` stamp
- deterministic `engine` scores and inputs
- the agent plan and cited findings
- optional `computed` facts
- verifier status and failures
- mutable review state

Entries flagged by exactly one of `round_amount`, `off_hours`, or `date_mismatch` use verifier-clean deterministic findings and record `model: "template:deterministic"`; they do not call the configured LLM.

### `POST {base}/cases/:entryId/reinvestigate`

Requires `pipeline.scored`. Re-runs one entry synchronously.

```jsonc
{ "force": true }
```

When a case already exists and `force` is not true, the endpoint returns `409 conflict`. A client can call this endpoint with `{}` when a reviewer first opens an entry outside the initial batch, providing lazy investigation without processing the full flagged population.

### `GET {base}/citations/:kind/:ref`

Resolves a citation from the current dataset. `kind` is `line` or `entry`; unsupported kinds and missing references return `404 not_found`.

Line citation:

```jsonc
{
  "kind": "line",
  "ref": "line-1",
  "line": {
    "lineId": "line-1",
    "entryId": "ACC-JV-0042",
    "lineNo": 1,
    "account": "1000",
    "debit": 250000,
    "credit": 0,
    "memo": "Accrual"
  },
  "entry": {
    "entryId": "ACC-JV-0042",
    "period": "P2",
    "effectiveDate": "2025-07-31",
    "narration": "Accrual",
    "user": "accountant@example.com"
  }
}
```

Entry citations return an `entry` header plus `lines`.

## Review queue and decisions

### `GET {base}/queue`

Requires `pipeline.grouped`.

Query parameters:

- `reviewStatus=open|reviewed|all`
- `kind=group|deviation|individual`

```jsonc
{
  "summary": {
    "totalFlagged": 203,
    "reviewed": 45,
    "open": 158,
    "groups": 12,
    "deviations": 8,
    "individuals": 15
  },
  "items": [
    {
      "groupId": "grp-a1b2c3d4",
      "kind": "group",
      "pair": "1000↔2000",
      "accountA": "1000",
      "accountB": "2000",
      "entryCount": 4,
      "entryIds": ["ACC-JV-0042"],
      "rulesFired": ["round_amount"],
      "consistency": { "score": 0.9, "detail": [] },
      "recurrence": { "months": [], "marks": [], "byMonth": {}, "label": "..." },
      "reviewStatus": "open",
      "parentGroupId": null,
      "decision": {
        "decisionId": "dec-a1b2c3d4",
        "conclusion": "appropriate-recurring",
        "basis": "Monthly accrual pattern confirmed",
        "recordedBy": "Auditor Two",
        "recordedAt": "2026-08-12T13:00:00.000Z"
      },
      "supersededDecisions": [
        {
          "decisionId": "dec-0000aaaa",
          "conclusion": "appropriate-other",
          "basis": "Earlier rationale",
          "recordedBy": "Auditor Two",
          "recordedAt": "2026-08-12T11:20:00.000Z",
          "supersededAt": "2026-08-12T13:00:00.000Z",
          "reason": "membership changed: removed ACC-JV-0388"
        }
      ]
    }
  ]
}
```

`decision` is the item's active conclusion, or `null` when it has none or its last record was a reopen. `supersededDecisions` lists prior conclusions for the same target, newest first, each with the `reason` recorded when it was replaced. A superseded conclusion is never deleted, so this is how the history is read back; without it the record exists but nothing can reach it. Both fields appear on `GET {base}/queue` items and on `GET {base}/queue/:groupId`.

### `GET {base}/queue/:groupId`

Requires `pipeline.grouped`. Returns the group review sheet with `groupingBasis`, `consistency`, rolled-up `procedures`, `excludedDeviations`, `reviewStatus`, `canConclude`, and the active `decision` when one exists. Returns `404 not_found` when absent.

### `PATCH {base}/queue/:groupId/members`

Adds or removes entries and recomputes consistency and recurrence using the existing grouping algorithms.

```jsonc
{
  "add": ["ACC-JV-0044"],
  "remove": ["ACC-JV-0042"]
}
```

At least one non-empty array is required. Removed entries become individual queue items. Added entries must be flagged, must use the group's account pair, and may come from an individual or deviation item but not directly from another group. The change is atomic: membership, consistency, recurrence, and decision history either all update or none do.

Every affected active conclusion is superseded and its item is reopened. The response keeps `superseded` as the prior target-group decision (or `null`) and includes all affected IDs in `supersededDecisions`:

```jsonc
{
  "group": { "groupId": "grp-a1b2c3d4", "reviewStatus": "open", "decision": null },
  "superseded": "dec-a1b2c3d4",
  "supersededDecisions": ["dec-a1b2c3d4", "dec-e5f6g7h8"]
}
```

### `POST {base}/decisions/group/:groupId`

Records a conclusion for a multi-entry group.

```jsonc
{
  "conclusion": "appropriate-recurring",
  "basis": "Monthly accrual pattern confirmed",
  "recordedBy": "Auditor Two",
  "entryIds": ["ACC-JV-0042", "ACC-JV-0043"],
  "excludedDeviations": []
}
```

Allowed conclusions:

- `appropriate-recurring`
- `appropriate-adjustment`
- `appropriate-other`
- `requires-procedures`
- `set-aside`

`entryIds` must exactly match current group membership. `recordedBy` is an optional client-supplied display identity; it is stored in the immutable decision record and returned with the active queue decision. It is not an authenticated identity until the application has authentication. The response contains `decisionId`, `recordedAt`, the `population` stamp, and `entriesAffected`. Recording another conclusion supersedes the prior decision rather than deleting history.

### `POST {base}/decisions/entry/:entryId`

Records a conclusion for an individual entry or deviation.

```jsonc
{
  "conclusion": "appropriate-other",
  "basis": "Reviewed supporting detail",
  "recordedBy": "Auditor Two"
}
```

### `POST {base}/decisions/:decisionId/reopen`

Creates a new `reopened` decision that supersedes the prior record; it does not delete history.

```jsonc
{ "reason": "Additional evidence received" }
```

### `GET {base}/decisions/:decisionId`

Returns a decision from the current dataset or `404 not_found`.

Conclusions require a reconciled population or an override. Common decision errors are:

- `403 population_incomplete`
- `409 invalid_target`
- `422 stale_group`

## Showcase deployment endpoints

`GET /health` returns `{ "status": "ok" }` without querying PostgreSQL.

`GET /api/showcase/tree` returns the build-time approved source manifest under the virtual root `je-narrower`. `GET /api/showcase/file?path=<exact-manifest-path>` returns UTF-8 content only for an exact manifest entry. These routes never perform directory traversal or accept arbitrary filesystem paths; deployment access is controlled by Replit's password gate rather than application authentication.

## Errors

Domain and request errors use:

```jsonc
{
  "error": "pipeline_incomplete",
  "message": "requires scored — run prior pipeline stages first",
  "details": {
    "businessId": "meridian",
    "datasetId": "meridian-2025",
    "pipeline": {}
  }
}
```

`details` is omitted when there are no details.

| Status | Common codes |
|---|---|
| `400` | `invalid_request`, `parse_error` |
| `403` | `population_incomplete` |
| `404` | `business_not_found`, `no_dataset`, `no_current_dataset`, `not_found` |
| `409` | `business_exists`, `pipeline_incomplete`, `conflict`, `invalid_target` |
| `422` | `load_error`, `stale_group` |
| `503` | `load_failed` |

CSV parse error:

```jsonc
{
  "error": "parse_error",
  "violations": [
    { "file": "gl_p1.csv", "row": 2, "column": "account", "message": "Required" }
  ]
}
```

Load error:

```jsonc
{ "error": "load_error", "message": "GL files contain multiple companies: A, B" }
```

## Route index

| Method | Route | Execution |
|---|---|---|
| `GET` | `/health` | synchronous |
| `GET` | `/api/showcase/tree` | synchronous, build-time allowlist only |
| `GET` | `/api/showcase/file?path=...` | synchronous, exact allowlist match only |
| `GET` | `/api/businesses` | synchronous |
| `POST` | `/api/businesses` | synchronous |
| `GET` | `{base}/datasets` | synchronous |
| `POST` | `{base}/datasets/ingest` | synchronous |
| `POST` | `{base}/datasets/project` | synchronous |
| `POST` | `{base}/datasets/score` | synchronous |
| `POST` | `{base}/datasets/investigate` | asynchronous |
| `POST` | `{base}/datasets/group` | synchronous |
| `POST` | `{base}/datasets/run` | asynchronous |
| `GET` | `{base}/jobs/:jobId` | synchronous |
| `GET` | `{base}/status` | synchronous |
| `POST` | `{base}/override` | synchronous |
| `GET` | `{base}/profile` | synchronous |
| `GET` | `{base}/entries` | synchronous |
| `GET` | `{base}/entries/:entryId` | synchronous |
| `GET` | `{base}/graph` | synchronous |
| `GET` | `{base}/cases/:entryId` | synchronous |
| `POST` | `{base}/cases/:entryId/reinvestigate` | synchronous |
| `GET` | `{base}/citations/:kind/:ref` | synchronous |
| `GET` | `{base}/queue` | synchronous |
| `GET` | `{base}/queue/:groupId` | synchronous |
| `PATCH` | `{base}/queue/:groupId/members` | synchronous |
| `POST` | `{base}/decisions/group/:groupId` | synchronous |
| `POST` | `{base}/decisions/entry/:entryId` | synchronous |
| `POST` | `{base}/decisions/:decisionId/reopen` | synchronous |
| `GET` | `{base}/decisions/:decisionId` | synchronous |

## Example flow

```bash
# Create a business.
curl -X POST http://localhost:4000/api/businesses \
  -H 'content-type: application/json' \
  -d '{"businessId":"meridian","name":"Meridian Trading"}'

# Ingest a population using server-visible file paths.
curl -X POST http://localhost:4000/api/businesses/meridian/datasets/ingest \
  -H 'content-type: application/json' \
  -d '{
    "datasetId":"meridian-2025",
    "gl":{"p1":"/data/gl_p1.csv","p2":"/data/gl_p2.csv"},
    "tb":{"p1":"/data/tb_p1.csv","p2":"/data/tb_p2.csv"}
  }'

# Run the remaining pipeline and poll the returned job ID.
curl -X POST http://localhost:4000/api/businesses/meridian/datasets/run \
  -H 'content-type: application/json' \
  -d '{"from":"project"}'
```

## Agent configuration

Investigation uses a pluggable provider configured through environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `AGENT_PROVIDER` | inferred | `openai-compatible` when `MODEL_BASE_URL` is set; otherwise `ollama` |
| `MODEL_BASE_URL` | unset | OpenAI-compatible endpoint base URL |
| `MODEL_API_KEY` | unset | Server-side external model API key |
| `MODEL_NAME` | falls back to `AGENT_MODEL` | External model identifier |
| `MODEL_TIMEOUT_MS` | `30000` | External model timeout |
| `AGENT_MODEL` | `llama3.2` | Legacy/local model identifier fallback |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama API base URL |
| `ANTHROPIC_API_KEY` | unset | Reserved for the Anthropic adapter |

For Groq, configure `MODEL_BASE_URL=https://api.groq.com/openai/v1` and a Groq-supported `MODEL_NAME`. The adapter uses Chat Completions JSON Object Mode and contains timeouts, `429` responses, other provider failures, and invalid structured output inside the existing escalated-case behavior. It does not fall back to another provider. `mock` provides deterministic offline behavior for tests. The Anthropic provider remains reserved but not implemented.

### Token controls

Investigation tools retain exact aggregates while limiting raw citeable samples to 15 rows. Large entry lines, pair histories, and user histories therefore do not dump their full corpora into prompts. Account context uses explicit fields and does not expose unciteable sample references. The prompt allows at most six target-entry findings, includes a valid citation example, and supplies a small exact citation allowlist restricted to the target entry and its lines.

Together with deterministic single-rule findings, skip-existing batches, and the default top-25 seed, model usage scales primarily with novel entries that reviewers actually investigate.

Run the opt-in live quality and latency smoke test against Ollama with:

```bash
LIVE_SMOKE=1 AGENT_PROVIDER=ollama AGENT_MODEL=llama3.2 pnpm --filter @je-narrower/engine exec vitest run test/live-smoke.test.ts
```

The smoke test uses the real exports, selects three non-template entries, and prints latency, verifier status, and findings. It is skipped during normal test runs.
