# JE Narrower

JE Narrower narrows a journal-entry population into a reviewable worklist. It ingests general-ledger and trial-balance exports, reconciles the population, projects account-pair activity, scores unusual entries, gathers cited evidence, groups consistent entries, and records review conclusions without destroying history.

## Project layout

- `engine/` — Fastify API, PostgreSQL migrations, ingestion, scoring, investigation, grouping, and decisions.
- `web/` — the existing React/Vite review workspace.
- `shared/` — shared population-stamp schema.
- `showcase/` — the minimal Replit presentation shell and read-only source viewer.
- `docs/` — API reference and implementation notes.

## Local development

Start PostgreSQL, migrate, then run the backend and frontend:

```bash
docker compose up -d
pnpm install
pnpm migrate
pnpm serve
pnpm web
```

The engine defaults to PostgreSQL at `postgres://je:je@localhost:5432/je_narrower`. The deployed model adapter uses `MODEL_BASE_URL`, `MODEL_API_KEY`, and `MODEL_NAME`; local Ollama remains supported.

## Production build

```bash
pnpm install --frozen-lockfile && pnpm build
pnpm start
```

The single Fastify process serves the showcase at `/`, the original application at `/demo-app/`, the API at `/api/*`, and the health check at `/health`.

Replit provisions Node.js 20 explicitly, disables its automatic hosting package install, and invokes the pinned pnpm version through npm to avoid package-manager shim recursion. It then runs `pnpm start:replit`, which migrates the database and idempotently seeds the bundled Meridian demo population before starting the server.
