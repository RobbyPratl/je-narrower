# Replit deployment

JE Narrower deploys as one Fastify process. Fastify serves the showcase shell, the unchanged review application, the existing API, the source allowlist endpoints, and `/health` on `0.0.0.0:$PORT`.

## Commands

Replit build command:

```bash
pnpm install --frozen-lockfile && pnpm build
```

Replit run command:

```bash
pnpm start
```

`pnpm start` applies database migrations before starting the public server. For a new database, prepare the bundled Meridian demonstration population once from the Replit Shell before publishing:

```bash
pnpm migrate && pnpm seed:demo
```

The seed command is idempotent once the population is grouped. It calls the existing ingestion and pipeline services rather than duplicating accounting logic. `DEMO_INVESTIGATE_LIMIT` optionally changes the default first batch of 25 investigations.

## Replit Secrets

Add these names in the Replit Secrets tool; never put their values in `.replit` or frontend environment variables:

| Name | Purpose |
|---|---|
| `DATABASE_URL` | Persistent Replit PostgreSQL connection string |
| `MODEL_BASE_URL` | OpenAI-compatible base URL; for Groq use `https://api.groq.com/openai/v1` |
| `MODEL_API_KEY` | Groq API key |
| `MODEL_NAME` | Configurable model ID; initial choice `qwen/qwen3.6-27b` |

`MODEL_TIMEOUT_MS` is optional and defaults to 30 seconds. Setting `MODEL_BASE_URL` selects the OpenAI-compatible adapter automatically; no paid fallback is configured.

## Publishing settings

In Replit Publishing:

1. Choose **Autoscale**.
2. Select the lowest practical machine size.
3. Set maximum machines to **1**.
4. Enable deployment-level password protection for the whole application.
5. Confirm the build and run commands above, then publish.

Password protection and Autoscale capacity are deployment settings in Replit's Publishing UI; they are intentionally not application middleware. Availability of password-protected publishing depends on the Replit workspace plan.

## Routes

- `/`, `/demo`, `/source` — showcase shell with refresh-safe tab URLs.
- `/demo-app/*` — existing JE Narrower frontend and its own index fallback.
- `/api/*` — existing backend plus `/api/showcase/tree` and `/api/showcase/file`.
- `/health` — process health response.

## Source manifest policy

The build includes text source from `engine/db/migrations`, `engine/src`, `engine/test`, `web/src`, `shared/src`, `showcase/src`, and `docs`, plus selected root/workspace configuration and package files. Only recognized text extensions and files no larger than 256 KiB enter the manifest.

The generator always excludes secrets and environment files, `.git`, Replit internals, dependencies, build output, coverage, caches, virtual environments, uploads, runtime data, logs, databases, keys/certificates, symlinks, the infrastructure vendor tree, and `showcase-manifest.json` itself. At runtime, an exact manifest match and a real-path containment check are both required.
