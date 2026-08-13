CREATE TABLE businesses (
  business_id    TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  source_company TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Existing installations represented one implicit business. Preserve that
-- population under a stable owner; fresh installations start with no business.
INSERT INTO businesses (business_id, name)
SELECT 'default', 'Default Business'
WHERE EXISTS (SELECT 1 FROM datasets);

ALTER TABLE datasets
  ADD COLUMN business_id TEXT,
  ADD COLUMN is_current BOOLEAN NOT NULL DEFAULT false;

UPDATE datasets SET business_id = 'default' WHERE business_id IS NULL;

WITH latest AS (
  SELECT dataset_id
  FROM datasets
  ORDER BY loaded_at DESC, dataset_id DESC
  LIMIT 1
)
UPDATE datasets d
SET is_current = EXISTS (SELECT 1 FROM latest l WHERE l.dataset_id = d.dataset_id);

ALTER TABLE datasets
  ALTER COLUMN business_id SET NOT NULL,
  ADD CONSTRAINT datasets_business_id_fkey
    FOREIGN KEY (business_id) REFERENCES businesses(business_id) ON DELETE CASCADE;

CREATE UNIQUE INDEX datasets_one_current_per_business_idx
  ON datasets (business_id)
  WHERE is_current;
CREATE INDEX datasets_business_loaded_idx
  ON datasets (business_id, loaded_at DESC);

ALTER TABLE accounts          ADD COLUMN dataset_id TEXT;
ALTER TABLE entries           ADD COLUMN dataset_id TEXT;
ALTER TABLE lines             ADD COLUMN dataset_id TEXT;
ALTER TABLE trial_balance     ADD COLUMN dataset_id TEXT;
ALTER TABLE pairs             ADD COLUMN dataset_id TEXT;
ALTER TABLE pair_diff         ADD COLUMN dataset_id TEXT;
ALTER TABLE projection_skips  ADD COLUMN dataset_id TEXT;
ALTER TABLE scores            ADD COLUMN dataset_id TEXT;
ALTER TABLE cases             ADD COLUMN dataset_id TEXT;
ALTER TABLE jobs              ADD COLUMN dataset_id TEXT;
ALTER TABLE review_groups     ADD COLUMN dataset_id TEXT;
ALTER TABLE group_members     ADD COLUMN dataset_id TEXT;
ALTER TABLE decisions         ADD COLUMN dataset_id TEXT;

-- The legacy schema held one global population. Assign all of its rows to the
-- current dataset selected above before making ownership mandatory.
UPDATE accounts         SET dataset_id = (SELECT dataset_id FROM datasets WHERE is_current) WHERE dataset_id IS NULL;
UPDATE entries          SET dataset_id = (SELECT dataset_id FROM datasets WHERE is_current) WHERE dataset_id IS NULL;
UPDATE lines            SET dataset_id = (SELECT dataset_id FROM datasets WHERE is_current) WHERE dataset_id IS NULL;
UPDATE trial_balance    SET dataset_id = (SELECT dataset_id FROM datasets WHERE is_current) WHERE dataset_id IS NULL;
UPDATE pairs            SET dataset_id = (SELECT dataset_id FROM datasets WHERE is_current) WHERE dataset_id IS NULL;
UPDATE pair_diff        SET dataset_id = (SELECT dataset_id FROM datasets WHERE is_current) WHERE dataset_id IS NULL;
UPDATE projection_skips SET dataset_id = (SELECT dataset_id FROM datasets WHERE is_current) WHERE dataset_id IS NULL;
UPDATE scores           SET dataset_id = (SELECT dataset_id FROM datasets WHERE is_current) WHERE dataset_id IS NULL;
UPDATE cases            SET dataset_id = (SELECT dataset_id FROM datasets WHERE is_current) WHERE dataset_id IS NULL;
UPDATE jobs             SET dataset_id = (SELECT dataset_id FROM datasets WHERE is_current) WHERE dataset_id IS NULL;
UPDATE review_groups    SET dataset_id = (SELECT dataset_id FROM datasets WHERE is_current) WHERE dataset_id IS NULL;
UPDATE group_members    SET dataset_id = (SELECT dataset_id FROM datasets WHERE is_current) WHERE dataset_id IS NULL;
UPDATE decisions        SET dataset_id = (SELECT dataset_id FROM datasets WHERE is_current) WHERE dataset_id IS NULL;

DO $$
DECLARE
  table_name TEXT;
  missing BIGINT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'accounts', 'entries', 'lines', 'trial_balance', 'pairs', 'pair_diff',
    'projection_skips', 'scores', 'cases', 'jobs', 'review_groups',
    'group_members', 'decisions'
  ]
  LOOP
    EXECUTE format('SELECT count(*) FROM %I WHERE dataset_id IS NULL', table_name) INTO missing;
    IF missing > 0 THEN
      RAISE EXCEPTION
        'cannot migrate %.dataset_id: % legacy rows exist without a dataset',
        table_name, missing;
    END IF;
  END LOOP;
