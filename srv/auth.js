"use strict";
const crypto = require("node:crypto");
const events = new (require("node:events").EventEmitter)();
const { AsyncLocalStorage } = require("node:async_hooks");
const DB = require("../db");
const PW = require("./passwords");
const context = new AsyncLocalStorage();
const ROLE_KEYS = { assoc: "associations", company: "companies", analyst: "analysts", buyer: "buyers" };
const TARGETS = { admin: "admin.html", rais: "admin.html", assoc: "association.html", company: "company.html", analyst: "tahlil.html", buyer: "xaridor.html" };
const hash = value => crypto.createHash("sha256").update(String(value)).digest("hex");
const random = () => crypto.randomBytes(32).toString("hex");
let core;
function configure(value) { core = value; }
function current() { return context.getStore()?.auth || null; }
function run(auth, fn) { return context.run({ auth }, fn); }
function owner(auth = current()) { return auth?.role === "guest" ? `guest:${auth.subjectId}` : auth ? `account:${auth.role}:${auth.subjectId}` : null; }
function account(role, id) {
  const orgs = core.getOrgs();
  if (role === "admin") return { id: "admin", name: "Administrator", login: "admin", pwHash: hash(process.env.ADMIN_PASSWORD || "") };
  if (role === "rais") return orgs.rais ? { ...orgs.rais, id: "rais" } : null;
  return (orgs[ROLE_KEYS[role]] || []).find(rec => rec.id === id) || null;
}
function record(role, auth = current()) {
  if (!auth || auth.restricted || auth.role !== role) return null;
  const rec = account(role, auth.subjectId); return rec && !rec.suspended ? rec : null;
}
function actor(auth = current()) {
  if (!auth || auth.restricted || auth.role === "guest") return null;
  const rec = account(auth.role, auth.subjectId);
  if (!rec || rec.suspended) return null;
  return { type: auth.role, id: auth.subjectId, name: rec.chairman || rec.name || rec.login,
    assocId: rec.assocId, email: rec.email || "" };
}
function hasRole(...roles) { const a = current(); return !!(a && !a.restricted && roles.includes(a.role) && actor(a)); }
function chatActor(auth=current()){return auth&&["admin","rais","assoc","company"].includes(auth.role)?actor(auth):null;}
function person(body = {}, auth = current()) {
  if (!auth || auth.restricted) return null;
  const rec = auth.role === "guest" ? auth.contact || {} : account(auth.role, auth.subjectId);
  if (!rec || rec.suspended) return null;
  return { id: owner(auth), name: String(body.name || rec.name || "Visitor").slice(0,160),
    email: String(body.email || rec.email || "").trim().toLowerCase().slice(0,120), type: auth.role };
}
const COOKIE = () => process.env.NODE_ENV === "production" ? "__Host-tm_session" : "tm_session";
function cookie(req) {
  const found = String(req.headers.cookie || "").split(";").map(p => p.trim()).find(p => p.startsWith(COOKIE()+"="));
  const value = found?.slice(COOKIE().length + 1); return /^[a-f0-9]{64}$/.test(value || "") ? value : null;
}
function setCookie(res, token, seconds) {
  res.setHeader("Set-Cookie", `${COOKIE()}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`);
}
async function init() {
  await DB.query(`CREATE TABLE IF NOT EXISTS auth_sessions(token_hash TEXT PRIMARY KEY, role TEXT NOT NULL,
    subject_id TEXT NOT NULL, fingerprint TEXT NOT NULL, csrf TEXT NOT NULL, restricted BOOLEAN NOT NULL DEFAULT false,
    contact JSONB NOT NULL DEFAULT '{}', expires_at TIMESTAMPTZ NOT NULL)`);
  await DB.query("DELETE FROM auth_sessions WHERE expires_at < now()");
}
async function create(res, role = "guest", rec = {}, restricted = false) {
  const token = random(), csrf = random(), seconds = role === "guest" ? 30*86400 : 12*3600;
  const auth = { role, subjectId: rec.id || crypto.randomBytes(16).toString("hex"), csrf, restricted,
    fingerprint: role === "guest" ? "" : hash(rec.pwHash || ""), contact: {}, tokenHash: hash(token) };
  await DB.query("INSERT INTO auth_sessions(token_hash,role,subject_id,fingerprint,csrf,restricted,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+$7::int*interval '1 second')",
    [auth.tokenHash,role,auth.subjectId,auth.fingerprint,csrf,restricted,seconds]);
  setCookie(res, token, seconds); return auth;
}
async function load(req) {
  const token = cookie(req); if (!token) return null;
  const { rows } = await DB.query("SELECT * FROM auth_sessions WHERE token_hash=$1 AND expires_at > now()", [hash(token)]);
  const row = rows[0]; if (!row) return null;
  const auth = { role: row.role, subjectId: row.subject_id, fingerprint: row.fingerprint,
    csrf: row.csrf, restricted: row.restricted, contact: row.contact, tokenHash: row.token_hash };
  if (auth.role !== "guest") {
    const rec = account(auth.role, auth.subjectId);
    if (!rec || (!auth.restricted && rec.suspended) || hash(rec.pwHash || "") !== auth.fingerprint) return null;
  }
  return auth;
}
async function revoke(auth) { if (auth) {await DB.query("DELETE FROM auth_sessions WHERE token_hash=$1", [auth.tokenHash]);events.emit("revoke",auth.tokenHash);} }
function view(auth) {
  const rec = auth.role === "guest" ? null : account(auth.role, auth.subjectId);
  const target = auth.restricted ? "mening-malumotlarim.html" : TARGETS[auth.role] || "assistant.html";
  return { ok: true, authenticated: auth.role !== "guest", role: auth.role, restricted: auth.restricted,
    target, csrfToken: auth.csrf, guest: auth.role === "guest" ? auth.contact : undefined,
    user: rec ? { id: auth.subjectId, role: auth.role, login: rec.login || "", name: rec.chairman || rec.name || rec.login,
      email: rec.email || "", target, restricted: auth.restricted } : null };
}
function checkCsrf(req, auth) {
  if (!auth || req.headers.origin !== process.env.APP_ORIGIN || req.headers["x-csrf-token"] !== auth.csrf
      || !String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
    const e = new Error("csrf_rejected"); e.status = 403; throw e;
  }
}
const limits = new Map();
function throttle(key, max = 20, windowMs = 60000) {
  const now = Date.now(), row = limits.get(key);
  if (limits.size > 10000) { for (const [k,v] of limits) if (v.end <= now) limits.delete(k); if (limits.size > 10000) throw Object.assign(new Error("rate_limited"), {status:429}); }
  const next = !row || row.end <= now ? { count: 0, end: now + windowMs } : row;
  next.count++; limits.set(key,next);
  if (next.count > max) throw Object.assign(new Error("rate_limited"), {status:429});
}
function login(body) {
  const lg = String(body.login || "").trim(), password = String(body.password || "");
  const restricted = body.purpose === "rights";
  let role, rec;
  if ((!lg || lg.toLowerCase() === "admin") && password && process.env.ADMIN_PASSWORD
      && crypto.timingSafeEqual(Buffer.from(hash(password)),Buffer.from(hash(process.env.ADMIN_PASSWORD)))) {
    role = "admin"; rec = account(role,"admin");
  } else {
    const orgs = core.getOrgs();
    if (orgs.rais?.login === lg && PW.verify(orgs.rais,password)) { role="rais"; rec={...orgs.rais,id:"rais"}; }
    for (const candidate of ["assoc","company","analyst","buyer"]) {
      if (rec) break;
      const hit = (orgs[ROLE_KEYS[candidate]] || []).find(r => String(r.login).toLowerCase() === lg.toLowerCase() && PW.verify(r,password));
      if (hit) { role=candidate; rec=hit; }
    }
  }
  if (!rec || (!restricted && rec.suspended) || (restricted && !["company","assoc","buyer"].includes(role))) return null;
  return { role, rec, restricted };
}
async function handle(req,res,pathname,readBody,json,auth) {
  if (pathname === "/api/auth/session" && req.method === "GET") {
    if(!auth)throttle(`session-ip:${req.headers["x-real-ip"]||req.socket.remoteAddress}`,60,3600000);
    return json(res,200,view(auth || await create(res)));
  }
  if (!pathname.startsWith("/api/auth/")) return false;
  checkCsrf(req,auth);
  if (pathname === "/api/auth/login" && req.method === "POST") {
    throttle(`login-ip:${req.headers["x-real-ip"] || req.socket.remoteAddress}`,10,60000);
    const body = await readBody(req);
    throttle(`login-name:${hash(String(body.login || "").toLowerCase())}`,10,60000);
    const result=login(body); if(!result) return json(res,401,{error:"invalid_credentials"});
    await revoke(auth); return json(res,200,view(await create(res,result.role,result.rec,result.restricted)));
  }
  if (pathname === "/api/auth/logout" && req.method === "POST") { await revoke(auth); return json(res,200,view(await create(res))); }
  if (pathname === "/api/auth/guest" && req.method === "POST" && auth.role === "guest") {
    const body=await readBody(req);
    const contact={email:String(body.email || "").trim().toLowerCase().slice(0,120),name:String(body.name || "").slice(0,160)};
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email)) return json(res,400,{error:"email_invalid"});
    await DB.query("UPDATE auth_sessions SET contact=$1 WHERE token_hash=$2",[JSON.stringify(contact),auth.tokenHash]);
    auth.contact=contact; return json(res,200,view(auth));
  }
  return json(res,404,{error:"not_found"});
}
module.exports={configure,current,run,owner,account,record,actor,chatActor,hasRole,person,init,load,create,revoke,view,checkCsrf,throttle,login,handle,events};
