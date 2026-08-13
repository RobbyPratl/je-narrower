CREATE TYPE dataset_status AS ENUM ('loading', 'load_failed', 'reconciled', 'unreconciled');

CREATE TABLE datasets (
  dataset_id     TEXT PRIMARY KEY,
  status         dataset_status NOT NULL,
  loaded_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_files   JSONB NOT NULL DEFAULT '[]',
  reconciliation JSONB NOT NULL DEFAULT '[]'
);