END $$;

ALTER TABLE accounts         ALTER COLUMN dataset_id SET NOT NULL;
ALTER TABLE entries          ALTER COLUMN dataset_id SET NOT NULL;
ALTER TABLE lines            ALTER COLUMN dataset_id SET NOT NULL;
ALTER TABLE trial_balance    ALTER COLUMN dataset_id SET NOT NULL;
ALTER TABLE pairs            ALTER COLUMN dataset_id SET NOT NULL;
ALTER TABLE pair_diff        ALTER COLUMN dataset_id SET NOT NULL;
ALTER TABLE projection_skips ALTER COLUMN dataset_id SET NOT NULL;
ALTER TABLE scores           ALTER COLUMN dataset_id SET NOT NULL;
ALTER TABLE cases            ALTER COLUMN dataset_id SET NOT NULL;
ALTER TABLE jobs             ALTER COLUMN dataset_id SET NOT NULL;
ALTER TABLE review_groups    ALTER COLUMN dataset_id SET NOT NULL;
ALTER TABLE group_members    ALTER COLUMN dataset_id SET NOT NULL;
ALTER TABLE decisions        ALTER COLUMN dataset_id SET NOT NULL;

-- Remove single-population relationships before replacing their referenced
-- primary keys. All replacements carry dataset_id on both sides.
ALTER TABLE lines         DROP CONSTRAINT lines_entry_id_fkey;
ALTER TABLE lines         DROP CONSTRAINT lines_account_fkey;
ALTER TABLE pairs         DROP CONSTRAINT pairs_account_a_fkey;
ALTER TABLE pairs         DROP CONSTRAINT pairs_account_b_fkey;
ALTER TABLE scores        DROP CONSTRAINT scores_entry_id_fkey;
ALTER TABLE cases         DROP CONSTRAINT cases_entry_id_fkey;
ALTER TABLE review_groups DROP CONSTRAINT review_groups_parent_group_id_fkey;
ALTER TABLE group_members DROP CONSTRAINT group_members_group_id_fkey;
ALTER TABLE group_members DROP CONSTRAINT group_members_entry_id_fkey;
ALTER TABLE decisions     DROP CONSTRAINT decisions_supersedes_id_fkey;

ALTER TABLE accounts      DROP CONSTRAINT accounts_pkey;
ALTER TABLE entries       DROP CONSTRAINT entries_pkey;
ALTER TABLE lines         DROP CONSTRAINT lines_pkey;
ALTER TABLE trial_balance DROP CONSTRAINT trial_balance_pkey;
ALTER TABLE pairs         DROP CONSTRAINT pairs_pkey;
ALTER TABLE pair_diff     DROP CONSTRAINT pair_diff_pkey;
ALTER TABLE scores        DROP CONSTRAINT scores_pkey;
ALTER TABLE cases         DROP CONSTRAINT cases_pkey;
ALTER TABLE jobs          DROP CONSTRAINT jobs_pkey;
ALTER TABLE review_groups DROP CONSTRAINT review_groups_pkey;
ALTER TABLE group_members DROP CONSTRAINT group_members_pkey;
ALTER TABLE decisions     DROP CONSTRAINT decisions_pkey;

ALTER TABLE accounts
  ADD CONSTRAINT accounts_pkey PRIMARY KEY (dataset_id, account),
  ADD CONSTRAINT accounts_dataset_id_fkey
    FOREIGN KEY (dataset_id) REFERENCES datasets(dataset_id) ON DELETE CASCADE;

ALTER TABLE entries
  ADD CONSTRAINT entries_pkey PRIMARY KEY (dataset_id, entry_id),
  ADD CONSTRAINT entries_dataset_id_fkey
    FOREIGN KEY (dataset_id) REFERENCES datasets(dataset_id) ON DELETE CASCADE;

ALTER TABLE lines
  ADD CONSTRAINT lines_pkey PRIMARY KEY (dataset_id, line_id),
  ADD CONSTRAINT lines_entry_fkey
    FOREIGN KEY (dataset_id, entry_id)
    REFERENCES entries(dataset_id, entry_id) ON DELETE CASCADE,
  ADD CONSTRAINT lines_account_fkey
    FOREIGN KEY (dataset_id, account)
    REFERENCES accounts(dataset_id, account);

ALTER TABLE trial_balance
  ADD CONSTRAINT trial_balance_pkey PRIMARY KEY (dataset_id, period, account),
  ADD CONSTRAINT trial_balance_account_fkey
    FOREIGN KEY (dataset_id, account)
    REFERENCES accounts(dataset_id, account) ON DELETE CASCADE;

