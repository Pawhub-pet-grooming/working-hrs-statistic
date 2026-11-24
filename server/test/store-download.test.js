import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import argon2 from "argon2";
import { pool } from "../src/db.js";
import { createCombinedTestServer } from "../../server-nest/dist/test-support/combined-app.js";

test(
  "Store APK metadata and download links require a management role",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    assert.ok(new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test"));
    await pool.query("TRUNCATE accounts CASCADE");
    const password = await argon2.hash("test-only-password");
    const tokens = {};
    for (const [role, code] of [["MANAGER", "1001"], ["GENERAL_MANAGER", null], ["SUPER_MANAGER", null], ["WORKER", "1002"], ["SHOP", "0001"]]) {
      const account = (
        await pool.query(
          "INSERT INTO accounts(role,name,email,login_code,password_hash,status,requires_manager_approval) VALUES($1,$1,$2,$3,$4,'ACTIVE',false) RETURNING id",
          [role, role.toLowerCase() + "@test.invalid", code, password],
        )
      ).rows[0];
      const token = randomUUID();
      await pool.query(
        "INSERT INTO sessions(account_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour')",
        [account.id, createHash("sha256").update(token).digest("hex")],
      );
      tokens[role] = token;
    }

    const server = await createCombinedTestServer();
    server.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${server.address().port}/api/v1/manager/downloads/store-android`;
    const previousBucket = process.env.STORE_APK_BUCKET;
    try {
      for (const [token, status] of [[null, 401], [tokens.WORKER, 403], [tokens.SHOP, 403]]) {
        const headers = token ? { Authorization: `Bearer ${token}` } : {};
        assert.equal((await fetch(base, { headers })).status, status);
        assert.equal((await fetch(base + "/link", { method: "POST", headers })).status, status);
      }

      // Unconfigured: available is false and the signed-link route refuses to issue one.
      process.env.STORE_APK_BUCKET = "";
      for (const role of ["MANAGER", "GENERAL_MANAGER", "SUPER_MANAGER"]) {
        const headers = { Authorization: `Bearer ${tokens[role]}` };
        const metadata = await fetch(base, { headers });
        assert.equal(metadata.headers.get("cache-control"), "no-store");
        const { data } = await metadata.json();
        assert.equal(data.releaseName, "1.0.5-rc2");
        assert.equal(data.versionName, "1.0.5");
        assert.equal(data.available, false);
        assert.equal(data.objectKey, undefined);
        assert.equal((await fetch(base + "/link", { method: "POST", headers })).status, 503);
      }

      // Configured: available is true and a real presigned S3 URL comes back.
      process.env.STORE_APK_BUCKET = "pawhub-store-apps-test";
      const headers = { Authorization: `Bearer ${tokens.MANAGER}` };
      const metadata = await (await fetch(base, { headers })).json();
      assert.equal(metadata.data.available, true);
      const link = await fetch(base + "/link", { method: "POST", headers });
      assert.equal(link.status, 200);
      assert.equal(link.headers.get("cache-control"), "no-store");
      const { data } = await link.json();
      assert.match(data.url, /^https:\/\/pawhub-store-apps-test\.s3\./);
      assert.match(data.url, /\/store-releases\/pawhub-v1\.0\.5-rc2\.apk\?/);
      assert.match(data.url, /X-Amz-Signature=/);
    } finally {
      process.env.STORE_APK_BUCKET = previousBucket;
      await new Promise((r) => server.close(r));
      await pool.end();
    }
  },
);
