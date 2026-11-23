import { mountAndroidDownload } from "./android-download.js";
import { mountStoreDownload } from "./store-download.js";
import express from "express";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { localPhotoPath } from "./photo-storage.js";
import multer from "multer";
import sharp from "sharp";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import cors from "cors";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { DateTime } from "luxon";
import PDFDocument from "pdfkit";
import { pool, transaction } from "./db.js";
import { monthBounds, localDate, zone } from "./domain.js";
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
});
const s3 = new S3Client({ region: process.env.AWS_REGION || "ap-southeast-2" });
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
const uuid = z.string().uuid();
const backend = ["MANAGER", "GENERAL_MANAGER", "SUPER_MANAGER"];
const companyAdmin = account => ["GENERAL_MANAGER", "SUPER_MANAGER"].includes(account.role);
app.get("/api/v1/health", async (req, res) => {
  await pool.query("SELECT 1");
  res.json({ data: { status: "ok" } });
});
mountAndroidDownload(app);
// auth/login, auth/register, auth/password-links(/consume) migrated to server-nest's
// AuthController (Epic 2) — see server-nest/src/auth/auth.service.ts. They used to be
// defined here, before this middleware, so a request never reached the auth check below;
// now that they live in server-nest, this middleware must explicitly let them fall through
// to it instead of rejecting them as unauthenticated.
const publicAuthPaths = new Set([
  "/auth/login",
  "/manager/auth/login",
  "/auth/register",
  "/auth/password-links",
  "/auth/password-links/consume",
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
    next();
  } catch (e) {
    next(e);
  }
});
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
mountStoreDownload(app);
async function allowed(c, a, shopId) {
  if (companyAdmin(a)) return true;
  if (a.role === "SHOP")
    return !!(
      await c.query("SELECT 1 FROM shops WHERE id=$1 AND account_id=$2", [
        shopId,
        a.id,
      ])
    ).rowCount;
  return !!(
    await c.query(
      "SELECT 1 FROM account_shops WHERE shop_id=$1 AND account_id=$2",
      [shopId, a.id],
    )
  ).rowCount;
}
async function idem(c, a, b, type, fn) {
  const digest = hash(JSON.stringify({ type, body: b }));
  await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [a.id]);
  const r = await c.query(
    "SELECT * FROM api_operations WHERE actor_account_id=$1 AND operation_id=$2",
    [a.id, b.operationId],
  );
  if (r.rowCount) {
    if (r.rows[0].request_hash !== digest)
      fail(
        409,
        "Operation ID already used with different data",
        "IDEMPOTENCY_CONFLICT",
      );
    return r.rows[0].response_data;
  }
  const op = (
    await c.query(
      "INSERT INTO api_operations(actor_account_id,operation_id,request_hash) VALUES($1,$2,$3) RETURNING id",
      [a.id, b.operationId, digest],
    )
  ).rows[0];
  const data = await fn(op.id);
  await c.query("UPDATE api_operations SET response_data=$1 WHERE id=$2", [
    data,
    op.id,
  ]);
  return data;
}
async function audit(c, a, action, id, before = null, after = null) {
  await c.query(
    "INSERT INTO audit_logs(actor_account_id,action,resource_id,before_data,after_data) VALUES($1,$2,$3,$4,$5)",
    [a.id, action, id, before, after],
  );
}
async function assertWorker(c, actor, workerId) {
  if (companyAdmin(actor)) return;
  if (!(await c.query("SELECT 1 FROM manager_workers WHERE manager_account_id=$1 AND worker_id=$2", [actor.id, workerId])).rowCount)
    fail(403, "Groomer outside your scope", "WORKER_FORBIDDEN");
}
async function assertRecordScope(c, actor, shopId, workerId) {
  if (backend.includes(actor.role) && (await c.query("SELECT 1 FROM workers WHERE id=$1 AND account_id=$2", [workerId,actor.id])).rowCount) return;
  if (await allowed(c, actor, shopId)) return;
  return assertWorker(c, actor, workerId);
}
const scopeSql =
  "($1 IN('SUPER_MANAGER','GENERAL_MANAGER') OR EXISTS(SELECT 1 FROM account_shops ac WHERE ac.shop_id=s.id AND ac.account_id=$2))";
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
function filters(req) {
  const p = monthBounds(req.query.month);
  return [
    req.account.role,
    req.account.id,
    p.start,
    p.end,
    req.query.shopId || null,
    req.query.workerId || null,
  ];
}
const recordScopeSql = "($1 IN('SUPER_MANAGER','GENERAL_MANAGER') OR w.account_id=$2 OR EXISTS(SELECT 1 FROM account_shops ac WHERE ac.shop_id=s.id AND ac.account_id=$2) OR EXISTS(SELECT 1 FROM manager_workers mw WHERE mw.worker_id=w.id AND mw.manager_account_id=$2))";
const filtered = `FROM attendance_records r JOIN workers w ON w.id=r.worker_id JOIN accounts wa ON wa.id=w.account_id JOIN shops s ON s.id=r.shop_id JOIN accounts sa ON sa.id=s.account_id WHERE ${recordScopeSql} AND r.effective_occurred_at >= $3 AND r.effective_occurred_at < $4 AND ($5::text IS NULL OR sa.login_code=$5) AND ($6::text IS NULL OR wa.login_code=$6)`;
async function records(req, c = pool) {
  const f = filters(req);
  return (
    await c.query(
      `SELECT r.*,(SELECT x.after_type FROM attendance_adjustments x WHERE x.record_id=r.id AND x.status='PENDING' LIMIT 1) AS pending_sign_type,wa.name AS worker_name,wa.login_code AS "workerId",s.name AS shop_name,sa.login_code AS "shopId",EXISTS(SELECT 1 FROM attendance_adjustments x WHERE x.record_id=r.id AND x.status='PENDING') AS pending ${filtered} AND ($1='SUPER_MANAGER' OR NOT r.effective_deleted) ORDER BY r.effective_occurred_at,r.id`,
      f,
    )
  ).rows;
}
async function summary(req, c = pool) {
  const f = filters(req);
  return (
    await c.query(
      `SELECT wa.login_code AS "workerId",wa.name AS worker_name,sa.login_code AS "shopId",s.name AS shop_name,COALESCE(sum(g.hrs) FILTER(WHERE g.status='CONFIRMED'),0)::numeric(12,2)::text AS "confirmedHrs",count(*) FILTER(WHERE g.status='PENDING')::int AS "pendingSegmentCount",count(*) FILTER(WHERE g.status='INVALID')::int AS "invalidSegmentCount" FROM work_segments g JOIN workers w ON w.id=g.worker_id JOIN accounts wa ON wa.id=w.account_id JOIN shops s ON s.id=g.shop_id JOIN accounts sa ON sa.id=s.account_id LEFT JOIN attendance_records rr ON rr.id=COALESCE(g.sign_in_record_id,g.sign_out_record_id) WHERE ${recordScopeSql} AND COALESCE(g.start_at,rr.effective_occurred_at)>=$3 AND COALESCE(g.start_at,rr.effective_occurred_at)<$4 AND ($5::text IS NULL OR sa.login_code=$5) AND ($6::text IS NULL OR wa.login_code=$6) GROUP BY wa.login_code,wa.name,sa.login_code,s.name ORDER BY wa.name`,
      f,
    )
  ).rows;
}
// GET /manager/attendance (paginated) and /summary migrated to server-nest's
// ManagerAttendanceController (Epic 3). records()/summary()/filters()/recordScopeSql stay —
// POST /manager/reports/pdf (ReportsModule, not yet migrated) still calls them.
// GET [/manager/attendance/:id/history, /attendance/:id/history], GET /manager/validations,
// POST /manager/validations/:id/decision, and POST /manager/attendance/:id/corrections migrated
// to server-nest's AttendanceController/ManagerAttendanceController/ValidationsController
// (Epic 3). assertRecordScope()/rebuild() stay — reports/pdf, the photos route, and index.js's
// maintenance loop still call them.
// POST /attendance (clock in/out) and GET /attendance/status migrated to server-nest's
// AttendanceController (Epic 3). appScope()/rebuild() stay — the not-yet-migrated personal
// summary and export routes below still use them.
app.post("/api/v1/manager/reports/pdf", async (req, res) => {
  const b = z
    .object({
      operationId: uuid,
      month: z.string(),
      shopId: z.string().optional(),
      workerId: z.string().optional(),
      reportType: z.enum(["ATTENDANCE", "TIMESHEET"]),
    })
    .parse(req.body);
  monthBounds(b.month);
  const reportReq = { account: req.account, query: b };
  const data = await transaction(async (c) => {
    await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    return idem(c, req.account, b, "PDF", async () => {
      const snapshot = {
        records: await records(reportReq, c),
        groups: await summary(reportReq, c),
        period: monthBounds(b.month),
        scopeIds: (
          await c.query(
            `SELECT s.id FROM shops s JOIN accounts sa ON sa.id=s.account_id WHERE ${scopeSql} AND ($3::text IS NULL OR sa.login_code=$3)`,
            [req.account.role, req.account.id, b.shopId || null],
          )
        ).rows.map((x) => x.id),
      };
      const r = (
        await c.query(
          "INSERT INTO report_exports(requested_by_account_id,filters,snapshot_data) VALUES($1,$2,$3) RETURNING id",
          [req.account.id, b, snapshot],
        )
      ).rows[0];
      return { reportId: r.id, snapshot };
    });
  });
  for (const record of data.snapshot.records)
    await assertRecordScope(pool, req.account, record.shop_id, record.worker_id);
  for (const group of data.snapshot.groups) {
    const ids = (await pool.query("SELECT w.id AS worker_id,s.id AS shop_id FROM workers w JOIN accounts wa ON wa.id=w.account_id CROSS JOIN shops s JOIN accounts sa ON sa.id=s.account_id WHERE wa.login_code=$1 AND sa.login_code=$2", [group.workerId, group.shopId])).rows[0];
    if (!ids) fail(403, "Report scope unavailable");
    await assertRecordScope(pool, req.account, ids.shop_id, ids.worker_id);
  }
  res.type("pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="Pawhub-${b.month}.pdf"`,
  );
  const doc = new PDFDocument({ margin: 40 });
  doc.pipe(res);
  doc.fontSize(18).text(`Pawhub ${b.reportType} - ${b.month}`);
  doc
    .fontSize(10)
    .text("Timezone: Pacific/Auckland. Pending/invalid periods excluded.");
  for (const g of data.snapshot.groups)
    doc
      .moveDown()
      .text(
        `${g.workerId} | ${g.shopId} | ${g.confirmedHrs} hrs | pending ${g.pendingSegmentCount} | errors ${g.invalidSegmentCount}`,
      );
  if (b.reportType === "ATTENDANCE")
    for (const r of data.snapshot.records)
      doc
        .moveDown()
        .text(
          `${r.workerId} ${r.shopId} ${r.sign_type}\nOriginal: ${DateTime.fromJSDate(new Date(r.original_occurred_at), { zone }).toFormat("yyyy-MM-dd HH:mm:ss")}\nConfirmed: ${r.confirmed_occurred_at ? DateTime.fromJSDate(new Date(r.confirmed_occurred_at), { zone }).toFormat("yyyy-MM-dd HH:mm:ss") : "Pending"}`,
        );
  doc.end();
});
// GET /manager/staff-attendance/staff, GET /manager/attendance/locations, and the shared
// GET /attendance + /manager/staff-attendance listing migrated to server-nest's
// StaffAttendanceController/ManagerAttendanceController/AttendanceController (Epic 3).
// POST /attendance/exports + /manager/staff-attendance/exports and GET /attendance/summary
// migrated to server-nest's AttendanceController/StaffAttendanceController (Epic 3). This was
// the last caller of appScope()/selectedCodes()/attendanceStores()/staffAttendanceScope()/
// personalAttendanceScope()/attendanceDays() — all deleted below as dead code.
// POST /attendance-adjustments, /manager/attendance-adjustments migrated to server-nest's
// AttendanceAdjustmentsController/ManagerAttendanceAdjustmentsController (Epic 3).
app.post("/api/v1/photos", upload.single("file"), async (req, res) => {
  if (!["SHOP", "WORKER", ...backend].includes(req.account.role))
    fail(403, "App account required");
  if (process.env.PHOTO_STORAGE !== "local" && !process.env.PHOTO_BUCKET) fail(503, "Photo storage not configured");
  const operationId = uuid.parse(req.body.operationId);
  if (!req.file) fail(422, "Photo required");
  const meta = await sharp(req.file.buffer, {
    limitInputPixels: 20000000,
  }).metadata();
  if (!["jpeg", "png", "webp"].includes(meta.format))
    fail(422, "Unsupported image format");
  await sharp(req.file.buffer, { limitInputPixels: 20000000 }).stats();
  const b = { operationId, contentHash: hash(req.file.buffer) };
  const data = await transaction((c) =>
    idem(c, req.account, b, "PHOTO", async () => {
      const id = randomUUID(),
        key = `photos/${req.account.id}/${operationId}.${meta.format}`;
      const storageKey = process.env.PHOTO_STORAGE === "local" ? `local:${key}` : key;
      if (process.env.PHOTO_STORAGE === "local") {
        const file = localPhotoPath(storageKey);
        await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        await writeFile(file, req.file.buffer, { mode: 0o600 });
      } else {
        await s3.send(new PutObjectCommand({ Bucket: process.env.PHOTO_BUCKET, Key: key,
          Body: req.file.buffer, ContentType: "image/" + meta.format, ServerSideEncryption: "AES256" }));
      }
      await c.query(
        "INSERT INTO photos(id,uploaded_by_account_id,storage_key,status,media_type,byte_size) VALUES($1,$2,$3,'READY',$4,$5)",
        [id, req.account.id, storageKey, meta.format, req.file.size],
      );
      return { photoId: id };
    }),
  );
  res.status(201).json({ data });
});
async function readablePhoto(req) {
  uuid.parse(req.params.id);
  const r = (
    await pool.query(
      "SELECT p.*,r.shop_id,r.worker_id,w.account_id AS worker_account FROM photos p LEFT JOIN attendance_records r ON r.photo_id=p.id LEFT JOIN workers w ON w.id=r.worker_id WHERE p.id=$1",
      [req.params.id],
    )
  ).rows[0];
  if (!r) fail(404, "Photo unavailable");
  if (r.shop_id) {
    if (req.account.role === "WORKER") {
      if (r.worker_account !== req.account.id) fail(403, "Forbidden");
    } else if (r.worker_account !== req.account.id) await assertRecordScope(pool, req.account, r.shop_id, r.worker_id);
  } else if (r.uploaded_by_account_id !== req.account.id)
    fail(403, "Forbidden");
  if (r.status === "EXPIRED") fail(410, "Photo removed after the 3-month retention period", "PHOTO_EXPIRED");
  if (r.status !== "READY") fail(404, "Photo unavailable");
  return r;
}
app.get("/api/v1/photos/:id/file", async (req, res) => {
  const photo = await readablePhoto(req);
  if (!photo.storage_key.startsWith("local:")) fail(404, "Local photo unavailable");
  res.set("Cache-Control", "private, no-store");
  res.type(photo.media_type === "jpeg" ? "image/jpeg" : `image/${photo.media_type}`);
  res.sendFile(localPhotoPath(photo.storage_key));
});
app.get("/api/v1/photos/:id", async (req, res) => {
  const r = await readablePhoto(req);
  if (r.storage_key.startsWith("local:")) return res.json({ data: {
    url: `/api/v1/photos/${r.id}/file`, requiresAuthentication: true,
  } });
  res.json({
    data: {
      url: await getSignedUrl(
        s3,
        new GetObjectCommand({
          Bucket: process.env.PHOTO_BUCKET,
          Key: r.storage_key,
        }),
        { expiresIn: 120 },
      ),
      expiresIn: 120,
    },
  });
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status =
    err instanceof z.ZodError
      ? 422
      : err instanceof multer.MulterError
        ? 413
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