ALTER TABLE pairs
  ADD CONSTRAINT pairs_pkey PRIMARY KEY (dataset_id, period, account_a, account_b),
  ADD CONSTRAINT pairs_account_a_fkey
    FOREIGN KEY (dataset_id, account_a)
    REFERENCES accounts(dataset_id, account) ON DELETE CASCADE,
  ADD CONSTRAINT pairs_account_b_fkey
    FOREIGN KEY (dataset_id, account_b)
    REFERENCES accounts(dataset_id, account) ON DELETE CASCADE;

ALTER TABLE pair_diff
  ADD CONSTRAINT pair_diff_pkey PRIMARY KEY (dataset_id, account_a, account_b),
  ADD CONSTRAINT pair_diff_account_a_fkey
    FOREIGN KEY (dataset_id, account_a)
    REFERENCES accounts(dataset_id, account) ON DELETE CASCADE,
  ADD CONSTRAINT pair_diff_account_b_fkey
    FOREIGN KEY (dataset_id, account_b)
    REFERENCES accounts(dataset_id, account) ON DELETE CASCADE;

ALTER TABLE projection_skips
  ADD CONSTRAINT projection_skips_pkey PRIMARY KEY (dataset_id, entry_id),
  ADD CONSTRAINT projection_skips_entry_fkey
    FOREIGN KEY (dataset_id, entry_id)
    REFERENCES entries(dataset_id, entry_id) ON DELETE CASCADE;

ALTER TABLE scores
  ADD CONSTRAINT scores_pkey PRIMARY KEY (dataset_id, entry_id, rule),
  ADD CONSTRAINT scores_entry_fkey
    FOREIGN KEY (dataset_id, entry_id)
    REFERENCES entries(dataset_id, entry_id) ON DELETE CASCADE;

ALTER TABLE cases
  ADD CONSTRAINT cases_pkey PRIMARY KEY (dataset_id, entry_id),
  ADD CONSTRAINT cases_entry_fkey
    FOREIGN KEY (dataset_id, entry_id)
    REFERENCES entries(dataset_id, entry_id) ON DELETE CASCADE;

ALTER TABLE jobs
  ADD CONSTRAINT jobs_pkey PRIMARY KEY (dataset_id, job_id),
  ADD CONSTRAINT jobs_dataset_id_fkey
    FOREIGN KEY (dataset_id) REFERENCES datasets(dataset_id) ON DELETE CASCADE;

ALTER TABLE review_groups
  ADD CONSTRAINT review_groups_pkey PRIMARY KEY (dataset_id, group_id),
  ADD CONSTRAINT review_groups_account_a_fkey
    FOREIGN KEY (dataset_id, account_a)
    REFERENCES accounts(dataset_id, account),
  ADD CONSTRAINT review_groups_account_b_fkey
    FOREIGN KEY (dataset_id, account_b)
    REFERENCES accounts(dataset_id, account),
  ADD CONSTRAINT review_groups_parent_fkey
    FOREIGN KEY (dataset_id, parent_group_id)
    REFERENCES review_groups(dataset_id, group_id) ON DELETE CASCADE;

ALTER TABLE group_members
  ADD CONSTRAINT group_members_pkey PRIMARY KEY (dataset_id, group_id, entry_id),
  ADD CONSTRAINT group_members_group_fkey
    FOREIGN KEY (dataset_id, group_id)
    REFERENCES review_groups(dataset_id, group_id) ON DELETE CASCADE,
  ADD CONSTRAINT group_members_entry_fkey
    FOREIGN KEY (dataset_id, entry_id)
    REFERENCES entries(dataset_id, entry_id) ON DELETE CASCADE;

ALTER TABLE decisions
  ADD CONSTRAINT decisions_pkey PRIMARY KEY (dataset_id, decision_id),
  ADD CONSTRAINT decisions_dataset_id_fkey
    FOREIGN KEY (dataset_id) REFERENCES datasets(dataset_id) ON DELETE CASCADE,
  ADD CONSTRAINT decisions_supersedes_fkey
    FOREIGN KEY (dataset_id, supersedes_id)
    REFERENCES decisions(dataset_id, decision_id);

DROP INDEX entries_period_idx;
DROP INDEX entries_user_idx;
DROP INDEX lines_entry_idx;
DROP INDEX lines_account_idx;
DROP INDEX scores_rule_idx;

CREATE INDEX entries_period_idx ON entries (dataset_id, period);
CREATE INDEX entries_user_idx   ON entries (dataset_id, "user", period);
CREATE INDEX lines_entry_idx    ON lines (dataset_id, entry_id);
CREATE INDEX lines_account_idx  ON lines (dataset_id, account);
CREATE INDEX scores_rule_idx    ON scores (dataset_id, rule, score DESC);
CREATE INDEX decisions_target_idx
  ON decisions (dataset_id, target_kind, target_id, recorded_at DESC);
