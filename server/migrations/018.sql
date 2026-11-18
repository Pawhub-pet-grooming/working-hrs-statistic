SELECT pg_advisory_xact_lock(820013);

DO $$
BEGIN
  IF (SELECT count(*) FROM accounts WHERE role = 'MANAGER' AND status <> 'DISABLED' AND login_code IS NULL)
     > 9000 - (SELECT count(DISTINCT login_code) FROM accounts WHERE login_code ~ '^[1-9][0-9]{3}$') THEN
    RAISE EXCEPTION 'Not enough employee IDs for existing managers';
  END IF;
END $$;

WITH managers AS (
  SELECT id, row_number() OVER (ORDER BY created_at, id) AS position
  FROM accounts
  WHERE role = 'MANAGER' AND status <> 'DISABLED' AND login_code IS NULL
), available AS (
  SELECT code::text AS code, row_number() OVER (ORDER BY code) AS position
  FROM generate_series(1000, 9999) AS codes(code)
  WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.login_code = codes.code::text)
)
UPDATE accounts a SET login_code = available.code, profile_version = a.profile_version + 1
FROM managers JOIN available USING (position)
WHERE a.id = managers.id AND a.login_code IS NULL;
