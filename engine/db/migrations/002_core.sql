CREATE TYPE period_id AS ENUM ('P1', 'P2');

CREATE TABLE accounts (
  account        TEXT PRIMARY KEY,
  account_number TEXT,
  name           TEXT NOT NULL,
  root_type      TEXT NOT NULL CHECK (root_type IN
                   ('Asset','Liability','Equity','Income','Expense')),
  account_type   TEXT,
  normal_balance TEXT NOT NULL CHECK (normal_balance IN ('debit','credit'))
);

CREATE TABLE entries (
  entry_id       TEXT PRIMARY KEY,
  period         period_id NOT NULL,
  posted_at      TIMESTAMPTZ NOT NULL,
  effective_date DATE NOT NULL,
  "user"         TEXT NOT NULL,
  source         TEXT NOT NULL,
  voucher_type   TEXT NOT NULL,
  narration      TEXT,
  line_count     INT NOT NULL,
  total_amount   NUMERIC(14,2) NOT NULL
);
CREATE INDEX entries_period_idx ON entries (period);
CREATE INDEX entries_user_idx   ON entries ("user", period);

CREATE TABLE lines (
  line_id     TEXT PRIMARY KEY,
  entry_id    TEXT NOT NULL REFERENCES entries(entry_id),
  line_no     INT NOT NULL,
  account     TEXT NOT NULL REFERENCES accounts(account),
  debit       NUMERIC(14,2) NOT NULL DEFAULT 0,
  credit      NUMERIC(14,2) NOT NULL DEFAULT 0,
  party_type  TEXT,
  party       TEXT,
  cost_center TEXT,
  memo        TEXT,
  CHECK (debit >= 0 AND credit >= 0),
  CHECK (NOT (debit > 0 AND credit > 0))
);
CREATE INDEX lines_entry_idx   ON lines (entry_id);
CREATE INDEX lines_account_idx ON lines (account);

CREATE TABLE trial_balance (
  period         period_id NOT NULL,
  account        TEXT NOT NULL,
  opening_debit  NUMERIC(14,2) NOT NULL,
  opening_credit NUMERIC(14,2) NOT NULL,
  period_debit   NUMERIC(14,2) NOT NULL,
  period_credit  NUMERIC(14,2) NOT NULL,
  closing_debit  NUMERIC(14,2) NOT NULL,
  closing_credit NUMERIC(14,2) NOT NULL,
  PRIMARY KEY (period, account)
);
