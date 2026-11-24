# Cutting the API over to server-nest

Epic 6 of the NestJS migration repoints the live API process from the legacy
`server/src/index.js` to `server-nest/dist/main.js`. The two are not functionally
independent: `server-nest` mounts the legacy Express app internally for any route
not yet migrated (`server-nest/src/legacy-gateway.ts` imports `server/src/app.js`
directly), so this is a process swap, not a rewrite — every route already behaves
identically to what's running today, because for the already-migrated ones it's
literally the same Nest controller code already serving requests in every
environment that exercises `server-nest` (local dev via `npm run dev:api`, and
this repo's own `createCombinedTestServer()`-backed regression suite). What
changes is which process owns the HTTP listener, the 60s/15min maintenance
timers, and the SIGTERM shutdown path.

Verified locally before this cutover (2026-11-24): `docker compose -f
docker-compose.yml -f compose.preview.yml up db api` with the updated
`compose.preview.yml` (now `node server-nest/dist/main.js`) against this
machine's local Postgres — Docker's own healthcheck reported the container
healthy, and `GET /api/v1/health` round-tripped through Postgres correctly
from inside the container. The full `server/test/*.test.js` suite (31/31) and
`server-nest`'s own unit suite were already green against `server-nest` before
this change, via `createCombinedTestServer()`. **Not yet done, and outside what
this repo checkout alone can verify: an actual run against the real staging box
(the EC2 host behind `deploy/nginx.preview.conf`'s `15.135.80.230`) or against
real production traffic.** That needs SSH/AWS access to those hosts, which this
change was prepared without. The steps below are what to run there.

## 1. Staging first

On the staging/preview host (wherever `compose.preview.yml` + `deploy/nginx.preview.conf`
are deployed):

```bash
cd /path/to/checkout
git pull
npm ci                          # not --omit=dev: server-nest's build needs devDependencies
npm run build -w server-nest
export POSTGRES_PASSWORD=... PAWHUB_UID=$(id -u) PAWHUB_GID=$(id -g)
docker compose -f docker-compose.yml -f compose.preview.yml up -d --force-recreate api
docker compose -f docker-compose.yml -f compose.preview.yml logs -f api   # watch startup
```

Then exercise the real workflows end to end against the staging URL before
moving on: sign in (owner/manager/worker), clock in/out, a manager attendance
query, a PDF export, a photo upload. Compare against what the same actions did
on legacy immediately beforehand — the whole point of the strangler-fig
approach is that migrated routes should be indistinguishable. Watch
`docker compose ... logs -f api` for anything in the `[Nest] ... ERROR`
level, and watch Postgres for connection-count or lock anomalies if the
staging host has monitoring for that.

Leave this running at least a few hours (ideally a full day covering the site's
real usage pattern) before touching production. There's no separate traffic
mirror/shadow-replay set up for this app — "shadow test" here means staging
serving its own real low-volume traffic for a soak period, not a parallel replay
of production requests.

## 2. Production: low-traffic switch, not a mid-day flip

Pick a low-usage window (this app's real traffic is groomers/managers clocking
in/out during business hours — a late-night or early-morning window in
Pacific/Auckland time is safest). Then, on the production host:

```bash
cd /opt/pawhub
git pull
npm ci
npm run build -w server-nest
sudo cp deploy/pawhub.service /etc/systemd/system/pawhub.service
sudo systemctl daemon-reload
sudo systemctl restart pawhub
sudo systemctl status pawhub
curl -s https://<api-host>/api/v1/health
journalctl -u pawhub -f   # watch for a few minutes
```

`systemctl restart` briefly drops in-flight connections (the legacy process and
the new one can't both bind :3000 at once) — that's the real cost of this
cutover, not a schema/data change. There's no database migration in this step:
`server-nest`'s Prisma schema was pulled from the already-live schema, and this
PR doesn't add one. Rollback, if `journalctl`/health checks/real usage surface a
problem, is covered in `deploy/ROLLBACK.md` — read it before starting, not after
something breaks.

## 3. After a stable soak period

`server/src/mail.js`, `server/src/attendance-export.js`,
`server/src/photo-retention.js`, and `server/src/index.js` are now dead in
production (server-nest's `MaintenanceScheduler`, built in Epic 4, replaces
all of it) but are deliberately **not deleted by this change** — keeping them
means `deploy/ROLLBACK.md`'s revert path still works. Delete them (and update
`server/test/api.test.js`'s direct imports of `processMail`/
`processAttendanceExports`/`processPhotoRetention` to exercise the server-nest
services instead, via `createCombinedTestServer()`) only once production has
run on server-nest through at least one full day/night cycle without a
rollback, as a separate follow-up change — not part of this cutover.
