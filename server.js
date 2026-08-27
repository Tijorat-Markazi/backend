/* ============================================================
   TIJORAT MARKAZI — web backend (serves the site + AI API)
   Run:  node server.js   (key from gemini.key or GEMINI_API_KEY)
   ============================================================ */
const http  = require("http");
const https = require("https");
const fs    = require("fs");
const path  = require("path");
const url   = require("url");
const { execSync } = require("child_process");
const C = require("./core");
const G = require("./meet-bot");
const MARKETS = require("./srv/api");     // Bozor · Moliya bozori · Human Capital Markazi
const BID = require("./srv/business-id");  // Business ID — public identity card
const QR = require("qrcode");
const PW = require("./srv/passwords");     // credentials are hashed at rest — nothing here reads one

/* The admin password used to be the literal string "admin" compiled into a
   dozen comparisons. In production it comes from ADMIN_PASSWORD (or admin.key);
   the old default still works for local dev but the server says so loudly. */
const ADMIN_PASS = (process.env.ADMIN_PASSWORD || (()=>{
  try{ return fs.readFileSync(path.join(__dirname,"admin.key"),"utf8").trim(); }catch(e){ return ""; }
})() || "admin");
const ADMIN_IS_DEFAULT = ADMIN_PASS === "admin";
const isAdmin = v => typeof v === "string" && v.length > 0 && v === ADMIN_PASS;

/* A rejected promise anywhere must not take the whole site down. Log it and
   keep serving; a genuinely broken process still exits so a supervisor can
   restart it, but only after queued database writes are flushed. */
process.on("unhandledRejection", e => {
  console.error("[unhandled rejection]", (e && e.stack) || e);
});
process.on("uncaughtException", e => {
  console.error("[uncaught exception]", (e && e.stack) || e);
  C.dbFlush().finally(() => process.exit(1));
});

const PORT = process.env.PORT || 4321;
const HTTPS_PORT = process.env.HTTPS_PORT || 4443;
const ROOT = __dirname;

/* ---------- helpers ---------- */
/* Bodies were read without a ceiling, so any endpoint could be fed an
   unbounded upload. Image uploads legitimately reach a few megabytes, so the
   cap sits above those and aborts anything larger. */
const MAX_BODY = 12 * 1024 * 1024;
function readBody(req){
  return new Promise(res=>{
    let b="", over=false;
    req.on("data",c=>{
      if(over) return;
      b+=c;
      if(b.length > MAX_BODY){ over=true; b=""; req.destroy(); res({}); }
    });
    req.on("end",()=>{ if(!over){ try{res(JSON.parse(b||"{}"));}catch(e){res({});} } });
    req.on("error",()=>{ if(!over) res({}); });
  });
}
function json(res, code, obj){ res.writeHead(code, { "Content-Type":"application/json" }); res.end(JSON.stringify(obj)); }

/* ---- unlimited-AI roles: admin, super-admin (association), company, rais, analyst ----
   Credentials are VALIDATED server-side, so a faked client flag can't bypass the limit. */
function isPrivileged(o, auth){
  if(!auth || typeof auth!=="object") return false;
  if(isAdmin(auth.pass)) return true;                                   // admin panel (password "admin")
  const lg = String(auth.login||"").trim(), pw = String(auth.password||"");
  if(!lg) return false;
  if(C.findCompany(o, lg, pw)) return true;                              // company (uyushma a'zosi)
  if(raisAuth(o, lg, pw)) return true;                                   // rais
  if((o.associations||[]).some(a=>a.login===lg && PW.verify(a, pw))) return true; // super-admin (association)
  if((o.analysts||[]).some(a=>a.login===lg && PW.verify(a, pw))) return true;     // analyst (tahlilchi)
  return false;
}
const LIMIT_MSG = [
  "Bepul 3 ta savol limiti tugadi.",
  "Лимит 3 бесплатных вопросов исчерпан.",
  "Free limit of 3 questions reached."
];
function limitMsg(lang){ const i={uz:0,ru:1,en:2}[lang]; return LIMIT_MSG[i==null?1:i]; }
/* The rais tier. Seventeen routes used to inline the same three-part comparison
   against a plaintext field; they all ask this instead, so the day the hash
   scheme changes there is one place to change it. */
function raisAuth(o, login, password){
  const lg = String(login||"").trim();
  return !!(o && o.rais && lg && o.rais.login===lg && PW.verify(o.rais, password));
}
function authAssoc(o, login, password){
  const lg = String(login||"").trim();
  if(!lg) return null;
  return o.associations.find(x=>x.login===lg && !x.suspended && PW.verify(x, password)) || null;
}

/* Who is calling? Used by the group chat and by attachment upload, so
   both agree on identity and neither has to trust a claim in the body. */
function resolveActor(o, b){
  if(isAdmin(b.pass)) return { type:"admin", id:"admin", name:"Administrator" };
  const lg = String(b.login||"").trim(), pw = String(b.password||"");
  if(raisAuth(o, lg, pw)) return { type:"rais", id:"rais", name:"Rais" };
  const a = o.associations.find(x=>x.login===lg && PW.verify(x, pw));
  if(a) return { type:"assoc", id:a.id, name:a.chairman || a.name };
  const c = C.findCompany(o, lg, pw);
  if(c) return { type:"company", id:c.id, name:c.name, assocId:c.assocId };
  return null;
}

/* ---------- the admin thread, shown as a chat room ----------
   Bridges the original company↔admin store into the group-chat surface so a
   company has one Chats page instead of two screens. Nothing is migrated:
   admin.html keeps reading the same store through /api/admin/chats. */
const ADMIN_ROOM = "admin:";
const ADMIN_ROOM_TITLE = { uz:"Administrator", ru:"Администратор", en:"Administrator" };

function adminRoomAllows(actor, cid){
  if(actor.type === "admin" || actor.type === "rais") return true;
  return actor.type === "company" && String(actor.id) === String(cid);
}

/** Legacy rows carry no id or display name; both are derived here. */
function adminRoomThread(o, cid){
  const c = o.companies.find(x => String(x.id) === String(cid));
  return C.chatThread(cid).map((m, i) => ({
    id: "a" + i,
    from: m.from === "company" ? "company" : "admin",
    fromId: m.from === "company" ? cid : "admin",
    fromName: m.from === "company" ? (c ? c.name : "—") : "Administrator",
    text: m.text || "", time: m.time || 0,
    att: m.att || undefined,
  }));
}

function adminRoomCard(o, cid, lang){
  const c = o.companies.find(x => String(x.id) === String(cid));
  const msgs = C.chatThread(cid);
  const last = msgs[msgs.length - 1];
  return {
    id: ADMIN_ROOM + cid,
    title: ADMIN_ROOM_TITLE[lang] || ADMIN_ROOM_TITLE.uz,
    dm: true,
    members: [{ id: cid, role:"company", name: c ? c.name : "—" },
              { id:"admin", role:"admin", name:"Administrator" }],
    count: msgs.length,
    last: last ? last.text : "",
    lastFrom: last ? (last.from === "company" ? (c ? c.name : "—") : "Administrator") : "",
    time: last ? last.time : 0,
  };
}

/** A company always sees its own admin room; oversight sees the live ones. */
function adminRooms(o, actor, lang){
  if(actor.type === "company") return [adminRoomCard(o, actor.id, lang)];
  if(actor.type === "admin" || actor.type === "rais"){
    return C.chatList().map(x => Object.assign(adminRoomCard(o, x.companyId, lang), {
      title: (x.name || "—") + " ↔ Administrator" }));
  }
  return [];
}

/* ---------- Google Meet rooms ----------
   No API and no Cloud project: a signed-in Chrome profile on this machine
   is driven the way a person would drive it (see meet-bot.js). A link typed
   by hand always wins; if the bot cannot produce one the meeting is still
   saved, just without a room, and the panel says why. */
async function withMeet(b){
  const manual = String(b.link||"").trim();
  if(manual) return Object.assign({}, b, { link:manual, provider:"manual", meetError:"" });
  try{
    const room = await G.createMeeting();
    return Object.assign({}, b, { link:room.link, provider:"meet-bot", meetError:"" });
  }catch(e){
    console.error("[meet-bot] create failed:", e.message);
    return Object.assign({}, b, { link:"", provider:"", meetError:String(e.message||e).slice(0,200) });
  }
}
/* A bot-made room is not owned by any calendar entry, so deleting a
   meeting here has nothing to cancel upstream — the room simply goes
   unused and Google expires it on its own. */
async function dropMeet(){ /* nothing to clean up */ }

/* retry a room for a meeting saved while the bot was signed out */
async function relinkMeeting(scope, id){
  const found = C.confFind(id);
  if(!found) return { ok:false, error:"not_found", meetings:C.confList(scope) };
  const m = found.meeting;
  const fresh = await withMeet({ title:m.title, datetime:m.datetime, desc:m.desc, link:"" });
  const meeting = C.confUpdate(found.scope, id, fresh);
  return { ok:!!(meeting && meeting.link), meeting, meetings:C.confList(scope), google:G.status() };
}


/* Documents the AI generated are disposable once downloaded; user-uploaded
   attachments are referenced from chat history and are never touched. */
const DOC_TTL_DAYS = Number(process.env.DOC_TTL_DAYS) || 14;
function sweepGeneratedDocs(){
  const dir = path.join(ROOT, "uploads");
  const cutoff = Date.now() - DOC_TTL_DAYS*24*60*60*1000;
  let removed = 0;
  try{
    for(const f of fs.readdirSync(dir)){
      if(!/^doc[a-z0-9]+.(pdf|docx|xlsx|pptx)$/i.test(f)) continue;
      const p = path.join(dir, f);
      try{ if(fs.statSync(p).mtimeMs < cutoff){ fs.unlinkSync(p); removed++; } }catch(e){}
    }
  }catch(e){ return; }
  if(removed) console.log(`  🧹 uploads: removed ${removed} generated document(s) older than ${DOC_TTL_DAYS}d`);
}

