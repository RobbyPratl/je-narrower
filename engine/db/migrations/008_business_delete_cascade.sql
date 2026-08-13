-- Dataset deletion reaches both entries/groups and accounts. Make the account
-- side cascade too so PostgreSQL cannot encounter a restrict edge while
-- deleting an entire business population.
ALTER TABLE lines DROP CONSTRAINT lines_account_fkey;
ALTER TABLE lines
  ADD CONSTRAINT lines_account_fkey
    FOREIGN KEY (dataset_id, account)
    REFERENCES accounts(dataset_id, account) ON DELETE CASCADE;

ALTER TABLE review_groups DROP CONSTRAINT review_groups_account_a_fkey;
ALTER TABLE review_groups DROP CONSTRAINT review_groups_account_b_fkey;
ALTER TABLE review_groups
  ADD CONSTRAINT review_groups_account_a_fkey
    FOREIGN KEY (dataset_id, account_a)
    REFERENCES accounts(dataset_id, account) ON DELETE CASCADE,
  ADD CONSTRAINT review_groups_account_b_fkey
    FOREIGN KEY (dataset_id, account_b)
    REFERENCES accounts(dataset_id, account) ON DELETE CASCADE;
