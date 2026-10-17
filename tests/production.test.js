"use strict";
const {test,beforeEach}=require("node:test");
const assert=require("node:assert/strict");
const DB=require("../db");
const Auth=require("../srv/auth");
const PW=require("../srv/passwords");
const {durableResponse,validate}=require("../srv/runtime");
class MemoryPool{
  constructor(){this.documents=new Map();this.sessions=new Map();this.fail=false;this.writes=[];}
  on(){}
  async end(){}
  async query(sql,args=[]){
    if(this.fail)throw new Error("offline");
    if(sql.startsWith("SELECT key,data"))return {rows:[...this.documents].map(([key,data])=>({key,data}))};
    if(sql.startsWith("INSERT INTO documents")){this.writes.push(args);this.documents.set(args[0],JSON.parse(args[1]));}
    if(sql.startsWith("INSERT INTO auth_sessions"))this.sessions.set(args[0],{token_hash:args[0],role:args[1],subject_id:args[2],fingerprint:args[3],csrf:args[4],restricted:args[5],contact:{}});
    if(sql.startsWith("SELECT * FROM auth_sessions"))return {rows:this.sessions.has(args[0])?[this.sessions.get(args[0])]:[]};
    if(sql.startsWith("DELETE FROM auth_sessions WHERE token_hash"))this.sessions.delete(args[0]);
    return {rows:[]};
  }
}
let pool;
beforeEach(async()=>{pool=new MemoryPool();DB.onFailure(()=>{});await DB.init({pool});});
test("queued writes snapshot values and flush acknowledges PostgreSQL",async()=>{
  const object={count:1};DB.set("collection.json",object);object.count=2;DB.set("collection.json",object);
  await DB.flush();assert.equal(JSON.parse(pool.writes[0][1]).count,1);assert.equal(pool.documents.get("collection.json").count,2);
});
test("failed persistence poisons cache and cannot acknowledge success",async()=>{
  pool.fail=true;DB.set("collection.json",{count:1});await assert.rejects(DB.flush());assert.equal(await DB.probe(),false);
  assert.throws(()=>DB.get("collection.json",{}),/unavailable/);assert.throws(()=>DB.set("next.json",{}),/unavailable/);
});
test("initialization failure rejects; a fresh initialization resets failure state",async()=>{
  const broken=new MemoryPool();broken.fail=true;await assert.rejects(DB.init({pool:broken}));
  await DB.init({pool:new MemoryPool()});assert.equal(await DB.probe(),true);
});
test("buffered download and JSON do not send a 2xx before durability",async()=>{
  const sent=[],res={writeHead:(...v)=>sent.push(v),end:b=>sent.push(b)};
  await durableResponse({},res,async response=>{response.writeHead(200,{"Content-Type":"application/octet-stream"});response.end(Buffer.from("file"));DB.set("a.json",{});assert.equal(sent.length,0);});
  assert.equal(sent[0][0],200);assert.equal(sent[1].toString(),"file");
  const failed=[];pool.fail=true;
  await assert.rejects(durableResponse({},{writeHead:v=>failed.push(v),end(){}},async response=>{DB.set("a.json",{});response.writeHead(200);response.end("success");}));
  assert.deepEqual(failed,[]);
});
test("six roles authenticate, session cookie contains no credentials, and resets revoke",async()=>{
  const secret="a sufficiently long test passphrase",orgs={rais:PW.set({login:"oversight",id:"rais"},secret),associations:[],companies:[],analysts:[],buyers:[]};
  for(const [role,key] of Object.entries({assoc:"associations",company:"companies",analyst:"analysts",buyer:"buyers"}))orgs[key].push(PW.set({id:role+"1",login:role,name:role},secret));
  Auth.configure({getOrgs:()=>orgs});process.env.ADMIN_PASSWORD=secret;process.env.NODE_ENV="production";
  for(const login of ["admin","oversight","assoc","company","analyst","buyer"]){
    const result=Auth.login({login,password:secret});assert.ok(result,login);
    let cookie;const auth=await Auth.create({setHeader:(_,v)=>{cookie=v;}},result.role,result.rec);
    assert.match(cookie,/^__Host-tm_session=[a-f0-9]{64}; Path=\/; HttpOnly; SameSite=Lax;/);assert.match(cookie,/; Secure$/);
    assert.ok(!cookie.includes(secret));assert.ok(!JSON.stringify(Auth.view(auth)).includes("pwHash"));
    const req={headers:{cookie}};assert.equal((await Auth.load(req)).role,result.role);
    if(result.role==="company"){PW.set(orgs.companies[0],"a different secret passphrase");assert.equal(await Auth.load(req),null);}
    await Auth.revoke(auth);assert.equal(await Auth.load(req),null);
  }
});
test("suspended accounts only get restricted self-rights sessions",()=>{
  const rec=PW.set({id:"c1",login:"company",suspended:true},"a long test passphrase");Auth.configure({getOrgs:()=>({companies:[rec]})});
  assert.equal(Auth.login({login:"company",password:"a long test passphrase"}),null);
  const result=Auth.login({login:"company",password:"a long test passphrase",purpose:"rights"});assert.equal(result.restricted,true);
  Auth.run({role:"company",subjectId:"c1",restricted:true},()=>{assert.equal(Auth.actor(),null);assert.equal(Auth.record("company"),null);assert.equal(Auth.person({email:"someone@example.test"}),null);});
});
test("forged body identity cannot change anonymous owner and CSRF rejects foreign origins",()=>{
  const auth={role:"guest",subjectId:"server-generated",csrf:"csrf",contact:{}};
  Auth.run(auth,()=>{assert.equal(Auth.person({email:"victim@example.test",id:"victim"}).id,"guest:server-generated");});
  process.env.APP_ORIGIN="https://example.test";
  const headers={origin:"https://example.test","content-type":"application/json","x-csrf-token":"csrf"};Auth.checkCsrf({headers},auth);
  assert.throws(()=>Auth.checkCsrf({headers:{...headers,origin:"https://attacker.test"}},auth),/csrf/);
  assert.throws(()=>Auth.checkCsrf({headers:{...headers,"x-csrf-token":"wrong"}},auth),/csrf/);
});
test("guest owner keys fit existing forty-character domain identifiers",async()=>{
  const guest=await Auth.create({setHeader(){}});assert.ok(Auth.owner(guest).length<=40);assert.match(guest.subjectId,/^[a-f0-9]{32}$/);
});
test("private assets require owner or current room membership",async()=>{
  const Assets=require("../srv/assets");const core={groupAllows:(a,g)=>a.id==="friend"&&g==="group"};
  Auth.configure({getOrgs:()=>({companies:[{id:"owner"},{id:"friend"},{id:"stranger"}]})});
  const owner={role:"company",subjectId:"owner"};Auth.run(owner,()=>{Assets.register("/uploads/a.pdf");Assets.share("/uploads/a.pdf","group");});
  assert.equal(Assets.allowed("/uploads/a.pdf",core,owner),true);assert.equal(Assets.allowed("/uploads/a.pdf",core,{role:"company",subjectId:"friend"}),true);
  assert.equal(Assets.allowed("/uploads/a.pdf",core,{role:"company",subjectId:"stranger"}),false);assert.equal(Assets.allowed("/uploads/a.pdf",core,null),false);
  await DB.flush();
});
test("spreadsheet writer exports real XLSX compatible with patched UUID dependency",async()=>{
  const {toXlsx}=require("../srv/analytics"),ExcelJS=require("exceljs");
  const bytes=await toXlsx([{name:"Metrics",rows:[["Metric","Value"],["Count",42]]}]);
  const wb=new ExcelJS.Workbook();await wb.xlsx.load(bytes);assert.equal(wb.getWorksheet("Metrics").getCell("B2").value,42);
});
test("multiple workers are rejected before startup",()=>{
  const previous=process.env.WEB_CONCURRENCY;process.env.DATABASE_URL="postgresql://localhost/test";process.env.RAIS_PASSWORD="a long test passphrase";process.env.ADMIN_PASSWORD="a long test passphrase";process.env.APP_ORIGIN="https://example.test";process.env.WEB_CONCURRENCY="2";
  assert.throws(validate,/WEB_CONCURRENCY/);if(previous===undefined)delete process.env.WEB_CONCURRENCY;else process.env.WEB_CONCURRENCY=previous;
});