/* ---------- API ---------- */
async function handleApi(req, res, pathname, query){
  if(pathname==="/api/ping") return json(res,200,{ ok:true, ai:!!C.KEY, model:C.MODEL });

  /* The three market modules keep their own routes under srv/. They get the
     transport helpers and core rather than importing this file back. */
  if(MARKETS.owns(pathname))
    return MARKETS.handle(req, res, pathname, query, { readBody, json, core:C, isPrivileged, isAdmin });

  if(pathname==="/api/sessions"){
    const store=C.getStore(); const u=store[query.email]; if(!u) return json(res,200,[]);
    const list=Object.values(u.sessions).filter(s=>s.messages.length)
      .map(s=>({ id:s.id, title:s.title||"…", updated:s.updated })).sort((a,b)=>b.updated-a.updated);
    return json(res,200,list);
  }
  if(pathname==="/api/session"){
    const store=C.getStore(); const s=store[query.email]?.sessions?.[query.id];
    return json(res,200,{ messages: s?s.messages:[] });
  }
  if(pathname==="/api/chat" && req.method==="POST"){
    const { email, id, message, lang, attachment, company, auth } = await readBody(req);
    if(!email||!id||(!message && !attachment)) return json(res,400,{ error:"bad request" });
    const privileged = isPrivileged(C.getOrgs(), auth);
    if(!privileged && C.aiUsageCount(email) >= C.AI_FREE_LIMIT){
      return json(res,200,{ reply: limitMsg(lang), ai:!!C.KEY, limit:true,
        used: C.aiUsageCount(email), max: C.AI_FREE_LIMIT, remaining: 0, privileged:false });
    }
    const reply = await C.answer({ email, sessionId:id, message, attachment, lang, company: String(company||"").slice(0,160) });
    const used = privileged ? null : C.aiUsageInc(email);
    return json(res,200,{ reply, ai:!!C.KEY, limit:false, privileged,
      max: privileged?null:C.AI_FREE_LIMIT, used,
      remaining: privileged?null:Math.max(0, C.AI_FREE_LIMIT-(used||0)) });
  }
  /* ---- AI usage / limit status for the assistant page ---- */
  if(pathname==="/api/ai-usage" && req.method==="POST"){
    const { email, auth } = await readBody(req);
    const privileged = isPrivileged(C.getOrgs(), auth);
    const used = C.aiUsageCount(email);
    return json(res,200,{ privileged, max: privileged?null:C.AI_FREE_LIMIT, used,
      remaining: privileged?null:Math.max(0, C.AI_FREE_LIMIT-used) });
  }
  if(pathname==="/api/ask" && req.method==="POST"){
    const { message, history, lang, attachment, guestId } = await readBody(req);
    if(!message && !attachment) return json(res,400,{ error:"bad request" });
    // Demo / guest users (no login) are limited to AI_FREE_LIMIT questions, counted
    // per browser via guestId — same counter store as logged-in email users.
    const key = String(guestId||"").slice(0,80) || null;
    if(key && C.aiUsageCount(key) >= C.AI_FREE_LIMIT){
      return json(res,200,{ reply: limitMsg(lang), ai:!!C.KEY, limit:true, privileged:false,
        used: C.aiUsageCount(key), max: C.AI_FREE_LIMIT, remaining: 0 });
    }
    const msgs = (history||[]).map(m=>({ role:m.role, text:m.text }));
    const turn = C.buildUserTurn(message, attachment);
    msgs.push({ role:"user", text: turn.text, image: turn.media });
    const out = await C.askWithFiles(msgs, lang);
    let reply = out.text;
    if(!reply) reply = C.fallbackReply(message||"", lang);
    const used = key ? C.aiUsageInc(key) : null;
    return json(res,200,{ reply, files: out.files, ai:!!C.KEY, limit:false, privileged:false,
      max: key?C.AI_FREE_LIMIT:null, used,
      remaining: used!=null ? Math.max(0, C.AI_FREE_LIMIT-used) : null });
  }
  /* ---- AI writes a real PDF / Word / Excel / PowerPoint file ----
     Generation is metered like any other AI answer, so the free tier
     cannot be used as an unlimited document factory. */
  if(pathname==="/api/ai/document" && req.method==="POST"){
    const b = await readBody(req);
    const kind = String(b.kind||"").toLowerCase();
    const prompt = String(b.prompt||"").trim();
    if(!prompt) return json(res,400,{ error:"prompt_required" });
    if(!C.docKinds().includes(kind)) return json(res,400,{ error:"bad_kind", kinds:C.docKinds() });

    const privileged = isPrivileged(C.getOrgs(), b.auth || b);
    const meter = String(b.email || b.guestId || "").slice(0,80);
    if(!privileged){
      if(!meter) return json(res,401,{ error:"identify_first" });
      if(C.aiUsageCount(meter) >= C.AI_FREE_LIMIT)
        return json(res,200,{ ok:false, limit:true, reply:limitMsg(b.lang) });
    }
    const doc = await C.aiDocument({ kind, prompt, lang:b.lang, title:b.title });
    if(!doc.ok) return json(res,200,{ ok:false, error:doc.error, note:doc.note||"" });
    if(!privileged && meter) C.aiUsageInc(meter);
    return json(res,200,{ ok:true, url:doc.url, name:doc.name, size:doc.size, kind, note:doc.note||"" });
  }
  if(pathname==="/api/transcribe" && req.method==="POST"){
    const { audio, mime } = await readBody(req);
    if(!audio) return json(res,400,{ error:"no audio" });
    const text = await C.transcribe(audio, mime);
    return json(res,200,{ text: text||"" });
  }
  if(pathname==="/api/conference" && req.method==="GET"){
    // ?manage=1[&assoc=ID] → scope-only list (admin/uyushma manage)
    // ?list=1[&assoc=ID]   → company view (assoc meetings + global)
    if(query.manage!==undefined) return json(res,200,{ meetings: C.confList(query.assoc||"global") });
    if(query.list){
      if(query.assoc) return json(res,200,{ meetings: C.confVisible(query.assoc) });
      return json(res,200,{ meetings: C.confList("global") });
    }
    if(query.assoc) return json(res,200, C.getAssocConference(query.assoc) || {});   // next single (banner)
    return json(res,200, C.getConference() || {});
  }
  /* join → straight into the Google Meet room (link resolved server-side,
     so a re-generated room reaches everyone without a page refresh) */
  if(pathname==="/api/conference/join" && req.method==="GET"){
    const found = C.confFind(String(query.id||""));
    const link = found ? String(found.meeting.link||"") : "";
    if(!/^https?:\/\//i.test(link)){          // never redirect to anything but a real web link
      res.writeHead(302, { Location:"/conference.html?join=unavailable" });
      return res.end();
    }
    res.writeHead(302, { Location:link, "Cache-Control":"no-store" });
    return res.end();
  }
  if(pathname==="/api/conference" && req.method==="POST"){
    const b = await readBody(req);
    if(!isAdmin(b.pass)) return json(res,403,{ error:"forbidden" });
    const scope = String(b.assocId||"").trim();   // empty → global; otherwise a specific uyushma
    if(b.removeId){ await dropMeet(b.removeId, scope||"global"); C.confRemove(scope, b.removeId); return json(res,200,{ ok:true, meetings: C.confList(scope) }); }
    if(b.relinkId) return json(res,200, await relinkMeeting(scope, b.relinkId));
    if(!String(b.title||"").trim()) return json(res,400,{ error:"title_required" });
    const meeting = C.confAdd(scope, await withMeet(b));
    return json(res,200,{ ok:true, meeting, meetings: C.confList(scope), google: G.status() });
  }
  /* ---- the Google account the Meet bot drives ---- */
  if(pathname==="/api/google/status"){
    return json(res,200, Object.assign({ ok:true }, G.status()));
  }
  /* opens a real Chrome window on the server machine so a human can sign
     in once; the bot reuses that profile forever after */
  if(pathname==="/api/google/login" && req.method==="POST"){
    const b = await readBody(req);
    if(!isAdmin(b.pass)) return json(res,403,{ error:"forbidden" });
    try{ await G.openLogin(); return json(res,200,{ ok:true, opened:true, google:G.status() }); }
    catch(e){ return json(res,200,{ ok:false, error:String(e.message||e).slice(0,200), google:G.status() }); }
  }
  if(pathname==="/api/google/verify" && req.method==="POST"){
    const b = await readBody(req);
    if(!isAdmin(b.pass)) return json(res,403,{ error:"forbidden" });
    try{ const r = await G.verify(); return json(res,200,{ ok:r.signedIn, google:G.status() }); }
    catch(e){ return json(res,200,{ ok:false, error:String(e.message||e).slice(0,200), google:G.status() }); }
  }
  if(pathname==="/api/google/disconnect" && req.method==="POST"){
    const b = await readBody(req);
    if(!isAdmin(b.pass)) return json(res,403,{ error:"forbidden" });
    await G.signOut();
    return json(res,200,{ ok:true, google:G.status() });
  }

  /* ---- super-admin: associations + member companies ---- */
  if(pathname==="/api/orgs" && req.method==="POST"){
    const b = await readBody(req);
    if(!isAdmin(b.pass)) return json(res,403,{ error:"forbidden" });
    const o = C.getOrgs();
    const S = (v,n)=>String(v||"").slice(0,n);
    const op = b.op;
    if(op==="assoc.add"){
      // an association carries its name in all three languages; any left blank
      // falls back to the Uzbek one rather than showing an empty heading
      const uz = S(b.nameUz!=null?b.nameUz:b.name,200);
      o.associations.push({ id:C.uid("a"), name:uz,
        i18n:{ uz, ru:S(b.nameRu,200)||uz, en:S(b.nameEn,200)||uz },
        chairman:S(b.chairman,120) });
    } else if(op==="assoc.update"){
      const a=o.associations.find(x=>x.id===b.id);
      if(a){
        const i18n = Object.assign({}, C.orgNames(a));
        if(b.nameUz!=null) i18n.uz = S(b.nameUz,200);
        if(b.nameRu!=null) i18n.ru = S(b.nameRu,200);
        if(b.nameEn!=null) i18n.en = S(b.nameEn,200);
        if(b.name!=null && b.nameUz==null) i18n.uz = S(b.name,200);
        a.i18n = i18n;
        a.name = i18n.uz || a.name;          // Uzbek stays the canonical key
        if(b.chairman!=null)a.chairman=S(b.chairman,120);
        if(b.login!=null){ const lg=S(b.login,60).trim(); if(lg && !o.associations.some(x=>x!==a&&x.login===lg)) a.login=lg; }
        if(b.password) PW.set(a, S(b.password,120));
      }
    } else if(op==="assoc.del"){
      o.associations=o.associations.filter(x=>x.id!==b.id);
      o.companies=o.companies.filter(c=>c.assocId!==b.id);
    } else if(op==="company.add"){
      const login=S(b.login,60).trim();
      if(!login||!b.password) return json(res,400,{ error:"login & password required" });
      if(o.companies.some(c=>c.login===login)) return json(res,409,{ error:"login exists" });
      o.companies.push(PW.set({ id:C.uid("c"), name:S(b.name,200), assocId:S(b.assocId,40),
        sector:S(b.sector,120), login, showroom:[], created:Date.now() }, S(b.password,120)));
    } else if(op==="company.update"){
      const c=o.companies.find(x=>x.id===b.id);
      if(c){ if(b.name!=null)c.name=S(b.name,200); if(b.assocId!=null)c.assocId=S(b.assocId,40);
        if(b.sector!=null)c.sector=S(b.sector,120); if(b.password) PW.set(c, S(b.password,120)); }
    } else if(op==="company.del"){
      o.companies=o.companies.filter(x=>x.id!==b.id);
    } else if(op==="rais.set"){
      const lg=S(b.login,60).trim(); if(lg) o.rais.login=lg; if(b.password) PW.set(o.rais, S(b.password,120));
      if(b.tgChat!=null) o.rais.tgChat=S(b.tgChat,40).trim();
    } else if(op!=="list"){
      return json(res,400,{ error:"unknown op" });
    }
    if(op&&op!=="list") C.saveOrgs(o);
    /* These are the raw store records. Sent whole they carried the credential
       field with them, so the admin panel was a second way to read every
       password on the platform. They leave stripped. */
    return json(res,200,{ ok:true, associations:o.associations.map(PW.strip),
      companies:o.companies.map(PW.strip), rais:PW.strip(o.rais) });
  }

  /* ---- rais schedules a meeting (Zoom) → all associations & companies see it ---- */
  if(pathname==="/api/rais/conference" && req.method==="POST"){
    const b = await readBody(req);
    const o = C.getOrgs();
    if(!(isAdmin(b.pass) || raisAuth(o, b.login, b.password)))
      return json(res,403,{ error:"forbidden" });
    if(b.removeId){ await dropMeet(b.removeId, "global"); C.confRemove("global", b.removeId); return json(res,200,{ ok:true, meetings: C.confList("global") }); }
    if(b.relinkId) return json(res,200, await relinkMeeting("global", b.relinkId));
    if(!String(b.title||"").trim()) return json(res,400,{ error:"title_required" });
    const meeting = C.confAdd("global", await withMeet(b));
    return json(res,200,{ ok:true, meeting, meetings: C.confList("global"), google: G.status() });
  }

  /* ---- rais: monthly questions report ---- */
  if(pathname==="/api/rais/questions" && req.method==="POST"){
    const b = await readBody(req);
    const o = C.getOrgs();
    if(!(isAdmin(b.pass) || raisAuth(o, b.login, b.password)))
      return json(res,403,{ error:"forbidden" });
    const months = C.questionMonths();
    const ym = b.ym || months[0] || "";
    // associations whose member companies asked something this month (for the combined letter)
    const assocs = C.getOrgs().associations.map(a=>{
      const aq = C.assocQuestions(a.id, ym);
      const total = aq.report.reduce((s,q)=>s+q.count,0);
      return { id:a.id, name:a.name, i18n:C.orgNames(a), count:total, companies:aq.users.length,
        questions: aq.report.map(q=>({ question:q.question, count:q.count, companies:q.companies })) };
    }).filter(a=>a.count>0).sort((x,y)=>y.count-x.count);
    return json(res,200,{ ok:true, months, ym, report: C.questionsReport(ym), users: C.usersReport(ym), assocs });
  }

  /* ---- rais: monthly report archive (auto-generated at month end) ---- */
  if(pathname==="/api/rais/reports" && req.method==="POST"){
    const b = await readBody(req);
    const o = C.getOrgs();
    if(!(isAdmin(b.pass) || raisAuth(o, b.login, b.password)))
      return json(res,403,{ error:"forbidden" });
    const dir = path.join(C.DATA,"reports");
    let archived = [];
    try{ archived = fs.readdirSync(dir).map(f=>(/konglomerat-(\d{4}-\d{2})\.doc/.exec(f)||[])[1]).filter(Boolean); }catch(e){}
    return json(res,200,{ ok:true, months: C.questionMonths(), archived, tgChat: !!(o.rais.tgChat) });
  }

  /* ---- rais: AI writes ONE official letter for ONE recipient (never mixed) ---- */
  if(pathname==="/api/rais/letter" && req.method==="POST"){
    const b = await readBody(req);
    const o = C.getOrgs();
    if(!(isAdmin(b.pass) || raisAuth(o, b.login, b.password)))
      return json(res,403,{ error:"forbidden" });
    const type = b.type==="company" ? "company" : "email";
    const key  = String(b.key||"").slice(0,160);
    if(!key) return json(res,400,{ error:"no recipient" });
    const questions = C.userQuestions(type, key, b.ym||"");
    if(!questions.length) return json(res,404,{ error:"no questions for this recipient" });
    const letter = await C.generateLetter({ recipient:key, questions, lang:b.lang||"ru" });
    const rec = { id:C.uid("ltr"), recipientType:type, recipientKey:key, recipientLabel:key,
      ym:b.ym||"", subject:"TIJORAT MARKAZI — rasmiy xat", body:letter, requests:questions.length,
      created:Date.now() };
    C.addLetter(rec);
    return json(res,200,{ ok:true, letter:rec });
  }

  /* ---- rais: ONE combined official letter for a WHOLE association
          (all member companies' questions merged into a single letter) ---- */
  if(pathname==="/api/rais/assoc-letter" && req.method==="POST"){
    const b = await readBody(req);
    const o = C.getOrgs();
    if(!(isAdmin(b.pass) || raisAuth(o, b.login, b.password)))
      return json(res,403,{ error:"forbidden" });
    const a = o.associations.find(x=>x.id===String(b.assocId||""));
    if(!a) return json(res,404,{ error:"association not found" });
    const aq = C.assocQuestions(a.id, b.ym||"");
    // each line carries the question and which member company raised it
    const questions = aq.report.map(q=>
      (q.companies && q.companies.length) ? `${q.question} — (${q.companies.join(", ")})` : q.question);
    if(!questions.length) return json(res,404,{ error:"no questions for this association" });
    const body = await C.generateLetter({ recipient:a.name, questions, lang:b.lang||"ru" });
    const rec = { id:C.uid("ltr"), recipientType:"assoc", recipientKey:a.id, recipientLabel:a.name,
      ym:aq.ym||b.ym||"", subject:"TIJORAT MARKAZI — rasmiy xat", body, requests:questions.length,
      created:Date.now() };
    C.addLetter(rec);
    return json(res,200,{ ok:true, letter:rec });
  }

  /* ---- rais (top oversight): sees ALL associations + their products ---- */
  /* ---- one sign-in for every tier ----
     The browser used to try each tier's endpoint in turn, which meant up to
     four round trips per sign-in and a 401 logged to the console for every
     tier that was not the right one. Resolving here instead costs one
     request, keeps the failures off the client, and leaves a single place to
     add rate limiting. The reply never says which tier a login belongs to
     when it fails — only that the pair did not match. */
  if(pathname==="/api/auth/login" && req.method==="POST"){
    const body = await readBody(req);
    const login = String(body.login||"").trim();
    const password = String(body.password||"");
    const o = C.getOrgs();

    /* platform admin — the one tier with no login name of its own */
    if((login==="" || login.toLowerCase()==="admin") && isAdmin(password))
      return json(res,200,{ ok:true, role:"admin", target:"admin.html", keys:{ kg_admin:"1" } });

    if(login){
      const creds = JSON.stringify({ login, password });
      if(raisAuth(o, login, password))
        return json(res,200,{ ok:true, role:"rais", target:"admin.html",
          keys:{ kg_admin:"1", kg_rais:creds } });

      if(o.associations.some(x=>x.login===login && !x.suspended && PW.verify(x, password)))
        return json(res,200,{ ok:true, role:"association", target:"association.html",
          keys:{ kg_as:creds } });

      if(C.findCompany(o, login, password))
        return json(res,200,{ ok:true, role:"company", target:"company.html",
          keys:{ kg_co:creds } });

      if(MARKETS.analystAuth && MARKETS.analystAuth(o, login, password))
        return json(res,200,{ ok:true, role:"analyst", target:"tahlil.html",
          keys:{ kg_an:creds } });

      /* The buying side. Last in the chain because it is the newest tier and
         the one whose logins are checked against every other tier at
         approval time — nothing above it can be shadowed by a buyer. */
      if(MARKETS.buyerAuth && MARKETS.buyerAuth(o, login, password))
        return json(res,200,{ ok:true, role:"buyer", target:"xaridor.html",
          keys:{ kg_by:creds } });
    }
    return json(res,401,{ error:"invalid_credentials" });
  }

  if(pathname==="/api/rais/login" && req.method==="POST"){
    const { login, password } = await readBody(req);
    const o = C.getOrgs();
    if(!raisAuth(o, login, password))
      return json(res,401,{ error:"invalid credentials" });
    const associations = o.associations.map(a=>({
      id:a.id, name:a.name, i18n:C.orgNames(a), chairman:a.chairman,
      companies: o.companies.filter(c=>c.assocId===a.id)
        .map(c=>({ name:c.name, sector:c.sector, showroom:c.showroom||[] }))
    }));
    return json(res,200,{ ok:true, associations });
  }

  /* ---- public: associations directory + single association page ---- */
  if(pathname==="/api/assoc/list" && req.method==="GET"){
    const o = ensureBizIds(C.getOrgs());
    return json(res,200, o.associations.map(a=>({
      id:a.id, bizId:a.bizId||"", name:a.name, i18n:C.orgNames(a), chairman:a.chairman,
      companies: o.companies.filter(c=>c.assocId===a.id).length })));
  }
  /* ---- public Showroom: all products across all companies (for the home page) ---- */
  /* ---- XIZMATLAR: services member companies offer (public catalogue) ---- */
  if(pathname==="/api/services" && req.method==="GET"){
    const o = C.getOrgs();
    const aById = {}; o.associations.forEach(a=>{ aById[a.id]=a.name; });
    const byId  = {}; o.companies.forEach(c=>{ byId[c.id]=c; });
    const items = C.getModules().items
      .filter(i => i.module==="service" && i.ownerType==="company" && byId[i.ownerId])
      .sort((a,b)=>b.created-a.created)
      .map(i => { const c = byId[i.ownerId]; return {
        id:i.id, title:i.title||"", body:i.body||"", price:i.amount||"", status:i.status||"",
        company:c.name||"", sector:c.sector||"", assoc:aById[c.assocId]||"", created:i.created };
      });
    const sectors   = [...new Set(items.map(i=>i.sector).filter(Boolean))].sort();
    const assocs    = [...new Set(o.associations.map(a=>a.name).filter(Boolean))].sort();
    const companies = [...new Set(items.map(i=>i.company).filter(Boolean))].sort();
    const assocI18n = {}; o.associations.forEach(a=>{ assocI18n[a.name] = C.orgNames(a); });
    return json(res,200,{ items, sectors, assocs, companies, assocI18n });
  }

  /* ---- DAVLAT XIZMATLARI: the state-service directory, kept by the admin ---- */
  if(pathname==="/api/gov-services" && req.method==="GET"){
    const items = C.getModules().items
      .filter(i => i.module==="govservice")
      .sort((a,b)=>(a.title||"").localeCompare(b.title||""))
      .map(i => ({ id:i.id, title:i.title||"", body:i.body||"", agency:i.status||"",
        link:i.link||"", category:i.amount||"" }));
    const categories = [...new Set(items.map(i=>i.category).filter(Boolean))].sort();
    const agencies   = [...new Set(items.map(i=>i.agency).filter(Boolean))].sort();
    return json(res,200,{ items, categories, agencies });
  }
  if(pathname==="/api/gov-services" && req.method==="POST"){
    const b = await readBody(req);
    if(!isAdmin(b.pass)) return json(res,403,{ error:"forbidden" });
    const M = C.getModules();
    const S=(v,n)=>String(v||"").slice(0,n);
    if(b.op==="add"){
      M.items.push({ id:C.uid("gs"), module:"govservice", ownerType:"admin", ownerId:"admin",
        ownerName:"Administrator", scope:"global",
        title:S(b.title,200),        // service name
        body:S(b.body,2000),         // what it is / how to use it
        status:S(b.agency,120),      // which state body provides it
        amount:S(b.category,80),     // grouping, e.g. Litsenziya / Soliq
        link:S(b.link,500),          // official page
        created:Date.now() });
      C.saveModules(M);
    } else if(b.op==="del"){
      M.items = M.items.filter(x => !(x.id===b.id && x.module==="govservice"));
      C.saveModules(M);
    }
    const items = M.items.filter(i=>i.module==="govservice")
      .map(i=>({ id:i.id, title:i.title, body:i.body, agency:i.status, link:i.link, category:i.amount }));
    return json(res,200,{ ok:true, items });
  }

  /* Showroom entries were stored as bare {name,price,desc,img} with no identity,
     so nothing could link to one. Give every entry a stable id the first time it
     is read and persist it — index position is not an identity, it shifts as
     soon as the company deletes a product. */
  function ensureShowroomIds(o){
    let added = 0;
    o.companies.forEach(c=>{
      (c.showroom||[]).forEach(p=>{ if(p && !p.id){ p.id = C.uid("sh"); added++; } });
    });
    if(added) C.saveOrgs(o);
    return o;
  }

  /* monument-bg.js used to probe seven hardcoded filenames and take seven 404s
     on every page load. It asks here instead, so an empty folder costs one
     request and dropping a photo in still lights the background up. */
  if(pathname==="/api/monuments" && req.method==="GET"){
    let files = [];
    try{
      files = fs.readdirSync(path.join(ROOT,"assets","monuments"))
        .filter(f => /\.(jpe?g|png|webp|avif)$/i.test(f))
        .sort()
        .map(f => "assets/monuments/" + f);
    }catch(e){}
    return json(res,200,{ files });
  }

  if(pathname==="/api/showroom" && req.method==="GET"){
    const o = ensureShowroomIds(C.getOrgs());
    const aById = {}; o.associations.forEach(a=>{ aById[a.id]=a.name; });
    const items = [];
    o.companies.forEach(c=>{
      (c.showroom||[]).forEach(p=>{
        if(!p || !(p.name || p.img)) return;
        items.push({ id:p.id, name:p.name||"", price:p.price||"", desc:p.desc||"", img:p.img||"",
          // items added before export/import existed are export offers — that is what the showroom was
          trade: p.trade === "import" ? "import" : "export",
          companyId:c.id, company:c.name||"", sector:c.sector||"", assoc:aById[c.assocId]||"" });
      });
    });
    // filter option lists cover ALL registered orgs (not only those that already have products)
    const sectors   = [...new Set(o.companies.map(c=>c.sector).filter(Boolean))].sort();
    const assocs    = [...new Set(o.associations.map(a=>a.name).filter(Boolean))].sort();
    const companies = [...new Set(o.companies.map(c=>c.name).filter(Boolean))].sort();
    // filtering matches on the canonical name; the label shown comes from this map
    const assocI18n = {}; o.associations.forEach(a=>{ assocI18n[a.name] = C.orgNames(a); });
    return json(res,200,{ items, sectors, assocs, assocI18n, companies, total:items.length });
  }

  /* ---- one showroom product, with the company behind it ---- */
  if(pathname==="/api/showroom/item" && req.method==="GET"){
    const o = ensureBizIds(ensureShowroomIds(C.getOrgs()));
    const id = String(query.id||"").slice(0,40);
    let product = null, company = null;
    for(const c of o.companies){
      const p = (c.showroom||[]).find(x => x && x.id === id);
      if(p){ product = p; company = c; break; }
    }
    if(!product) return json(res,404,{ error:"not_found" });
    const a = o.associations.find(x=>x.id===company.assocId);
    return json(res,200,{ ok:true,
      product:{ id:product.id, name:product.name||"", price:product.price||"", desc:product.desc||"",
        img:product.img||"", trade: product.trade==="import" ? "import" : "export" },
      company:{ id:company.id, bizId:company.bizId||"", name:company.name||"", sector:company.sector||"",
        assocId:company.assocId||"", assoc:a?a.name:"", assocI18n:a?C.orgNames(a):null,
        chairman:a?a.chairman:"", products:(company.showroom||[]).length,
        since:company.created||0 },
      more:(company.showroom||[]).filter(x=>x && x.id!==id && (x.name||x.img)).slice(0,6)
        .map(x=>({ id:x.id, name:x.name||"", price:x.price||"", img:x.img||"",
          trade: x.trade==="import" ? "import" : "export" })) });
  }

  if(pathname==="/api/assoc/public" && req.method==="GET"){
    const o = ensureBizIds(C.getOrgs());
    const a = o.associations.find(x=>x.id===query.id);
    if(!a) return json(res,404,{ error:"not found" });
    return json(res,200,{ assoc:{ id:a.id, bizId:a.bizId||"", name:a.name, i18n:C.orgNames(a), chairman:a.chairman },
      companies: o.companies.filter(c=>c.assocId===a.id)
        .map(c=>({ bizId:c.bizId||"", name:c.name, sector:c.sector, products:(c.showroom||[]).length })) });
  }

  /* ============================================================
     BUSINESS ID — the platform's public identity document.

     Every association and company carries a number, a card and a QR
     code. The card is deliberately open: it is the one surface a
     visitor can reach without an account, which is the whole point of
     handing out a business card. Nothing here is behind a login, so
     nothing here may read a password — the payloads are built by
     srv/business-id.js, which only ever copies whitelisted fields.
     ============================================================ */

  /* Numbers are handed out lazily, the same way showroom ids are. */
  function ensureBizIds(o){
    const r = BID.ensure(o);
    if(r.changed) C.saveOrgs(o);
    return o;
  }

  /* The absolute address of a card — what the QR encodes and what a
     visitor can paste anywhere. Honours a proxy's forwarded headers so
     the printed code still works behind one. */
  function cardUrl(id){
    const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim()
      || (req.socket && req.socket.encrypted ? "https" : "http");
    const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
    return host ? `${proto}://${host}/biznes-id.html?id=${encodeURIComponent(id)}` : `/biznes-id.html?id=${encodeURIComponent(id)}`;
  }

  if(pathname==="/api/business-id" && req.method==="GET"){
    const o = ensureBizIds(ensureShowroomIds(C.getOrgs()));
    const card = BID.card(o, query.id, C.orgNames);
    if(!card) return json(res,404,{ error:"not_found" });
    return json(res,200, Object.assign(card, { url: cardUrl(card.bizId) }));
  }

  /* Rendered server-side so the page stays dependency-free and the code
     is identical whether it is shown on screen, printed or scanned. */
  if(pathname==="/api/business-id/qr.svg" && req.method==="GET"){
    const o = ensureBizIds(C.getOrgs());
    const found = BID.holderOf(o, query.id);
    if(!found){ res.writeHead(404,{ "Content-Type":"text/plain" }); return res.end("not found"); }
    let svg = "";
    try{
      svg = await QR.toString(cardUrl(found.id), { type:"svg", margin:0,
        errorCorrectionLevel:"M", color:{ dark:"#1f4e79", light:"#00000000" } });
    }catch(e){ res.writeHead(500,{ "Content-Type":"text/plain" }); return res.end("qr failed"); }
    res.writeHead(200,{ "Content-Type":"image/svg+xml",
      "Cache-Control":"public, max-age=86400" });
    return res.end(svg);
  }

  /* Confirms a number is genuine without revealing anything a card
     would not already show. A malformed number never reaches a lookup. */
  if(pathname==="/api/business-id/verify" && req.method==="GET"){
    const o = ensureBizIds(C.getOrgs());
    const v = BID.verify(o, query.id);
    return json(res, v.ok ? 200 : 404, v.ok ? Object.assign(v, { url: cardUrl(v.bizId) }) : v);
  }

  if(pathname==="/api/business-id/directory" && req.method==="GET"){
    const o = ensureBizIds(C.getOrgs());
    return json(res,200,{ ok:true, items: BID.directory(o, C.orgNames) });
  }

  /* An org edits its own contact block — the only writable part of a
     card. Identity comes from the credentials, never from the body, so
     one org can never write another's card. */
  if(pathname==="/api/business-id/contact" && req.method==="POST"){
    const b = await readBody(req);
    const o = ensureBizIds(C.getOrgs());
    const assoc = authAssoc(o, b.login, b.password);
    const company = assoc ? null : C.findCompany(o, b.login, b.password);
    const row = assoc || company;
    if(!row) return json(res,401,{ error:"invalid credentials" });

    /* The kind decides which fields exist, and it comes from the credentials
       that matched — never from the request — so a caller cannot widen its
       own field set by claiming to be the other kind. */
    const kind = assoc ? "assoc" : "company";

    if(b.op === "get")
      return json(res,200,{ ok:true, bizId:row.bizId||"", kind, fields: BID.fieldsFor(kind),
        contact: BID.contactOf(row, kind), url: cardUrl(row.bizId||"") });

    const clean = BID.cleanContact(b, kind);
    if(clean.error) return json(res,400,{ error:clean.error });
    BID.applyContact(row, clean.value, kind);
    C.saveOrgs(o);
    return json(res,200,{ ok:true, bizId:row.bizId||"", kind, fields: BID.fieldsFor(kind),
      contact: BID.contactOf(row, kind), url: cardUrl(row.bizId||"") });
  }

  /* ---- public: one company's own page ----
     The platform had no public face for a company: a visitor could reach
     its products through the showroom filter, but a company with nothing
     listed yet was unreachable entirely. This is that page's data. It is
     deliberately thinner than the Business ID card — identity and what it
     sells, with the card one click away for contact details. */
  if(pathname==="/api/company/public" && req.method==="GET"){
    const o = ensureBizIds(ensureShowroomIds(C.getOrgs()));
    const id = String(query.id||"").slice(0,40);
    /* Reachable by internal id or by Business ID, so a scanned number and
       an in-site link land on the same page. */
    const byBiz = BID.holderOf(o, id);
    const c = (byBiz && byBiz.kind === "company") ? byBiz.row : o.companies.find(x=>x.id===id);
    if(!c) return json(res,404,{ error:"not_found" });
    const a = o.associations.find(x=>x.id===c.assocId) || null;
    return json(res,200,{ ok:true,
      company:{ id:c.id, bizId:c.bizId||"", name:c.name||"", sector:c.sector||"",
        since:c.created||0, products:(c.showroom||[]).length },
      assoc: a ? { id:a.id, bizId:a.bizId||"", name:a.name||"", i18n:C.orgNames(a),
        chairman:a.chairman||"" } : null,
      showroom:(c.showroom||[]).filter(p=>p && (p.name||p.img))
        .map(p=>({ id:p.id||"", name:p.name||"", price:p.price||"", desc:p.desc||"",
          img:p.img||"", trade: p.trade==="import" ? "import" : "export" })) });
  }

  /* ---- association panel: login + manage own companies ---- */
  if(pathname==="/api/assoc/login" && req.method==="POST"){
    const { login, password } = await readBody(req);
    const o = C.getOrgs();
    const a = authAssoc(o, login, password);
    if(!a) return json(res,401,{ error:"invalid credentials" });
    const comps = o.companies.filter(c=>c.assocId===a.id)
      .map(c=>({ id:c.id, name:c.name, sector:c.sector, login:c.login, showroom:c.showroom||[], created:c.created||null }));
    return json(res,200,{ ok:true, assoc:{ id:a.id, name:a.name, i18n:C.orgNames(a), chairman:a.chairman }, companies:comps });
  }
  if(pathname==="/api/assoc/companies" && req.method==="POST"){
    const b = await readBody(req);
    const o = C.getOrgs();
    const a = authAssoc(o, b.login, b.password);
    if(!a) return json(res,401,{ error:"invalid credentials" });
    const S=(v,n)=>String(v||"").slice(0,n);
    if(b.op==="add"){
      const clogin=S(b.clogin,60).trim();
      if(!clogin||!b.cpassword) return json(res,400,{ error:"login & password required" });
      if(o.companies.some(c=>c.login===clogin)) return json(res,409,{ error:"login exists" });
      o.companies.push(PW.set({ id:C.uid("c"), name:S(b.name,200), assocId:a.id, sector:S(b.sector,120),
        login:clogin, showroom:[], created:Date.now() }, S(b.cpassword,120)));
    } else if(b.op==="del"){
      const c=o.companies.find(x=>x.id===b.id);
      if(c && c.assocId===a.id) o.companies=o.companies.filter(x=>x.id!==b.id);
    } else if(b.op==="pw"){
      /* Replaces the old "read the member's password off the panel" feature.
         Nobody can read a hash, so the only way to help a member who has lost
         their password is to issue a new one. It is returned exactly once, in
         this response, and never again: the store keeps only the hash. */
      const c=o.companies.find(x=>x.id===b.id);
      if(!c || c.assocId!==a.id) return json(res,404,{ error:"not_found" });
      const fresh = S(b.cpassword,120).trim() || PW.generate();
      if(fresh.length < 8) return json(res,400,{ error:"password_short" });
      PW.set(c, fresh);
      C.saveOrgs(o);
      return json(res,200,{ ok:true, id:c.id, login:c.login, password:fresh, once:true });
    } else {
      return json(res,400,{ error:"unknown op" });
    }
    C.saveOrgs(o);
    const comps = o.companies.filter(c=>c.assocId===a.id)
      .map(c=>({ id:c.id, name:c.name, sector:c.sector, login:c.login, showroom:c.showroom||[], created:c.created||null }));
    return json(res,200,{ ok:true, companies:comps });
  }
  /* ---- Super Admin: questions ONLY from its own companies ---- */
  if(pathname==="/api/assoc/questions" && req.method==="POST"){
    const b = await readBody(req);
    const a = authAssoc(C.getOrgs(), b.login, b.password);
    if(!a) return json(res,401,{ error:"invalid credentials" });
    return json(res,200, C.assocQuestions(a.id, b.ym||""));
  }
  /* ---- Super Admin: official AI letter for one of ITS OWN companies ---- */
  if(pathname==="/api/assoc/letter" && req.method==="POST"){
    const b = await readBody(req);
    const a = authAssoc(C.getOrgs(), b.login, b.password);
    if(!a) return json(res,401,{ error:"invalid credentials" });
    const key = String(b.key||"");
    if(!C.assocOwnsCompany(a.id, key)) return json(res,403,{ error:"not your company" });
    const questions = C.userQuestions("company", key, b.ym||"");
    const body = await C.generateLetter({ recipient:key, questions, lang:b.lang||"uz" });
    return json(res,200,{ ok:true, letter:{ recipientLabel:key, recipientType:"company", body } });
  }
  /* ---- Super Admin: monthly report preview (own companies) ---- */
  if(pathname==="/api/assoc/report" && req.method==="POST"){
    const b = await readBody(req);
    const o = C.getOrgs();
    const a = authAssoc(o, b.login, b.password);
    if(!a) return json(res,401,{ error:"invalid credentials" });
    const months = C.assocQuestions(a.id, "").months;
    const ym = b.ym || months[0] || "";
    const data = C.assocReportData(ym).find(x=>x.id===a.id) || { companies:[], companyCount:0, questions:0 };
    return json(res,200,{ ym, months, assoc:C.orgName(a, b.lang), assocI18n:C.orgNames(a),
      companyCount:data.companyCount, questions:data.questions,
      companies:(data.companies||[]).map(c=>({ name:c.name, questions:c.questions, products:c.products })) });
  }
  /* ---- Super Admin: monthly report Word download (own companies) ---- */
  if(pathname==="/api/assoc/report.doc"){
    const o = C.getOrgs();
    const a = authAssoc(o, query.login, query.password);
    if(!a){ res.writeHead(401,{ "Content-Type":"text/plain" }); return res.end("invalid credentials"); }
    const doc = await C.assocReportOne(a.id, query.ym||"", { force: query.fresh==="1" });
    res.writeHead(200,{ "Content-Type":"application/msword",
      "Content-Disposition":`attachment; filename="${String(a.name||"uyushma").toLowerCase().replace(/[^a-z0-9]+/g,"-").slice(0,40)}-${(query.ym||"all").replace(/[^0-9a-zA-Z-]/g,"")}.doc"` });
    return res.end(doc);
  }
  /* ============================================================
     HUKUMATGA MUROJAAT — a company writes it, its association passes
     it up, the rais sends it on. Each panel only reaches its own slice.
     ============================================================ */
  /* company: file an appeal / see its own */
  if(pathname==="/api/company/appeal" && req.method==="POST"){
    const b = await readBody(req);
    const o = C.getOrgs();
    const c = C.findCompany(o, b.login, b.password);
    if(!c) return json(res,401,{ error:"invalid credentials" });
    if(b.op==="list") return json(res,200,{ ok:true, items: C.appealList({ companyId:c.id }), agencies:C.APPEAL_AGENCIES });
    const subject = String(b.subject||"").trim(), body = String(b.body||"").trim();
    if(!subject || !body) return json(res,400,{ error:"subject_and_body_required" });
    const a = o.associations.find(x=>x.id===c.assocId);
    const item = C.appealAdd({ companyId:c.id, companyName:c.name, assocId:c.assocId,
      assocName:a?a.name:"", agency:b.agency, subject, body });
    return json(res,200,{ ok:true, item, items: C.appealList({ companyId:c.id }) });
  }
  /* association: its member companies' appeals, and moving them along */
  if(pathname==="/api/assoc/appeals" && req.method==="POST"){
    const b = await readBody(req);
    const a = authAssoc(C.getOrgs(), b.login, b.password);
    if(!a) return json(res,401,{ error:"invalid credentials" });
    if(b.op==="stage"){
      const target = C.appealFind(b.id);
      if(!target || target.assocId !== a.id) return json(res,403,{ error:"forbidden" });   // only its own members'
      C.appealSetStage(b.id, b.stage, { name:a.chairman||a.name, type:"assoc" }, b.note);
    }
    return json(res,200,{ ok:true, items: C.appealList({ assocId:a.id }), stages:C.APPEAL_STAGES });
  }
  /* rais / admin: everything, from every association */
  if(pathname==="/api/appeals" && req.method==="POST"){
    const b = await readBody(req);
    const o = C.getOrgs();
    const isRais = raisAuth(o, b.login, b.password);
    if(!isAdmin(b.pass) && !isRais) return json(res,403,{ error:"forbidden" });
    if(b.op==="stage") C.appealSetStage(b.id, b.stage, { name:isRais?"Rais":"Administrator", type:isRais?"rais":"admin" }, b.note);
    return json(res,200,{ ok:true, items: C.appealList({ assocId:b.assocId||"" }), stages:C.APPEAL_STAGES });
  }
  /* the AI drafts the formal wording from a sentence of context */
  if(pathname==="/api/appeal/draft" && req.method==="POST"){
    const b = await readBody(req);
    const o = C.getOrgs();
    const actor = resolveActor(o, b);
    if(!actor) return json(res,401,{ error:"invalid credentials" });
    const c = actor.type==="company" ? C.findCompany(o, b.login, b.password) : null;
    const assoc = c ? o.associations.find(x=>x.id===c.assocId) : null;
    const text = await C.appealDraft({ company:c?c.name:actor.name, assoc:assoc?assoc.name:"",
      agency:b.agency, subject:b.subject, hint:b.hint, lang:b.lang });
    if(!text) return json(res,200,{ ok:false, error:"ai_unavailable" });
    return json(res,200,{ ok:true, text });
  }
  /* the finished appeal as an official Word letter */
  if(pathname==="/api/appeal/doc"){
    const o = C.getOrgs();
    const item = C.appealFind(String(query.id||""));
    if(!item){ res.writeHead(404,{ "Content-Type":"text/plain" }); return res.end("not found"); }
    const c = C.findCompany(o, query.login, query.password);
    const a = authAssoc(o, query.login, query.password);
    const isRais = raisAuth(o, query.login, query.password);
    const allowed = isAdmin(query.pass) || isRais
      || (c && c.id===item.companyId) || (a && a.id===item.assocId);
    if(!allowed){ res.writeHead(401,{ "Content-Type":"text/plain" }); return res.end("invalid credentials"); }
    const name = String(item.subject||"murojaat").toLowerCase().replace(/[^a-z0-9]+/g,"-").slice(0,40) || "murojaat";
    res.writeHead(200,{ "Content-Type":"application/msword",
      "Content-Disposition":`attachment; filename="${name}-${item.id.slice(-6)}.doc"` });
    return res.end(C.appealDoc(item));
  }

  /* ---- Super Admin: news feed — platform-wide + its own sphere ---- */
  if(pathname==="/api/assoc/news" && req.method==="POST"){
    const b = await readBody(req);
    const a = authAssoc(C.getOrgs(), b.login, b.password);
    if(!a) return json(res,401,{ error:"invalid credentials" });
    const items = await C.newsFeed({ assoc:a.name, assocLabel:C.orgName(a, b.lang), lang:b.lang });
    return json(res,200,{ ok:true, sphere:C.orgName(a, b.lang), items });
  }
  /* ---- Super Admin: manage its own online meetings (its companies see them) ---- */
  if(pathname==="/api/assoc/conference" && req.method==="POST"){
    const b = await readBody(req);
    const a = authAssoc(C.getOrgs(), b.login, b.password);
    if(!a) return json(res,401,{ error:"invalid credentials" });
    if(b.op==="list") return json(res,200,{ ok:true, meetings: C.confList(a.id), google: G.status() });
    if(b.removeId){ await dropMeet(b.removeId, a.id); C.confRemove(a.id, b.removeId); return json(res,200,{ ok:true, meetings: C.confList(a.id) }); }
    // an association may only re-link its own meetings
    if(b.relinkId){
      const own = C.confList(a.id).some(m=>m.id===b.relinkId);
      if(!own) return json(res,403,{ error:"forbidden" });
      return json(res,200, await relinkMeeting(a.id, b.relinkId));
    }
    if(!String(b.title||"").trim()) return json(res,400,{ error:"title_required" });
    const meeting = C.confAdd(a.id, await withMeet(b));
    return json(res,200,{ ok:true, meeting, meetings: C.confList(a.id), google: G.status() });
  }

  /* ---- company panel auth + showroom ---- */
  if(pathname==="/api/company/login" && req.method==="POST"){
    const { login, password } = await readBody(req);
    const o = C.getOrgs();
    const c = C.findCompany(o, login, password);
    if(!c) return json(res,401,{ error:"invalid credentials" });
    const a = o.associations.find(x=>x.id===c.assocId);
    return json(res,200,{ ok:true, company:{ id:c.id, name:c.name, sector:c.sector, assocId:c.assocId||"",
      assocName:a?a.name:"", assocI18n:a?C.orgNames(a):null,
      assocChairman:a?a.chairman:"", showroom:c.showroom||[], bizrows:c.bizrows||[] } });
  }
  /* ---- company: upload showroom photo (any format) ---- */
  if(pathname==="/api/upload" && req.method==="POST"){
    const b = await readBody(req);
    const o = C.getOrgs();
    const c = C.findCompany(o, b.login, b.password);
    if(!c) return json(res,401,{ error:"invalid credentials" });
    const data = String(b.data||"");
    if(!data || data.length > 9_000_000) return json(res,400,{ error:"bad image" });
    const mime = String(b.mime||"");
    const ext = mime.includes("png")?"png": mime.includes("webp")?"webp": mime.includes("gif")?"gif":"jpg";
    const dir = path.join(ROOT, "uploads"); fs.mkdirSync(dir, { recursive:true });
    const name = C.uid("img")+"."+ext;
    try{ fs.writeFileSync(path.join(dir,name), Buffer.from(data,"base64")); }
    catch(e){ return json(res,500,{ error:"write failed" }); }
    return json(res,200,{ ok:true, url:"/uploads/"+name });
  }

  /* ---- company modules: invest projects / R&D ----
     News is deliberately absent: nobody publishes news by hand, it is
     searched from the web (see /api/company/news). */
  if(pathname==="/api/company/items" && req.method==="POST"){
    const b = await readBody(req);
    const o = C.getOrgs();
    const c = C.findCompany(o, b.login, b.password);
    if(!c) return json(res,401,{ error:"invalid credentials" });
    const mod = String(b.module||"");
    if(!["invest","rnd","service"].includes(mod)) return json(res,400,{ error:"bad module" });
    const M = C.getModules();
    const S=(v,n)=>String(v||"").slice(0,n);
    if(b.op==="add"){
      M.items.push({ id:C.uid("it"), module:mod, ownerType:"company", ownerId:c.id, ownerName:c.name,
        scope:"company", title:S(b.title,200), body:S(b.body,2000), amount:S(b.amount,60),
        link:S(b.link,500), status:S(b.status,40), created:Date.now() });
      C.saveModules(M);
    } else if(b.op==="del"){
      const it=M.items.find(x=>x.id===b.id);
      if(it && it.ownerType==="company" && it.ownerId===c.id){ M.items=M.items.filter(x=>x.id!==b.id); C.saveModules(M); }
    }
    const items = M.items.filter(x=>x.module===mod && x.ownerType==="company" && x.ownerId===c.id)
                         .sort((a,b2)=>b2.created-a.created);
    return json(res,200,{ ok:true, items });
  }

  /* ---- company: official letters addressed to this company ---- */
  if(pathname==="/api/company/letters" && req.method==="POST"){
    const { login, password } = await readBody(req);
    const o = C.getOrgs();
    const c = C.findCompany(o, login, password);
    if(!c) return json(res,401,{ error:"invalid credentials" });
    return json(res,200,{ ok:true, letters: C.lettersFor("company", c.name) });
  }

  if(pathname==="/api/company/showroom" && req.method==="POST"){
    const { login, password, items } = await readBody(req);
    const o = C.getOrgs();
    const c = C.findCompany(o, login, password);
    if(!c) return json(res,401,{ error:"invalid credentials" });
    const S=(v,n)=>String(v||"").slice(0,n);
    c.showroom = Array.isArray(items) ? items.slice(0,200).map(it=>({
      name:S(it.name,120), price:S(it.price,40), desc:S(it.desc,600), img:S(it.img,1000),
      // export = sold abroad, import = wanted from abroad; anything else is an export offer
      trade: it.trade === "import" ? "import" : "export" })) : [];
    C.saveOrgs(o);
    return json(res,200,{ ok:true, showroom:c.showroom });
  }
  /* ---- admin/rais: all companies' startup/invest projects ---- */
  if(pathname==="/api/admin/projects" && req.method==="POST"){
    const b = await readBody(req); const o = C.getOrgs();
    if(!(isAdmin(b.pass) || raisAuth(o, b.login, b.password))) return json(res,403,{ error:"forbidden" });
    return json(res,200,{ ok:true, projects: C.investProjects() });
  }
  /* ---- group chats: one room per association, plus the chairmen's room ----
     A single endpoint serves all three roles. Who the caller is decides
     which rooms they see, so membership is never taken from the request. */
  if(pathname==="/api/group" && req.method==="POST"){
    const b = await readBody(req); const o = C.getOrgs();
    const actor = resolveActor(o, b);
    if(!actor) return json(res,401,{ error:"invalid credentials" });
    const me = { type:actor.type, id:actor.id, name:actor.name };

    if(b.op==="list")
      return json(res,200,{ ok:true, me, groups: adminRooms(o, actor, b.lang).concat(C.groupsFor(actor, b.lang)) });

    /* The company↔admin thread predates the group chat and lives in its own
       store, which the admin panel still reads. Rather than migrate it, it is
       presented here as one more room: same list, same bubbles, same composer,
       but reads and writes go to the original store. */
    if(String(b.group||"").startsWith(ADMIN_ROOM)){
      const cid = String(b.group).slice(ADMIN_ROOM.length);
      if(!adminRoomAllows(actor, cid)) return json(res,403,{ error:"not a member of this group" });
      if(b.op==="send"){
        let att = null;
        if(b.attach){ att = C.saveAttachment(b.attach); if(att.error) return json(res,400,{ error:att.error }); }
        if(!String(b.text||"").trim() && !att) return json(res,400,{ error:"empty message" });
        C.chatSend(cid, actor.type==="company" ? "company" : "admin", b.text, att);
      }
      /* edit / react / delete / read have no counterpart in that store; the
         thread is returned unchanged rather than pretending they applied. */
      return json(res,200,{ ok:true, me, messages: adminRoomThread(o, cid) });
    }

    const gid = C.canonicalGroupId(b.group);   // a DM pair sorts to one room
    if(!C.groupAllows(actor, gid)) return json(res,403,{ error:"not a member of this group" });

    if(b.op==="send"){
      // a message needs text OR an attachment — an empty one is dropped
      let att = null;
      if(b.attach){
        att = C.saveAttachment(b.attach);
        if(att.error) return json(res,400,{ error:att.error });
      }
      if(!String(b.text||"").trim() && !att) return json(res,400,{ error:"empty message" });
      return json(res,200,{ ok:true, me, messages: C.groupSend(gid, actor, b.text, att) });
    }
    return json(res,200,{ ok:true, me, messages: C.groupThread(gid) });
  }
  /* ---- project chat: company side ---- */
  if(pathname==="/api/company/chat" && req.method==="POST"){
    const b = await readBody(req); const o = C.getOrgs();
    const c = C.findCompany(o, b.login, b.password);
    if(!c) return json(res,401,{ error:"invalid credentials" });
    if(b.op==="send"){
      let att=null;
      if(b.attach){ att=C.saveAttachment(b.attach); if(att.error) return json(res,400,{ error:att.error }); }
      if(String(b.text||"").trim() || att) C.chatSend(c.id, "company", b.text, att);
    }
    return json(res,200,{ ok:true, messages: C.chatThread(c.id) });
  }
  /* ---- project chat: admin/rais side ---- */
  if(pathname==="/api/admin/chats" && req.method==="POST"){
    const b = await readBody(req); const o = C.getOrgs();
    if(!(isAdmin(b.pass) || raisAuth(o, b.login, b.password))) return json(res,403,{ error:"forbidden" });
    if(b.op==="thread") return json(res,200,{ ok:true, messages: C.chatThread(b.companyId) });
    if(b.op==="send"){
      let att=null;
      if(b.attach){ att=C.saveAttachment(b.attach); if(att.error) return json(res,400,{ error:att.error }); }
      if(String(b.text||"").trim() || att) return json(res,200,{ ok:true, messages: C.chatSend(b.companyId, "admin", b.text, att) });
    }
    return json(res,200,{ ok:true, chats: C.chatList() });
  }
  /* ---- company: layered news feed — platform-wide + its association's sphere + its own sector ---- */
  if(pathname==="/api/company/news" && req.method==="POST"){
    const { login, password, lang } = await readBody(req);
    const o = C.getOrgs();
    const c = C.findCompany(o, login, password);
    if(!c) return json(res,401,{ error:"invalid credentials" });
    const a = o.associations.find(x=>x.id===c.assocId);
    const items = await C.newsFeed({ sector:c.sector, assoc:a?a.name:"",
      assocLabel:a?C.orgName(a, lang):"", lang });
    return json(res,200,{ ok:true, sector:c.sector||"", assoc:a?C.orgName(a, lang):"", items });
  }
  /* ---- company: sales / product-composition data table (manual input) ---- */
  if(pathname==="/api/company/data" && req.method==="POST"){
    const { login, password, rows } = await readBody(req);
    const o = C.getOrgs();
    const c = C.findCompany(o, login, password);
    if(!c) return json(res,401,{ error:"invalid credentials" });
    const S=(v,n)=>String(v||"").slice(0,n);
    c.bizrows = Array.isArray(rows) ? rows.slice(0,200).map(r=>({
      product:S(r.product,160), sales:S(r.sales,60), price:S(r.price,60), composition:S(r.composition,400), note:S(r.note,400) })) : [];
    C.saveOrgs(o);
    return json(res,200,{ ok:true, rows:c.bizrows });
  }
  /* ---- company: AI analysis of the sales/product data table ---- */
  if(pathname==="/api/company/analyze" && req.method==="POST"){
    const { login, password, lang } = await readBody(req);
    const o = C.getOrgs();
    const c = C.findCompany(o, login, password);
    if(!c) return json(res,401,{ error:"invalid credentials" });
    const rows = c.bizrows||[];
    if(!rows.length) return json(res,200,{ ok:true, analysis:"" });
    const LN = { uz:"Uzbek", ru:"Russian", en:"English" }[lang] || "Uzbek";
    const table = rows.map((r,i)=>`${i+1}) Mahsulot: ${r.product||"—"} | Sotuv: ${r.sales||"—"} | Narx: ${r.price||"—"} | Tarkib: ${r.composition||"—"} | Izoh: ${r.note||"—"}`).join("\n");
    const sys = `You are "TIJORAT MARKAZI", a business analyst. Analyze the company's sales & product-composition table and produce a concise, structured analysis in ${LN}.
Cover, as short paragraphs or bullets: (1) overall sales picture and notable trends; (2) best- and worst-performing products; (3) an observation about product composition/quality; (4) 2-3 concrete, practical recommendations. Use ONLY the data given; do not invent numbers. Keep it under ~220 words.`;
    const userText = `Company: ${c.name}\nSector: ${c.sector||"—"}\nData table:\n${table}`;
    const analysis = C.geminiRaw ? await C.geminiRaw(sys, userText) : null;
    return json(res,200,{ ok:true, analysis: analysis || "" });
  }

  /* ---- admin: monthly organizations report (preview + Word) ---- */
  if(pathname==="/api/monthly" && req.method==="GET"){
    return json(res,200, C.monthlyReportData(query.ym||""));
  }
  if(pathname==="/api/monthly.doc"){
    const out = await C.monthlyReportDoc(query.ym||"", { force: query.fresh==="1" });
    res.writeHead(200,{ "Content-Type":"application/msword",
      "Content-Disposition":`attachment; filename="tijorat-markazi-oylik-hisobot-${(query.ym||"all").replace(/[^0-9a-zA-Z-]/g,"")}.doc"` });
    return res.end(out);
  }

  /* ---- admin: per-association reports (one Word file per uyushma) ---- */
  if(pathname==="/api/assoc-reports" && req.method==="GET"){
    const reports = await C.assocReports(query.ym||"", { force:false });
    return json(res,200, { ym: query.ym||"all",
      reports: reports.map(r=>({ id:r.id, assoc:r.assoc, companyCount:r.companyCount, questions:r.questions, filename:r.filename })) });
  }
  if(pathname==="/api/assoc.doc"){
    const reports = await C.assocReports(query.ym||"", { force: query.fresh==="1" });
    const rep = reports.find(r=>r.id===query.id || r.assoc===query.id);
    if(!rep){ res.writeHead(404,{ "Content-Type":"text/plain" }); return res.end("no report for this association"); }
    res.writeHead(200,{ "Content-Type":"application/msword",
      "Content-Disposition":`attachment; filename="${rep.filename}"` });
    return res.end(rep.doc);
  }

  if(pathname==="/api/problems.doc"){
    const out = C.problemsDocHtml(query.email);
    res.writeHead(200,{ "Content-Type":"application/msword", "Content-Disposition":'attachment; filename="konglomerat-murojaatlar.doc"' });
    return res.end(out);
  }
  return json(res,404,{ error:"not found" });
}

