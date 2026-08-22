/* ============================================================
   TIJORAT MARKAZI — Google Meet rooms (Calendar API v3, no deps)

   A conference scheduled on the platform gets a real Google Meet
   room created in the background, on the same date/time. The room
   comes from a calendar event on the connected Google account, so
   the link is a normal https://meet.google.com/xxx-xxxx-xxx that
   anyone can open — no Google account needed to join.

   Setup (once):
     1. console.cloud.google.com → new project → enable
        "Google Calendar API".
     2. APIs & Services → Credentials → OAuth client ID →
        type "Web application".
     3. Authorised redirect URI:  http://localhost:4321/api/google/callback
        (add the https:// LAN address too if you use it)
     4. Save client id + secret:
          echo '{"client_id":"…","client_secret":"…"}' > google.key
        or export GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET.
     5. Admin panel → Sozlamalar → "Google'ga ulanish" → pick the
        account that should own the meetings.
   ============================================================ */
const fs    = require("fs");
const path  = require("path");
const https = require("https");

const ROOT = __dirname;
const DATA = path.join(ROOT, "data");
const TOKEN_FILE = path.join(DATA, "google-token.json");
const CRED_FILE  = path.join(ROOT, "google.key");

/* datetime-local carries no zone, so every meeting is read in this one */
const TZ          = process.env.GOOGLE_TZ || "Asia/Tashkent";
const DEFAULT_MIN = Number(process.env.GOOGLE_MEET_MINUTES) || 60;
const MIN_MINUTES = 15, MAX_MINUTES = 600;
const SCOPES = ["https://www.googleapis.com/auth/calendar.events", "openid", "email"];

/* ---------- tiny helpers ---------- */
const loadJSON = (f, def) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch(e){ return def; } };
const qs = o => Object.keys(o).filter(k=>o[k]!=null&&o[k]!=="")
  .map(k=>encodeURIComponent(k)+"="+encodeURIComponent(o[k])).join("&");

function request(opts, payload){
  return new Promise((resolve, reject)=>{
    const r = https.request(opts, res=>{
      let b=""; res.setEncoding("utf8");
      res.on("data", c=>b+=c);
      res.on("end", ()=>{
        let j; try { j = JSON.parse(b||"{}"); } catch(e){ j = { raw:b }; }
        if(res.statusCode>=200 && res.statusCode<300) return resolve(j);
        const e = j && j.error;
        const msg = (e && (e.message || e)) || j.error_description || ("HTTP "+res.statusCode);
        reject(new Error(typeof msg==="string" ? msg : JSON.stringify(msg)));
      });
    });
    r.on("error", reject);
    if(payload) r.write(payload);
    r.end();
  });
}
function postForm(host, p, form){
  const body = qs(form);
  return request({ host, path:p, method:"POST",
    headers:{ "Content-Type":"application/x-www-form-urlencoded", "Content-Length":Buffer.byteLength(body) } }, body);
}
function apiCall(method, p, token, obj){
  const body = obj ? JSON.stringify(obj) : null;
  const headers = { Authorization:"Bearer "+token };
  if(body){ headers["Content-Type"]="application/json"; headers["Content-Length"]=Buffer.byteLength(body); }
  return request({ host:"www.googleapis.com", path:p, method, headers }, body);
}

/* ---------- credentials + token store ---------- */
function credentials(){
  const envId = (process.env.GOOGLE_CLIENT_ID||"").trim();
  const envSecret = (process.env.GOOGLE_CLIENT_SECRET||"").trim();
  if(envId && envSecret) return { clientId:envId, clientSecret:envSecret };
  // google.key holds either {client_id,client_secret} or the file Google hands out ({"web":{…}})
  const raw = loadJSON(CRED_FILE, null);
  const c = raw && (raw.web || raw.installed || raw);
  const id = c && (c.client_id || c.clientId), secret = c && (c.client_secret || c.clientSecret);
  return (id && secret) ? { clientId:String(id).trim(), clientSecret:String(secret).trim() } : null;
}
function store(){ return loadJSON(TOKEN_FILE, {}); }
function saveStore(s){ fs.mkdirSync(DATA, { recursive:true }); fs.writeFileSync(TOKEN_FILE, JSON.stringify(s, null, 2)); }

const isConfigured = () => !!credentials();
const isConnected  = () => !!(credentials() && store().refresh_token);
function status(){
  const s = store();
  return { configured:isConfigured(), connected:isConnected(),
    email:s.email||"", since:s.since||0, tz:TZ, minutes:DEFAULT_MIN };
}
function disconnect(){ try { fs.unlinkSync(TOKEN_FILE); } catch(e){} _tok = null; return true; }

