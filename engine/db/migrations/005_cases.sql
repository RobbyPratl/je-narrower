CREATE TYPE verifier_status AS ENUM ('passed', 'retried', 'escalated');
CREATE TYPE review_status AS ENUM ('open', 'reviewed', 'escalated');

CREATE TABLE cases (
  entry_id        TEXT PRIMARY KEY REFERENCES entries(entry_id),
  case_file       JSONB NOT NULL,
  plan            JSONB NOT NULL,
  verifier_status verifier_status NOT NULL,
  verifier_trace  JSONB,
  model           TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  review_status   review_status NOT NULL DEFAULT 'open',
  review_note     TEXT,
  reviewed_at     TIMESTAMPTZ,
  review_population_reconciled BOOLEAN
);