/* ---------- static ---------- */
const MIME={ ".webm":"audio/webm",".ogg":"audio/ogg",".mp3":"audio/mpeg",".m4a":"audio/mp4",".wav":"audio/wav",".mp4":"video/mp4",".pdf":"application/pdf",".zip":"application/zip",".docx":"application/vnd.openxmlformats-officedocument.wordprocessingml.document",".xlsx":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",".xls":"application/vnd.ms-excel",".txt":"text/plain; charset=utf-8",".csv":"text/csv",".bin":"application/octet-stream",".html":"text/html; charset=utf-8",".css":"text/css",".js":"text/javascript",".json":"application/json",".doc":"application/msword",".svg":"image/svg+xml",".png":"image/png",".ico":"image/x-icon",".jpg":"image/jpeg",".jpeg":"image/jpeg",".webp":"image/webp",".gif":"image/gif" };
/* ---- what the static server must never hand out ----
   Everything in the project root was reachable over HTTP: anthropic.key,
   credentials.txt and data/orgs.json (every login and password in plain
   text) all answered 200. The site is a flat folder of pages next to the
   backend, so the fix is an explicit denylist rather than a public/ move,
   which would mean rewriting every page path. */
const PRIVATE_DIRS  = ["data", "srv", "node_modules", "backups", ".git", ".claude", "telegram bot"];
const PRIVATE_FILES = new Set(["server.js","core.js","db.js","claude.js","ws.js","meet-bot.js",
  "google-meet.js","setup-google.js","package.json","package-lock.json"]);
function isPrivatePath(rel){
  const parts = rel.split(/[\\/]+/).filter(Boolean);
  if(!parts.length) return false;
  if(PRIVATE_DIRS.includes(parts[0])) return true;
  const name = parts[parts.length-1].toLowerCase();
  if(parts.length === 1 && PRIVATE_FILES.has(parts[0])) return true;
  return name.endsWith(".key") || name.startsWith("credentials.") || name.startsWith(".env");
}

function serveStatic(res, pathname){
  let f = pathname==="/" ? "/index.html" : pathname;
  const p = path.join(ROOT, decodeURIComponent(f));
  if(!p.startsWith(ROOT)){ res.writeHead(403); return res.end("403"); }
  if(isPrivatePath(path.relative(ROOT, p))){
    res.writeHead(404,{ "Content-Type":"text/html" }); return res.end("404 — not found");
  }
  fs.readFile(p,(e,d)=>{ if(e){ res.writeHead(404,{ "Content-Type":"text/html" }); return res.end("404 — not found"); }
    const ext = path.extname(p);
    // never cache the app shell (html/js/css) so every visitor always gets the latest version
    const noCache = ext===".html"||ext===".js"||ext===".css";
    const headers = { "Content-Type": MIME[ext]||"text/plain" };
    if(noCache) headers["Cache-Control"]="no-store, no-cache, must-revalidate, max-age=0";
    res.writeHead(200, headers); res.end(d); });
}

let HTTPS_READY = false;

/* A page served over http:// on a LAN address is not a secure context,
   so the browser deletes navigator.mediaDevices entirely and voice
   messages become impossible. Rather than explain that to every user,
   move them to the secure address. localhost is already a secure
   context and is left alone. */
function redirectToHttps(req, res){
  if(!HTTPS_READY || req.socket.encrypted) return false;
  const host = String(req.headers.host||"").split(":")[0];
  if(!host || host === "localhost" || host === "127.0.0.1" || host === "::1") return false;
  res.writeHead(302, { Location: "https://" + host + ":" + HTTPS_PORT + req.url });
  res.end();
  return true;
}

const handler = async (req,res)=>{
  const u = url.parse(req.url, true);
  /* Only PAGES need the secure context. The mobile app is not a browser:
     bouncing its API and image requests to the self-signed certificate
     makes every one of them fail, so those two prefixes stay on http. */
  const isClientData = u.pathname.startsWith("/api/") || u.pathname.startsWith("/uploads/");
  if(!isClientData && redirectToHttps(req,res)) return;
  if(u.pathname.startsWith("/api/")){ try{ await handleApi(req,res,u.pathname,u.query); }catch(e){ console.error(e); json(res,500,{ error:"server error" }); } return; }
  serveStatic(res, u.pathname);
};

/* ---------- self-signed HTTPS (mic on mobile needs HTTPS) ---------- */
/** Every address this machine can be reached on, for the certificate. */
function localAddresses(){
  const nets = require("os").networkInterfaces();
  const out = [];
  Object.keys(nets).forEach(n => (nets[n]||[]).forEach(i => {
    if(i.family === "IPv4" && !i.internal) out.push(i.address);
  }));
  return out;
}

/* A certificate with no subjectAltName is rejected outright by every
   current browser — CN alone has not been accepted for years. The old
   one had only "CN=TIJORAT MARKAZI", so opening the site by IP failed
   before the page even loaded, which is why voice never worked off
   localhost. This regenerates it with localhost and every LAN address
   listed, and re-issues whenever those addresses change. */
function ensureCert(){
  const keyF=path.join(C.DATA,"key.pem"), crtF=path.join(C.DATA,"cert.pem");
  const stampF=path.join(C.DATA,"cert-hosts.txt");
  const ips = localAddresses();
  const want = ["localhost","127.0.0.1"].concat(ips).join(",");
  try{
    let stale = true;
    try{ stale = fs.readFileSync(stampF,"utf8").trim() !== want; }catch(e){}
    if(stale || !fs.existsSync(keyF) || !fs.existsSync(crtF)){
      const san = ["DNS:localhost","IP:127.0.0.1"].concat(ips.map(a=>"IP:"+a)).join(",");
      const cnfF = path.join(C.DATA,"cert.cnf");
      fs.writeFileSync(cnfF,
        "[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n" +
        "[dn]\nCN=TIJORAT MARKAZI\n" +
        "[v3]\nsubjectAltName=" + san + "\nbasicConstraints=CA:FALSE\n" +
        "keyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n");
      execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout "${keyF}" -out "${crtF}" -days 825 -config "${cnfF}"`,{stdio:"ignore"});
      fs.writeFileSync(stampF, want);
      console.log("  TLS    → certificate issued for: " + want);
    }
    return { key:fs.readFileSync(keyF), cert:fs.readFileSync(crtF) };
  }catch(e){ return null; }
}

/* ---------- monthly auto-report: archive Word at month end + optional Telegram to rais ---------- */
function ymNow(){ const d=new Date(); return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0"); }
function readTgToken(){
  if(process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN.trim();
  try{ return fs.readFileSync(path.join(ROOT,"telegram bot","telegram.key"),"utf8").trim(); }catch(e){ return ""; }
}
async function sendDocToRais(token, chat, caption, filename, doc){
  try{
    const form = new FormData();
    form.append("chat_id", String(chat));
    form.append("caption", caption);
    form.append("document", new Blob([doc], { type:"application/msword" }), filename);
    const r = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method:"POST", body:form });
    const j = await r.json(); return !!j.ok;
  }catch(e){ console.error("rais TG send:", e.message); return false; }
}
async function autoArchiveReports(){
  try{
    const reportsRoot = path.join(C.DATA, "reports"); fs.mkdirSync(reportsRoot, { recursive:true });
    const cur = ymNow();
    const token = readTgToken();
    const o = C.getOrgs();
    const chat = process.env.RAIS_TG_CHAT || (o.rais && o.rais.tgChat);
    for(const ym of C.questionMonths()){
      if(ym===cur) continue;                                  // never archive the still-running month
      const dir = path.join(reportsRoot, ym);
      if(fs.existsSync(path.join(dir, ".sent"))) continue;     // already archived + sent
      fs.mkdirSync(dir, { recursive:true });
      // one SEPARATE Word file per association (uyushma), each with letters from its child companies
      const reports = await C.assocReports(ym);
      let sent = 0;
      for(const rep of reports){
        fs.writeFileSync(path.join(dir, rep.filename), rep.doc);
        if(token && chat){
          const ok = await sendDocToRais(token, chat, `📩 ${rep.assoc} — ${ym} (a'zo kompaniyalar murojaatlari: ${rep.companyCount})`, rep.filename, rep.doc);
          if(ok) sent++;
        }
      }
      if(token && chat) fs.writeFileSync(path.join(dir, ".sent"), String(Date.now())); // mark month done only if delivery attempted
      console.log(`  📋 Auto-archived ${ym}: ${reports.length} association file(s)${(token&&chat)?` · ${sent} sent to rais (Telegram)`:" · TG skipped (no token/chat)"}`);
    }
  }catch(e){ console.error("autoArchiveReports:", e.message); }
}

