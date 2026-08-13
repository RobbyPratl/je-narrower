ALTER TABLE datasets
  ADD COLUMN pipeline JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN override_reason TEXT,
  ADD COLUMN override_at TIMESTAMPTZ;

CREATE TYPE job_status AS ENUM ('running', 'done', 'failed');

CREATE TABLE jobs (
  job_id     TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  status     job_status NOT NULL,
  stage      TEXT,
  progress   JSONB NOT NULL DEFAULT '{}',
  error      TEXT,
  result     JSONB,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

CREATE TABLE review_groups (
  group_id           TEXT PRIMARY KEY,
  kind               TEXT NOT NULL,
  account_a          TEXT NOT NULL,
  account_b          TEXT NOT NULL,
  consistency_score  NUMERIC(6,4) NOT NULL,
  consistency_detail JSONB NOT NULL DEFAULT '[]',
  recurrence         JSONB NOT NULL DEFAULT '{}',
  review_status      review_status NOT NULL DEFAULT 'open',
  parent_group_id    TEXT REFERENCES review_groups(group_id)
);

CREATE TABLE group_members (
  group_id  TEXT NOT NULL REFERENCES review_groups(group_id) ON DELETE CASCADE,
  entry_id  TEXT NOT NULL REFERENCES entries(entry_id),
  is_deviation BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (group_id, entry_id)
);

CREATE TABLE decisions (
  decision_id   TEXT PRIMARY KEY,
  target_kind   TEXT NOT NULL,
  target_id     TEXT NOT NULL,
  conclusion    TEXT NOT NULL,
  basis         TEXT NOT NULL,
  entry_ids     JSONB NOT NULL,
  record        JSONB NOT NULL,
  population    JSONB NOT NULL,
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  supersedes_id TEXT REFERENCES decisions(decision_id)
);
