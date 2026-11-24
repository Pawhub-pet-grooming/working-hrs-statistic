# Rolling back the server-nest cutover

This covers reverting the Epic 6 process swap (`deploy/pawhub.service` /
`compose.preview.yml` now starting `server-nest/dist/main.js` instead of legacy
`server/src/index.js`) if it causes a problem after deploying. Read this
*before* starting the cutover in `deploy/CUTOVER.md`, not after something has
already broken.

## Why this rollback is cheap

Nothing about this cutover touches the database: `server-nest`'s Prisma schema
was pulled from the already-live schema, and this change introduces no new
migration. Rolling back is purely "run the old process instead of the new
one" — there is no data to un-migrate, and no migration to reverse. The legacy
entrypoint (`server/src/index.js`) and everything it imports
(`server/src/mail.js`, `server/src/attendance-export.js`,
`server/src/photo-retention.js`) are deliberately left in place by the cutover
commits specifically so this rollback path keeps working — see
`deploy/CUTOVER.md`'s "After a stable soak period" section for when it becomes
safe to delete them (not before).

## When to roll back

- `systemctl status pawhub` / `journalctl -u pawhub` shows the new process
  failing to start, crash-looping, or repeatedly restarting.
- `GET /api/v1/health` stops returning 200, or starts timing out.
- A real user-facing regression shows up (clock in/out failing, PDF export
  broken, photo upload failing) that wasn't there on legacy immediately before
  the cutover.
- Elevated error logs (`[Nest] ... ERROR` in `journalctl -u pawhub`) that
  weren't present before the restart.

A single transient error right after restart is not automatically a rollback
trigger — give it a couple of minutes and re-check health first. A sustained
failure, or anything affecting real clock-in/out traffic, is.

## Production rollback

```bash
cd /opt/pawhub
git log --oneline -5                 # confirm the commit before the cutover
git checkout <previous-commit> -- deploy/pawhub.service
sudo cp deploy/pawhub.service /etc/systemd/system/pawhub.service
sudo systemctl daemon-reload
sudo systemctl restart pawhub
sudo systemctl status pawhub
curl -s https://<api-host>/api/v1/health
```

This restores `ExecStart=/usr/bin/node src/index.js` and
`WorkingDirectory=/opt/pawhub/server`, i.e. the exact unit file that was
running before the cutover. No `npm` install/build step is needed to roll
back — the legacy entrypoint doesn't need `server-nest`'s compiled output, and
nothing was removed from `server/`. Confirm `/api/v1/health` responds, then
spot-check the same real workflows used to verify the cutover (sign in, clock
in/out, a manager query, a PDF export).

If the regression turns out to be a `server-nest`-side bug rather than
something with the restart itself, open an issue against the specific route
and keep running on legacy until it's fixed — don't re-attempt the cutover
without the fix.

## Staging rollback

Same idea, against the preview compose stack:

```bash
cd /path/to/checkout
git checkout <previous-commit> -- compose.preview.yml
export POSTGRES_PASSWORD=... PAWHUB_UID=$(id -u) PAWHUB_GID=$(id -g)
docker compose -f docker-compose.yml -f compose.preview.yml up -d --force-recreate api
```

This restores the `node server/src/index.js` command. Since staging is where
the cutover is verified *before* touching production (`deploy/CUTOVER.md`
step 1), a staging rollback isn't an emergency in the same way a production
one is — but the exact same `git checkout <path> -- <file>` move works for
either.

## What this rollback does not cover

- Any change to `server-nest/` application code made *after* this cutover and
  deployed separately — that's a normal code rollback (revert the offending
  commit, redeploy), not this process-swap rollback.
- A problem that also reproduces on legacy (i.e., it predates the cutover) —
  rolling back won't fix it, since the same `server/src/app.js` code runs
  either way for anything not yet migrated to a Nest controller.