/* ============================================================
   REALTIME — the chat over a WebSocket

   Polling every ten seconds is what made messages feel slow. The
   socket carries the same operations the REST endpoint does, and the
   REST endpoint stays as the fallback for a client that cannot open
   one. Every operation is re-authorised here: a live socket proves
   who you are, never what you may do.
   ============================================================ */
const WS = require("./ws");

function wsAllowed(conn, gid){
  return conn.data.actor && C.groupAllows(conn.data.actor, gid);
}

function attachRealtime(httpServer){
  const hub = WS.attach(httpServer, {
    path: "/ws",
    onMessage(conn, m){
      if(!m || typeof m !== "object") return;

      /* the first frame must authenticate; nothing else is accepted
         until it does */
      if(m.op === "auth"){
        const actor = resolveActor(C.getOrgs(), m);
        if(!actor) return conn.send({ op:"auth", ok:false });
        conn.data.actor = actor;
        conn.data.rooms = C.groupsFor(actor).map(g => g.id);
        return conn.send({ op:"auth", ok:true,
          me:{ type:actor.type, id:actor.id, name:actor.name }, rooms: conn.data.rooms });
      }
      const actor = conn.data.actor;
      if(!actor) return conn.send({ op:"error", error:"not authenticated" });

      const gid = C.canonicalGroupId(m.group || "");
      if(m.op !== "typing" && !wsAllowed(conn, gid)) return conn.send({ op:"error", error:"forbidden" });

      const toRoom = (payload) => hub.broadcast(payload, c => wsAllowed(c, gid));

      if(m.op === "send"){
        let att = null;
        if(m.attach){ att = C.saveAttachment(m.attach); if(att.error) return conn.send({ op:"error", error:att.error }); }
        if(!String(m.text||"").trim() && !att) return;
        const arr = C.groupSend(gid, actor, m.text, att, m.reply);
        return toRoom({ op:"new", group:gid, msg: arr[arr.length-1] });
      }
      if(m.op === "edit"){
        const r = C.groupEdit(gid, actor, m.id, m.text);
        if(r.error) return conn.send({ op:"error", error:r.error });
        return toRoom({ op:"edit", group:gid, msg:r.msg });
      }
      if(m.op === "delete"){
        const r = C.groupDelete(gid, actor, m.id);
        if(r.error) return conn.send({ op:"error", error:r.error });
        return toRoom({ op:"delete", group:gid, msg:r.msg });
      }
      if(m.op === "react"){
        const r = C.groupReact(gid, actor, m.id, m.emoji);
        if(r.error) return conn.send({ op:"error", error:r.error });
        return toRoom({ op:"react", group:gid, msg:r.msg });
      }
      if(m.op === "read"){
        const r = C.groupRead(gid, actor, m.id);
        if(!r.ids.length) return;
        return toRoom({ op:"read", group:gid, ids:r.ids,
          by:{ id:actor.id, name:actor.name } });
      }
      if(m.op === "typing"){
        if(!wsAllowed(conn, gid)) return;
        // typing is never stored; it goes to everyone else in the room
        return hub.broadcast({ op:"typing", group:gid, who:actor.name, id:actor.id },
          c => c !== conn && wsAllowed(c, gid));
      }
    }
  });
  return hub;
}

