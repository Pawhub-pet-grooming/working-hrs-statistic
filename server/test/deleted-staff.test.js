import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import argon2 from 'argon2';
import {pool} from '../src/db.js';
import {createCombinedTestServer} from '../../server-nest/dist/test-support/combined-app.js';

test('Deleted staff are opt-in while historical records remain editable and exportable', {skip:!process.env.TEST_DATABASE_URL}, async()=>{
 assert.ok(new URL(process.env.TEST_DATABASE_URL).pathname.endsWith('_test'));
 await pool.query('TRUNCATE accounts CASCADE');
 const password=await argon2.hash('test-only-password');
 const owner=(await pool.query("INSERT INTO accounts(role,name,email,password_hash,status) VALUES('SUPER_MANAGER','Owner','owner@test.invalid',$1,'ACTIVE') RETURNING id",[password])).rows[0];
 const shopAccount=(await pool.query("INSERT INTO accounts(role,name,login_code,password_hash,status) VALUES('SHOP','Shop','0001',$1,'ACTIVE') RETURNING id",[password])).rows[0];
 const shop=(await pool.query("INSERT INTO shops(account_id,name,address,latitude,longitude) VALUES($1,'Shop','Test',0,0) RETURNING id",[shopAccount.id])).rows[0];
 const people=[];
 for(const [code,status] of [['1234','ACTIVE'],['1235','DISABLED']]){
  const a=(await pool.query("INSERT INTO accounts(role,name,email,login_code,password_hash,status,requires_manager_approval) VALUES('WORKER',$1::text,$2,$1::text,$3,$4,false) RETURNING id",[code,code+'@test.invalid',password,status])).rows[0];
  const w=(await pool.query('INSERT INTO workers(account_id) VALUES($1) RETURNING id',[a.id])).rows[0];people.push(w);
 }
 const record=(await pool.query("INSERT INTO attendance_records(worker_id,shop_id,submitted_by_account_id,sign_type,source,original_occurred_at,effective_occurred_at,camera_status) VALUES($1,$2,$3,'SIGN_IN','MANUAL_ADD','2026-11-02T09:00:00+13:00','2026-11-02T09:00:00+13:00','NOT_APPLICABLE') RETURNING id",[people[1].id,shop.id,owner.id])).rows[0];
 const token=randomUUID();
 await pool.query("INSERT INTO sessions(account_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour')",[owner.id,createHash('sha256').update(token).digest('hex')]);
 const server=await createCombinedTestServer();server.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const base=`http://127.0.0.1:${server.address().port}/api/v1`;
 const request=async(path,body)=>{const r=await fetch(base+path,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${token}`,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json()};};
 try{
  const active=await request('/manager/staff-attendance/staff');assert.equal(active.status,200);assert.ok(active.body.data.some(p=>p.workerId==='1234'));assert.ok(!active.body.data.some(p=>p.workerId==='1235'));
  const all=await request('/manager/staff-attendance/staff?includeDeleted=true');assert.equal(all.body.data.find(p=>p.workerId==='1235').status,'DISABLED');
  const range='fromDate=2026-11-01&toDate=2026-11-30';
  assert.equal((await request('/manager/staff-attendance?'+range)).body.data.items.length,0);
  const history=await request('/manager/staff-attendance?workerIds=1235&'+range);assert.equal(history.status,200);assert.equal(history.body.data.items[0].id,record.id);
  const edit=await request('/manager/attendance-adjustments',{operationId:randomUUID(),action:'UPDATE',recordId:record.id,expectedVersion:history.body.data.items[0].version,type:'SIGN_IN',occurredAt:'2026-11-02T09:05:00+13:00'});assert.equal(edit.status,201,JSON.stringify(edit.body));
  const updated=await request('/manager/staff-attendance?workerIds=1235&'+range);
  const exported=await request('/manager/staff-attendance/exports',{operationId:randomUUID(),workerIds:['1235'],fromDate:'2026-11-01',toDate:'2026-11-30',records:updated.body.data.items.map(r=>({id:r.id,version:r.version}))});assert.equal(exported.status,202,JSON.stringify(exported.body));
 }finally{await new Promise(r=>server.close(r));await pool.end();}
});
