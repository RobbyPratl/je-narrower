CREATE TABLE pairs (
  period       period_id NOT NULL,
  account_a    TEXT NOT NULL REFERENCES accounts(account),
  account_b    TEXT NOT NULL REFERENCES accounts(account),
  count        INT NOT NULL,
  total_amount NUMERIC(14,2) NOT NULL,
  first_seen   DATE NOT NULL,
  last_seen    DATE NOT NULL,
  PRIMARY KEY (period, account_a, account_b),
  CHECK (account_a < account_b)
);

CREATE TYPE pair_status AS ENUM ('NEW', 'VANISHED', 'SHIFTED', 'STABLE');

CREATE TABLE pair_diff (
  account_a    TEXT NOT NULL,
  account_b    TEXT NOT NULL,
  status       pair_status NOT NULL,
  p1_count     INT NOT NULL,
  p2_count     INT NOT NULL,
  p1_amount    NUMERIC(14,2) NOT NULL,
  p2_amount    NUMERIC(14,2) NOT NULL,
  volume_delta NUMERIC(8,4),
  PRIMARY KEY (account_a, account_b),
  CHECK (account_a < account_b)
);

CREATE TABLE projection_skips (
  entry_id   TEXT NOT NULL,
  period     period_id NOT NULL,
  line_count INT NOT NULL,
  cap        INT NOT NULL,
  skipped_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
