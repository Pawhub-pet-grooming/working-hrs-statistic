INSERT INTO workers(account_id,contact,address)
SELECT id,COALESCE(profile_phone,''),COALESCE(profile_address,'')
FROM accounts
WHERE role='MANAGER'
ON CONFLICT(account_id) DO NOTHING;