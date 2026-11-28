import express from "express";
import cors from "cors";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { createHash } from "node:crypto";
import { z } from "zod";
import { pool } from "./db.js";
import { localDate } from "./domain.js";
export const app = express();
app.disable("x-powered-by");
if (process.env.TRUST_PROXY === "1") app.set("trust proxy", 1);
app.use(helmet());
app.use(cors({ origin: process.env.WEB_ORIGIN || "http://localhost:5173" }));
app.use(express.json({ limit: "256kb" }));
export const apiLimiter = rateLimit({ windowMs: 60000, limit: 300 });
app.use(apiLimiter);
const hash = (x) => createHash("sha256").update(x).digest("hex");
const fail = (status, message, code = "REQUEST_FAILED") => {
  throw Object.assign(new Error(message), { status, code });
};
const backend = ["MANAGER", "GENERAL_MANAGER", "SUPER_MANAGER"];
app.get("/api/v1/health", async (req, res) => {
  await pool.query("SELECT 1");
  res.json({ data: { status: "ok" } });
});
// auth/login, auth/register, auth/password-links(/consume) migrated to server-nest's
// AuthController (Epic 2) — see server-nest/src/auth/auth.service.ts. They used to be
// defined here, before this middleware, so a request never reached the auth check below;
// now that they live in server-nest, this middleware must explicitly let them fall through
// to it instead of rejecting them as unauthenticated.
// downloads/android(/apk) migrated to server-nest's AndroidDownloadController (Epic 3) — they
// used to be mounted here, also before this middleware, for the same reason: these routes are
// fully public (no sign-in required) and must keep falling through instead of getting 401'd.
const publicAuthPaths = new Set([
  "/auth/login",
  "/manager/auth/login",
  "/auth/register",
  "/auth/password-links",
  "/auth/password-links/consume",
  "/downloads/android",
  "/downloads/android/apk",
]);
app.use("/api/v1", async (req, res, next) => {
  if (publicAuthPaths.has(req.path)) return next();
  try {
    const t = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if (!t) fail(401, "Please sign in");
    const r = await pool.query(
      "SELECT a.* FROM sessions s JOIN accounts a ON a.id=s.account_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND (a.status='ACTIVE' OR (a.role='WORKER' AND a.status='PENDING' AND a.requires_manager_approval AND a.password_hash IS NOT NULL))",
      [hash(t)],
    );
    if (!r.rowCount) fail(401, "Session expired");
    req.account = r.rows[0];
    req.sessionHash = hash(t);
    // Sliding expiration: an active session never expires while the device keeps checking in;
    // only a device that goes unused for SESSION_HOURS is forced back to the password screen.
    await pool.query(
      "UPDATE sessions SET expires_at=now()+($2 || ' hours')::interval WHERE token_hash=$1",
      [req.sessionHash, Number(process.env.SESSION_HOURS) || 168],
    );
    next();
  } catch (e) {
    next(e);
  }
});
// All three path prefixes are now fully handled by server-nest (AttendanceController,
// AttendanceAdjustmentsController, PhotosController) — none has a route left in this file. This
// middleware still runs on every matching request anyway: the legacy Express app is mounted as
// middleware ahead of Nest's router (see legacy-gateway.ts), so its own middleware chain —
// this gate, the session-auth check above, the /manager role gate below — always executes
// first, regardless of which app ultimately owns the route. Never delete this as "dead" just
// because its route handlers moved; it is the only thing still enforcing this check.
app.use(["/api/v1/attendance", "/api/v1/attendance-adjustments", "/api/v1/photos"], (req, res, next) => {
  if (req.method === "POST" && req.account.role === "WORKER" && req.account.status !== "ACTIVE")
    return next(Object.assign(new Error("Manager approval is required before recording attendance"),
      { status: 403, code: "MANAGER_APPROVAL_REQUIRED" }));
  next();
});
// auth/logout, me/password migrated to server-nest's AuthController (Epic 2).
async function accountInfo(account, c = pool) {
  const preferred = account.preferred_shop_id ? (await c.query(
    "SELECT sa.login_code FROM shops s JOIN accounts sa ON sa.id=s.account_id WHERE s.id=$1",
    [account.preferred_shop_id],
  )).rows[0]?.login_code : null;
  return { id: account.id, accountId: account.login_code || null, role: account.role, name: account.name, attendanceEnabled: account.status === "ACTIVE", preferredShopId: preferred || null };
}
// me, me/preferences, me/stores, me/profile(GET/POST) migrated to server-nest's MeController
// (Epic 3). accountInfo/profileInfo stay here — still used by /manager/accounts/:id/profile below.
async function profileInfo(account, c = pool) {
  return { ...await accountInfo(account, c), email: account.email || "", firstName: account.first_name || account.name,
    lastName: account.last_name || "", address: account.profile_address, phone: account.profile_phone,
    version: account.profile_version };
}
function manager(req, res, next) {
  // /manager/auth/login is public (migrated to server-nest) and never reaches here with
  // req.account set — this prefix-mounted gate would otherwise match it too.
  if (req.path === "/auth/login") return next();
  if (!backend.includes(req.account.role))
    return next(
      Object.assign(new Error("Manager access required"), { status: 403 }),
    );
  next();
}
app.use("/api/v1/manager", manager);
// downloads/store-android(/link) migrated to server-nest's StoreDownloadController (Epic 3).
// shops listing (/shops, /manager/shops), shop creation (POST /manager/shops) and shop profile
// edit (POST /manager/shops/:id/profile, in organization.js) migrated to server-nest's
// ShopsController/ManagerShopsController (Epic 3).
// GET /manager/attendance/stores and /groomers migrated to server-nest's
// ManagerAttendanceController (Epic 3).
// workers/managers directory, account creation, managed-account profile/remove/approve/
// invitations, invitations listing, and org-wide permissions/general-manager/role routes
// (organization.js) migrated to server-nest's ManagerAccountsController/OrganizationController
// (Epic 3). assertWorker/assertRecordScope stay — attendance/photos routes below still use them.
export async function rebuild(c, workerId) {
  await c.query("SELECT id FROM workers WHERE id=$1 FOR UPDATE", [workerId]);
  await c.query("DELETE FROM work_segments WHERE worker_id=$1", [workerId]);
  const rows = (
    await c.query(
      `SELECT r.*,EXISTS(SELECT 1 FROM attendance_adjustments j WHERE j.record_id=r.id AND j.status='PENDING') AS pending FROM attendance_records r WHERE worker_id=$1 AND NOT confirmed_deleted ORDER BY COALESCE(confirmed_occurred_at,original_occurred_at),received_at,id`,
      [workerId],
    )
  ).rows;
  const opens = new Map();
  const crossShopUnclosed = new Set();
  const add = async (si, so, issue = null) => {
    const start = si?.confirmed_occurred_at,
      end = so?.confirmed_occurred_at;
    let status = issue
      ? "INVALID"
      : si?.pending || so?.pending || !start || !end
        ? "PENDING"
        : "CONFIRMED";
    if (start && end && localDate(start) !== localDate(end)) {
      issue = "CROSS_MIDNIGHT";
      status = "INVALID";
    }
    if (start && end && new Date(end) < new Date(start)) {
      issue = "REVERSED_TIME";
      status = "INVALID";
    }
    await c.query(
      `INSERT INTO work_segments(worker_id,shop_id,sign_in_record_id,sign_out_record_id,start_at,end_at,status,issue_code,duration_minutes,hrs) VALUES($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $7='CONFIRMED' THEN extract(epoch FROM ($6::timestamptz-$5::timestamptz))/60 END,CASE WHEN $7='CONFIRMED' THEN round(extract(epoch FROM ($6::timestamptz-$5::timestamptz))/3600,2) END)`,
      [
        workerId,
        si?.shop_id || so.shop_id,
        si?.id || null,
        so?.id || null,
        start || null,
        end || null,
        status,
        issue,
      ],
    );
  };
  for (const r of rows) {
    const prev = opens.get(r.shop_id);
    if (r.sign_type === "SIGN_IN") {
      for (const [shop, old] of opens) {
        if (shop !== r.shop_id) {
          await add(old, null, "MISSING_SIGN_OUT");
          opens.delete(shop);
        }
      }
      if (prev) await add(prev, null, "MISSING_SIGN_OUT");
      opens.set(r.shop_id, r);
    } else {
      if (prev) {
        await add(prev, r);
        opens.delete(r.shop_id);
      } else {
        await add(null, r, "MISSING_SIGN_IN");
        for (const [shop, open] of opens)
          if (shop !== r.shop_id) crossShopUnclosed.add(open.id);
      }
    }
  }
  for (const si of opens.values()) {
    const old = localDate(si.original_occurred_at) < localDate(new Date());
    await add(
      si,
      null,
      old || crossShopUnclosed.has(si.id) ? "MISSING_SIGN_OUT" : null,
    );
  }
}
// GET /manager/attendance (paginated) and /summary migrated to server-nest's
// ManagerAttendanceController (Epic 3). POST /manager/reports/pdf migrated to server-nest's
// ReportsController (Epic 3) — records()/summary()/filters()/recordScopeSql/scopeSql, its only
// remaining callers, were deleted as dead code in the same change.
// GET [/manager/attendance/:id/history, /attendance/:id/history], GET /manager/validations,
// POST /manager/validations/:id/decision, and POST /manager/attendance/:id/corrections migrated
// to server-nest's AttendanceController/ManagerAttendanceController/ValidationsController
// (Epic 3). rebuild() stays — index.js's maintenance loop still calls it.
// POST /attendance (clock in/out) and GET /attendance/status migrated to server-nest's
// AttendanceController (Epic 3). appScope()/rebuild() stay — the not-yet-migrated personal
// summary and export routes below still use them.
// GET /manager/staff-attendance/staff, GET /manager/attendance/locations, and the shared
// GET /attendance + /manager/staff-attendance listing migrated to server-nest's
// StaffAttendanceController/ManagerAttendanceController/AttendanceController (Epic 3).
// POST /attendance/exports + /manager/staff-attendance/exports and GET /attendance/summary
// migrated to server-nest's AttendanceController/StaffAttendanceController (Epic 3). This was
// the last caller of appScope()/selectedCodes()/attendanceStores()/staffAttendanceScope()/
// personalAttendanceScope()/attendanceDays() — all deleted below as dead code.
// POST /attendance-adjustments, /manager/attendance-adjustments migrated to server-nest's
// AttendanceAdjustmentsController/ManagerAttendanceAdjustmentsController (Epic 3).
// POST /photos, GET /photos/:id/file, GET /photos/:id migrated to server-nest's
// PhotosController (Epic 3) — idem()/audit()/allowed()/assertWorker()/assertRecordScope(),
// their only remaining callers, were deleted as dead code in the same change. The
// `/api/v1/photos` entry in the approval-gate middleware above stays: it still runs ahead of
// Nest's router for every request on that path prefix (see the comment there), so it keeps
// gating this now-fully-Nest-owned route even though no legacy handler is left to protect.

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status =
    err instanceof z.ZodError
      ? 422
      : err.code === "23505"
        ? 409
        : err.status || 500;
  if (status === 500) console.error("API failure:", err.code || err.name);
  res.status(status).json({
    error: {
      code: status === 500 ? "INTERNAL_ERROR" : err.code || "VALIDATION_ERROR",
      message:
        status === 500
          ? "Internal server error"
          : err instanceof z.ZodError
            ? "Invalid request fields"
            : err.message,
      fields: err instanceof z.ZodError ? err.issues : [],
    },
  });
});
