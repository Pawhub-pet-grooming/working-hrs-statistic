import test from 'node:test';
import assert from 'node:assert/strict';
import argon2 from 'argon2';
import { pool } from '../src/db.js';
import { createCombinedTestServer } from '../../server-nest/dist/test-support/combined-app.js';

test('Shop employee lookup requires the owning shop and active approved workers and managers', {skip: !process.env.TEST_DATABASE_URL}, async () => {
  assert.ok(new URL(process.env.TEST_DATABASE_URL).pathname.endsWith('_test'));
  await pool.query('TRUNCATE accounts CASCADE');
  const hash = await argon2.hash('lookup-test-password');
  const shop = (await pool.query("INSERT INTO accounts(role,login_code,name,password_hash,status) VALUES('SHOP','0001','Lookup shop',$1,'ACTIVE') RETURNING id", [hash])).rows[0];
  await pool.query("INSERT INTO shops(account_id,name,address,latitude,longitude) VALUES($1,'Lookup shop','Test',0,0)", [shop.id]);
  const worker = (await pool.query("INSERT INTO accounts(role,login_code,name,email,password_hash,status,requires_manager_approval) VALUES('WORKER','1234','Real Employee','lookup-worker@test.invalid',$1,'ACTIVE',false) RETURNING id", [hash])).rows[0];
  await pool.query('INSERT INTO workers(account_id) VALUES($1)', [worker.id]);
  const server = await createCombinedTestServer();
  server.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  async function get(path, token) {
    return fetch(base + path, {headers: token ? {Authorization: `Bearer ${token}`} : {}});
  }
  try {
    assert.equal((await get('/shops/0001/employees/1234')).status, 401);
    const login = await fetch(base + '/auth/login', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({accountId: '0001', password: '123456'})});
    assert.equal(login.status, 200);
    const token = (await login.json()).data.sessionToken;
    const result = await get('/shops/0001/employees/1234', token);
    assert.equal(result.status, 200);
    assert.deepEqual((await result.json()).data, {shopId: '0001', workerId: '1234', name: 'Real Employee'});
    const manager = (await pool.query("INSERT INTO accounts(role,login_code,name,email,password_hash,status,requires_manager_approval,approved_at) VALUES('MANAGER','1000','Test Manager','lookup-manager@test.invalid',$1,'ACTIVE',true,now()) RETURNING id", [hash])).rows[0];
    const { readFile } = await import('node:fs/promises');
    const migration = await readFile(new URL('../migrations/019.sql', import.meta.url), 'utf8');
    await pool.query(migration);
    await pool.query(migration);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM workers WHERE account_id=$1', [manager.id])).rows[0].count, 1);
    const managerLookup = await get('/shops/0001/employees/1000', token);
    assert.equal(managerLookup.status, 200);
    assert.deepEqual((await managerLookup.json()).data, {shopId: '0001', workerId: '1000', name: 'Test Manager'});
    await pool.query("UPDATE accounts SET approved_at=NULL WHERE id=$1", [manager.id]);
    assert.equal((await get('/shops/0001/employees/1000', token)).status, 403);
    await pool.query("UPDATE accounts SET status='PENDING' WHERE id=$1", [manager.id]);
    assert.equal((await get('/shops/0001/employees/1000', token)).status, 404);
    await pool.query("UPDATE accounts SET status='DISABLED' WHERE id=$1", [manager.id]);
    assert.equal((await get('/shops/0001/employees/1000', token)).status, 404);
    assert.equal((await get('/shops/0001/employees/9999', token)).status, 404);
    assert.equal((await get('/shops/0001/employees/abc', token)).status, 422);
    await pool.query("UPDATE accounts SET status='DISABLED' WHERE id=$1", [worker.id]);
    assert.equal((await get('/shops/0001/employees/1234', token)).status, 404);
    await pool.query("UPDATE accounts SET status='ACTIVE',requires_manager_approval=true WHERE id=$1", [worker.id]);
    assert.equal((await get('/shops/0001/employees/1234', token)).status, 403);
    const other = (await pool.query("INSERT INTO accounts(role,login_code,name,password_hash,status) VALUES('SHOP','0002','Other shop',$1,'ACTIVE') RETURNING id", [hash])).rows[0];
    await pool.query("INSERT INTO shops(account_id,name,address,latitude,longitude) VALUES($1,'Other shop','Test',0,0)", [other.id]);
    assert.equal((await get('/shops/0002/employees/1234', token)).status, 403);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await pool.end();
  }
});
