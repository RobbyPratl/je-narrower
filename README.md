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

Replit provisions Node.js 20 explicitly and invokes pnpm 9.15.9 through npm for the configured build and run commands. The root manifest intentionally omits a `packageManager` field because Replit's automatic package-install phase can otherwise recursively ask pnpm to install itself. Startup runs `pnpm start:replit`, which migrates the database, starts the server so the deployment port is immediately available, and then idempotently prepares the bundled Meridian demo population in the background.