/* ---------- OAuth ---------- */
function authUrl(redirectUri, state){
  if(!isConfigured()) return "";
  const c = credentials();
  return "https://accounts.google.com/o/oauth2/v2/auth?" + qs({
    client_id:c.clientId, redirect_uri:redirectUri, response_type:"code",
    scope:SCOPES.join(" "), access_type:"offline", prompt:"consent",
    include_granted_scopes:"true", state });
}
async function exchangeCode(code, redirectUri){
  const c = credentials();
  if(!c) throw new Error("google_not_configured");
  const t = await postForm("oauth2.googleapis.com", "/token", {
    code, client_id:c.clientId, client_secret:c.clientSecret,
    redirect_uri:redirectUri, grant_type:"authorization_code" });
  if(!t.refresh_token) throw new Error("no_refresh_token");   // happens when consent was already granted without prompt=consent
  let email = "";
  try {
    const me = await apiCall("GET", "/oauth2/v3/userinfo", t.access_token);
    email = me.email || "";
  } catch(e){ /* the mailbox name is cosmetic — never fail the connect over it */ }
  saveStore({ refresh_token:t.refresh_token, email, since:Date.now() });
  _tok = { token:t.access_token, exp: Date.now() + (t.expires_in||3600)*1000 };
  return { email };
}

let _tok = null;   // in-memory access token; refreshed on demand
async function accessToken(){
  const c = credentials();
  if(!c) throw new Error("google_not_configured");
  const s = store();
  if(!s.refresh_token) throw new Error("google_not_connected");
  if(_tok && Date.now() < _tok.exp - 60000) return _tok.token;
  let t;
  try {
    t = await postForm("oauth2.googleapis.com", "/token", {
      client_id:c.clientId, client_secret:c.clientSecret,
      refresh_token:s.refresh_token, grant_type:"refresh_token" });
  } catch(e){
    // a revoked or expired grant can never recover on its own — drop it so
    // the admin panel shows "connect" again instead of failing silently
    if(/invalid_grant/i.test(String(e.message))) disconnect();
    throw e;
  }
  _tok = { token:t.access_token, exp: Date.now() + (t.expires_in||3600)*1000 };
  return _tok.token;
}

/* ---------- naive local datetime ("2026-06-30T23:02") arithmetic ----------
   Kept off the server's own clock zone: components go in, components come
   out, and the zone is declared separately to Google. */
function parseLocal(dt){
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(dt||"").trim());
  if(!m) return null;
  return { y:+m[1], mo:+m[2], d:+m[3], h:+m[4], mi:+m[5], s:+(m[6]||0) };
}
function addMinutes(n, mins){
  const d = new Date(Date.UTC(n.y, n.mo-1, n.d, n.h, n.mi, n.s) + mins*60000);
  return { y:d.getUTCFullYear(), mo:d.getUTCMonth()+1, d:d.getUTCDate(),
    h:d.getUTCHours(), mi:d.getUTCMinutes(), s:d.getUTCSeconds() };
}
const p2 = v => String(v).padStart(2,"0");
const fmtLocal = n => `${n.y}-${p2(n.mo)}-${p2(n.d)}T${p2(n.h)}:${p2(n.mi)}:${p2(n.s)}`;

/* ---------- create / delete the room ---------- */
async function createMeet(m){
  const token = await accessToken();
  const minutes = Math.max(MIN_MINUTES, Math.min(MAX_MINUTES, Number(m.durationMin) || DEFAULT_MIN));
  const start = parseLocal(m.datetime);
  let window;
  if(start){
    window = { start:{ dateTime:fmtLocal(start), timeZone:m.timeZone||TZ },
               end:{ dateTime:fmtLocal(addMinutes(start, minutes)), timeZone:m.timeZone||TZ } };
  } else {
    // no usable time on the platform side → an open room starting now
    const now = Date.now();
    window = { start:{ dateTime:new Date(now).toISOString().slice(0,19), timeZone:"UTC" },
               end:{ dateTime:new Date(now+minutes*60000).toISOString().slice(0,19), timeZone:"UTC" } };
  }
  const event = Object.assign({
    summary: String(m.title||"Tijorat Markazi").slice(0,200),
    description: String(m.desc||"").slice(0,1000),
    conferenceData: { createRequest: {
      requestId: "tm"+Date.now().toString(36)+Math.random().toString(36).slice(2,8),
      conferenceSolutionKey: { type:"hangoutsMeet" } } },
    guestsCanInviteOthers: true,
  }, window);

  const j = await apiCall("POST",
    "/calendar/v3/calendars/primary/events?conferenceDataVersion=1&sendUpdates=none",
    token, event);

  const video = ((j.conferenceData||{}).entryPoints||[]).find(e=>e.entryPointType==="video");
  const link = j.hangoutLink || (video && video.uri) || "";
  if(!link) throw new Error("meet_link_missing");
  return { link, eventId:j.id||"", htmlLink:j.htmlLink||"" };
}
async function deleteMeet(eventId){
  if(!eventId) return false;
  const token = await accessToken();
  await apiCall("DELETE", "/calendar/v3/calendars/primary/events/"+encodeURIComponent(eventId)+"?sendUpdates=none", token);
  return true;
}

module.exports = {
  TZ, DEFAULT_MIN, SCOPES,
  isConfigured, isConnected, status, disconnect,
  authUrl, exchangeCode, accessToken,
  createMeet, deleteMeet,
  parseLocal, addMinutes, fmtLocal,
};
