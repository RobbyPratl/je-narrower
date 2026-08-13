CREATE TABLE scores (
  entry_id TEXT NOT NULL REFERENCES entries(entry_id),
  rule     TEXT NOT NULL,
  score    NUMERIC(6,4) NOT NULL,
  inputs   JSONB NOT NULL,
  PRIMARY KEY (entry_id, rule)
);
CREATE INDEX scores_rule_idx ON scores (rule, score DESC);
