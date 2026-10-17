"use strict";
const {test,before,after}=require("node:test");
const assert=require("node:assert/strict");
const crypto=require("node:crypto");
const fs=require("node:fs");
const path=require("node:path");
const {Pool}=require("pg");
const {WebSocket}=require("ws");
const enabled=!!process.env.TEST_DATABASE_URL;
const skip=enabled?false:"Set TEST_DATABASE_URL to run isolated PostgreSQL HTTP integration tests";
let DB,Auth,C,server,pool,adminPool,schema,base;
const generatedFiles=[];
const secret="ci-only-account-passphrase";
class Client{
  constructor(){this.cookie="";this.csrf="";this.ip="127.0.0."+(++Client.count);}
  async call(url,body,extra={}){
    const headers={Origin:process.env.APP_ORIGIN,"X-Real-IP":this.ip,...extra};
    if(this.cookie)headers.Cookie=this.cookie;
    if(body!==undefined){headers["Content-Type"]="application/json";headers["X-CSRF-Token"]=this.csrf;}
    const r=await fetch(base+url,{method:body===undefined?"GET":"POST",headers,body:body===undefined?undefined:JSON.stringify(body)});
    if(r.headers.get("set-cookie"))this.cookie=r.headers.get("set-cookie").split(";")[0];
    const content=await r.text();let json;try{json=JSON.parse(content);}catch{json=null;}
    if(json?.csrfToken)this.csrf=json.csrfToken;
    return {status:r.status,json,content,headers:r.headers};
  }
  async login(login,purpose){await this.call("/api/auth/session");const r=await this.call("/api/auth/login",{login,password:secret,purpose});assert.equal(r.status,200,JSON.stringify(r.json));return r.json;}
}
Client.count=0;
before(async()=>{
  if(!enabled)return;
  process.env.APP_ORIGIN="https://example.test";process.env.ADMIN_PASSWORD=secret;process.env.RAIS_PASSWORD=secret;process.env.NODE_ENV="test";
  adminPool=new Pool({connectionString:process.env.TEST_DATABASE_URL});schema="tm_test_"+crypto.randomBytes(8).toString("hex");
  await adminPool.query(`CREATE SCHEMA ${schema}`);
  pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});
  DB=require("../db");await DB.init({pool});
  const PW=require("../srv/passwords");
  DB.set("orgs.json",{rais:PW.set({id:"rais",login:"rais",productionProvisioned:true},secret),
    associations:[PW.set({id:"a1",login:"assoc",name:"Association"},secret)],
    companies:[PW.set({id:"c1",login:"company",name:"Company",assocId:"a1"},secret),PW.set({id:"c2",login:"other",name:"Other company",assocId:"a1"},secret)],
    buyers:[PW.set({id:"b1",login:"buyer",name:"Buyer",email:"buyer@example.test"},secret)],
    analysts:[PW.set({id:"an1",login:"analyst",name:"Analyst",scopes:["bozor"]},secret)]});
  await DB.flush();server=require("../server");Auth=require("../srv/auth");C=require("../core");await Auth.init();
  await new Promise(resolve=>server.httpServer.listen(0,"127.0.0.1",resolve));base="http://127.0.0.1:"+server.httpServer.address().port;
});
after(async()=>{
  if(!enabled)return;
  await new Promise(resolve=>server?.httpServer.close(resolve));await DB?.close();
  for(const file of generatedFiles)await fs.promises.unlink(file).catch(()=>{});
  if(schema)await adminPool.query(`DROP SCHEMA ${schema} CASCADE`);await adminPool?.end();
});
test("HTTP auth matrix, guest ownership, private files and revocation",{skip},async()=>{
  const clients={};
  for(const role of ["admin","rais","assoc","company","analyst","buyer"]){const c=new Client();const v=await c.login(role);assert.equal(v.role,role);assert.ok(!JSON.stringify(v).includes(secret));clients[role]=c;}
  const guest=new Client(),other=new Client();await guest.call("/api/auth/session");await other.call("/api/auth/session");
  assert.equal((await guest.call("//api/ping")).status,400);
  assert.equal((await guest.call("/api/orgs",{op:"list",pass:secret})).status,403);
  assert.equal((await clients.rais.call("/api/orgs",{op:"list"})).status,200);
  assert.equal((await clients.rais.call("/api/orgs",{op:"assoc.del",id:"a1"})).status,403);
  assert.equal((await clients.buyer.call("/api/company/login",{})).status,401);
  const profile=await clients.company.call("/api/company/login",{login:"other",password:secret});assert.equal(profile.json.company.id,"c1");
  const auth=await Auth.load({headers:{cookie:guest.cookie}}),key=Auth.owner(auth);
  DB.set("chats.json",{[key]:{sessions:{s1:{id:"s1",title:"Only mine",messages:[{text:"private"}]}}},"victim@example.test":{sessions:{s2:{id:"s2",title:"Legacy",messages:[{text:"legacy"}]}}}});await DB.flush();
  assert.equal((await guest.call("/api/sessions?email=victim@example.test")).json[0].id,"s1");
  assert.deepEqual((await other.call("/api/session?id=s1&email=victim@example.test")).json,{messages:[]});
  assert.equal((await guest.call("/api/monthly")).status,403);
  assert.equal((await clients.company.call("/api/company/login",{}, {Origin:"https://attacker.test"})).status,403);
  const inquiry={companyId:"c1",email:"same@example.test",contact:"same@example.test",message:"First private thread"};
  assert.equal((await guest.call("/api/bozor/inquiry",inquiry)).status,200);
  assert.equal((await other.call("/api/bozor/inquiry",{...inquiry,message:"Second private thread"})).status,200);
  const mine=(await guest.call("/api/bozor/inquiry/mine",{email:"same@example.test"})).json.items;
  assert.equal(mine.length,1);assert.equal(mine[0].message,"First private thread");
  assert.equal((await guest.call("/api/moliya/passport",{email:"same@example.test",need:700,contracts:"Private contracts"})).status,200);
  assert.equal((await guest.call("/api/moliya/passport",{op:"get",email:"same@example.test"})).json.passport.need,700);
  assert.equal((await other.call("/api/moliya/passport",{op:"get",email:"same@example.test"})).json.passport,null);
  assert.equal((await guest.call("/api/mehnat/candidate",{email:"same@example.test",name:"Private candidate",visibility:"private"})).status,200);
  assert.equal((await guest.call("/api/mehnat/candidate",{op:"get",email:"same@example.test"})).json.candidate.name,"Private candidate");
  assert.equal((await other.call("/api/mehnat/candidate",{op:"get",email:"same@example.test"})).json.candidate,null);
  const funding=(await guest.call("/api/moliya/request",{email:"same@example.test",amount:100,currency:"USD"})).json.request;
  assert.equal((await other.call("/api/moliya/request/status",{id:funding.id,status:"closed",email:"same@example.test"})).status,403);
  assert.equal((await guest.call("/api/moliya/request/status",{id:funding.id,status:"closed"})).status,200);
  const image=Buffer.from("private attachment").toString("base64");
  const sent=await clients.company.call("/api/group",{op:"send",group:"assoc:a1",text:"attachment",attach:{data:image,mime:"application/pdf",name:"private.pdf"}});
  assert.equal(sent.status,200);const file=sent.json.messages.at(-1).att.url;
  generatedFiles.push(path.join(__dirname,"..",file.slice(1)));
  assert.equal((await guest.call(file)).status,404);assert.equal((await clients.assoc.call(file)).status,200);
  const badDownload=await guest.call("/uploads/../server.js");assert.equal(badDownload.status,404);
  const loggedOutCookie=clients.company.cookie;await clients.company.call("/api/auth/logout",{});
  assert.equal((await clients.company.call("/api/company/login",{})).status,401);
  assert.equal(await Auth.load({headers:{cookie:loggedOutCookie}}),null);
  const o=C.getOrgs();o.buyers[0].suspended=true;C.saveOrgs(o);await DB.flush();
  assert.equal((await clients.buyer.call("/api/buyer/home",{})).status,403);
  const restricted=new Client();await restricted.login("buyer","rights");
  assert.equal((await restricted.call("/api/legal/export",{})).status,200);
  assert.equal((await restricted.call("/api/legal/mine",{})).status,200);
  assert.equal((await restricted.call("/api/buyer/home",{})).status,403);
  const analystExport=await clients.analyst.call("/api/analyst/export",{kind:"xlsx",days:30});
  assert.equal(analystExport.status,200);assert.match(analystExport.headers.get("content-type"),/spreadsheetml/);
});
test("WebSocket rejects foreign Origin and authenticates from cookie",{skip},async()=>{
  const c=new Client();await c.login("assoc");const url=base.replace("http:","ws:")+"/ws";
  await new Promise((resolve,reject)=>{
    const socket=new WebSocket(url,{headers:{Origin:process.env.APP_ORIGIN,Cookie:c.cookie}});
    const timer=setTimeout(()=>{socket.terminate();reject(new Error("WebSocket timeout"));},5000);
    socket.on("open",()=>socket.send(JSON.stringify({op:"auth",login:"admin",password:secret})));
    socket.on("message",data=>{const value=JSON.parse(data);assert.equal(value.op,"auth");assert.equal(value.me.type,"assoc");clearTimeout(timer);socket.close();resolve();});socket.on("error",reject);
  });
  await new Promise((resolve,reject)=>{
    const socket=new WebSocket(url,{headers:{Origin:"https://attacker.test",Cookie:c.cookie}});
    socket.on("open",()=>{socket.terminate();reject(new Error("Foreign origin accepted"));});socket.on("unexpected-response",(_,r)=>{assert.equal(r.statusCode,403);r.resume();resolve();});socket.on("error",()=>resolve());
  });
});
