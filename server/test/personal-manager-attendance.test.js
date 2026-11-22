import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import argon2 from 'argon2';
import sharp from 'sharp';
import {pool} from '../src/db.js';
import {createCombinedTestServer} from '../../server-nest/dist/test-support/combined-app.js';
after(()=>pool.end());

for(const role of ['WORKER','MANAGER']) test(role+': personal app login, photo and attendance use the same flow', {skip:!process.env.TEST_DATABASE_URL},async()=>{
 assert.ok(new URL(process.env.TEST_DATABASE_URL).pathname.endsWith('_test'));
 await pool.query('TRUNCATE accounts CASCADE');
 const hash=await argon2.hash('test-password');
 const store=(await pool.query("INSERT INTO accounts(role,login_code,name,password_hash,status) VALUES('SHOP','0001','Shop',$1,'ACTIVE') RETURNING id",[hash])).rows[0];
 const shop=(await pool.query("INSERT INTO shops(account_id,name,address,latitude,longitude) VALUES($1,'Shop','Test',0,0) RETURNING id",[store.id])).rows[0];
 const person=(await pool.query("INSERT INTO accounts(role,login_code,name,email,password_hash,status,requires_manager_approval,preferred_shop_id) VALUES($1,'1000','Personal account','personal@test.invalid',$2,'ACTIVE',false,$3) RETURNING id",[role,hash,shop.id])).rows[0];
 await pool.query('INSERT INTO workers(account_id) VALUES($1)',[person.id]);
 const server=await createCombinedTestServer();server.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const base=`http://127.0.0.1:${server.address().port}/api/v1`;let token;
 const request=async(path,body)=>{const r=await fetch(base+path,{method:body?'POST':'GET',headers:{...(token?{Authorization:`Bearer ${token}`} : {}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json()};};
 try{
  const login=await request('/auth/login',{accountId:'1000',password:'test-password'});assert.equal(login.status,200);assert.equal(login.data.data.account.role,role);token=login.data.data.sessionToken;
  assert.equal((await request('/me')).data.data.accountId,'1000');
  const personalShops=await request('/shops');assert.equal(personalShops.status,200);assert.ok(personalShops.data.data.some(s=>s.shopId==='0001'));
  const profile=await request('/me/profile');assert.equal(profile.data.data.preferredShopId,'0001');
  assert.ok(personalShops.data.data.some(s=>s.shopId===profile.data.data.preferredShopId));
  if(role==='MANAGER') { const managed=await request('/manager/shops');assert.equal(managed.status,200);assert.equal(managed.data.data.length,0); }

  const status=await request('/attendance/status?shopId=0001');assert.equal(status.status,200);
  const png=await sharp({create:{width:16,height:16,channels:3,background:'#88aa99'}}).png().toBuffer();
  const form=new FormData();form.set('operationId',randomUUID());form.set('file',new Blob([png],{type:'image/png'}),'selfie.png');
  const upload=await fetch(base+'/photos',{method:'POST',headers:{Authorization:`Bearer ${token}`},body:form});assert.equal(upload.status,201);const photoId=(await upload.json()).data.photoId;
  const body={operationId:randomUUID(),shopId:'0001',workerId:'1000',type:'SIGN_IN',occurredAt:status.data.data.serverTime,plannedStartAt:status.data.data.serverTime,expectedDailyCount:0,offline:false,cameraStatus:'AVAILABLE',photoId};
  const signed=await request('/attendance',body);assert.equal(signed.status,201,JSON.stringify(signed.data));
  const history=await request(`/attendance?shopId=0001&fromDate=${status.data.data.localDate}&toDate=${status.data.data.localDate}`);assert.equal(history.status,200);assert.equal(history.data.data.items.length,1);assert.equal(history.data.data.items[0].source,'PERSONAL_APP');
  const other=(await pool.query("INSERT INTO accounts(role,login_code,name,email,password_hash,status,requires_manager_approval) VALUES('WORKER','1234','Other','other@test.invalid',$1,'ACTIVE',false) RETURNING id",[hash])).rows[0];await pool.query('INSERT INTO workers(account_id) VALUES($1)',[other.id]);
  assert.equal((await request('/attendance',{...body,operationId:randomUUID(),workerId:'1234'})).status,403);
 }finally{await new Promise(r=>server.close(r));}
});