/* ---------- start ---------- */
const httpServer = http.createServer(handler);
attachRealtime(httpServer);

/* The database must be up before the first request can land, otherwise an
   early call would read stale file data and write it back over Postgres. */
C.initDB().then(()=>{
  httpServer.listen(PORT, ()=>{
    console.log(`\n  TIJORAT MARKAZI server → http://localhost:${PORT}`);
    console.log(`  AI: ${C.KEY ? "ON ("+C.MODEL+")" : "OFF — demo mode"}`);
    console.log(`  News: ${process.env.NEWS_FETCH && process.env.NEWS_FETCH.toLowerCase() !== "off"
      ? "web search ON" : "web search OFF (archive only — set NEWS_FETCH=on to resume)"}`);
    const db=C.dbStatus(); console.log(`  DB: ${db.ready ? "postgres — "+db.collections+" collections" : "FILES — "+(db.error||"not connected")}`);
    if(ADMIN_IS_DEFAULT) console.log("  ⚠  ADMIN PASSWORD IS THE DEFAULT — set ADMIN_PASSWORD or create admin.key before going live");
    sweepGeneratedDocs();                          // keep uploads/ from growing without bound
    setInterval(sweepGeneratedDocs, 24*60*60*1000);
    autoArchiveReports();                          // on start: archive any ended month not yet done
    setInterval(autoArchiveReports, 6*60*60*1000); // and re-check every 6h (catches month rollover)
  });
});
/* finish queued writes on shutdown instead of dropping them */
for(const sig of ["SIGINT","SIGTERM"]) process.on(sig, ()=>{ C.dbFlush().finally(()=>process.exit(0)); });

const creds = ensureCert();
if(creds){
  // the socket has to live on HTTPS too, or a phone gets no realtime
  const httpsServer = https.createServer(creds, handler);
  attachRealtime(httpsServer);
  httpsServer.listen(HTTPS_PORT, ()=>{
    HTTPS_READY = true;                        // only now is redirecting safe
    console.log(`  HTTPS  → https://localhost:${HTTPS_PORT}`);
    localAddresses().forEach(a=>console.log(`  LAN    → https://${a}:${HTTPS_PORT}   (voice works here)`));
    console.log("");
  });
}else{
  console.log(`  HTTPS  → skipped (openssl not found)\n`);
}
