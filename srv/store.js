/* ============================================================
   TIJORAT MARKAZI — shared storage + scoring for the three
   market modules (Bozor, Moliya bozori, Human Capital Markazi).

   These modules live under srv/ rather than next to server.js
   because everything in the project root is reachable over HTTP
   as a static file. Server-side domain logic does not belong on
   that surface.

   Persistence goes through db.js, exactly like core.js does:
   one row per collection, Postgres-backed, memory-mirrored.
   ============================================================ */
const path = require("path");
const DB   = require("../db");

const DATA = path.join(__dirname, "..", "data");
const file = name => path.join(DATA, name);

function uid(p){ return (p||"") + Math.random().toString(36).slice(2,8) + Date.now().toString(36).slice(-4); }

/* ---------- input sanitising: nothing reaches a store unvalidated ---------- */
const S = (v, n = 200) => String(v == null ? "" : v).trim().slice(0, n);
const N = (v, d = 0) => { const x = Number(v); return Number.isFinite(x) ? x : d; };
const BOOL = v => v === true || v === "true" || v === 1 || v === "1";
/** Pick from a closed set — keeps enum columns honest. */
const ONE = (v, allowed, def) => allowed.includes(String(v)) ? String(v) : (def != null ? def : allowed[0]);
/** Accept either a real array or a comma/newline separated string. */
function LIST(v, max = 30, len = 120){
  const raw = Array.isArray(v) ? v : S(v, max * len).split(/[,;\n]/);
  const out = [];
  for(const x of raw){
    const s = S(x, len);
    if(s && !out.includes(s)) out.push(s);
    if(out.length >= max) break;
  }
  return out;
}
const SUBSET = (v, allowed, max = 10) => LIST(v, max).filter(x => allowed.includes(x));

/* ---------- collections ---------- */
/**
 * A named JSON document holding several parallel arrays. Missing arrays are
 * created on read so a brand-new install and a migrated one behave the same.
 */
function collection(fileName, keys){
  const load = () => {
    const raw = DB.get(file(fileName), null) || {};
    const out = {};
    for(const k of keys) out[k] = Array.isArray(raw[k]) ? raw[k] : [];
    return out;
  };
  const save = obj => { DB.set(file(fileName), obj); return obj; };
  return { load, save, keys };
}

/* Market-signal log. Every search, publish, application and offer becomes a
   row here — the intelligence dashboards in all three TZs are built on this
   stream, not on record counts. Capped so the document cannot grow forever. */
const EVENT_CAP = 4000;
function logEvent(store, type, payload){
  if(!Array.isArray(store.events)) store.events = [];
  store.events.push(Object.assign({ id: uid("ev"), type: S(type, 40), t: Date.now() }, payload || {}));
  if(store.events.length > EVENT_CAP) store.events = store.events.slice(-EVENT_CAP);
  return store;
}

/* ---------- text ---------- */
const norm = s => S(s, 6000).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const STOP = new Set(["and","the","for","with","dan","uchun","bilan","ning","lar","что","для","при","под"]);
function tokens(s){
  const out = new Set();
  for(const w of norm(s).split(" ")) if(w.length > 2 && !STOP.has(w)) out.add(w);
  return out;
}
/** Share of `need` that `have` covers — asymmetric on purpose: a long product
 *  description should not be punished for saying more than the query asked. */
function coverage(need, have){
  const a = need instanceof Set ? need : tokens(need);
  const b = have instanceof Set ? have : tokens(have);
  if(!a.size) return 0;
  let hit = 0;
  for(const w of a) if(b.has(w)) hit++;
  return hit / a.size;
}
/** Case-insensitive overlap of two labelled lists (skills, sectors, markets). */
function listFit(need, have){
  const want = LIST(need).map(x => x.toLowerCase());
  if(!want.length) return { value: 1, known: false, matched: [], missing: [] };
  const got = new Set(LIST(have).map(x => x.toLowerCase()));
  const matched = want.filter(x => got.has(x));
  return { value: matched.length / want.length, known: true,
           matched, missing: want.filter(x => !got.has(x)) };
}
/** 1 when the ranges touch, tapering to 0 as they drift apart. */
function rangeFit(askMin, askMax, offMin, offMax){
  const a1 = N(askMin), a2 = N(askMax) || N(askMin);
  const b1 = N(offMin), b2 = N(offMax) || N(offMin);
  if(!(a1 || a2) || !(b1 || b2)) return { value: 0.5, known: false };
  if(Math.max(a1, b1) <= Math.min(a2 || a1, b2 || b1)) return { value: 1, known: true };
  const gap  = Math.max(a1, b1) - Math.min(a2 || a1, b2 || b1);
  const span = Math.max(a2 || a1, b2 || b1, 1);
  return { value: Math.max(0, 1 - gap / span), known: true };
}

/* ---------- explainable scoring ----------
   Every TZ in this batch demands the same thing next to a match number:
   "nega mos?" and "nima yetishmayapti?". So scoring never returns a bare
   integer — it returns the reasons that earned points, the gaps that lost
   them, and how much of the input was actually known. */
function score(factors){
  let sum = 0, weight = 0, known = 0, total = 0;
  const reasons = [], gaps = [];
  for(const f of factors){
    if(!f) continue;
    const w = N(f.weight, 0);
    const v = Math.max(0, Math.min(1, N(f.value, 0)));
    sum += w * v; weight += w; total += w;
    if(f.known !== false) known += w;
    if(v >= 0.7 && f.why) reasons.push(f.why);
    else if(v < 0.5 && f.gap) gaps.push(f.gap);
  }
  return {
    score: weight ? Math.round(100 * sum / weight) : 0,
    reasons, gaps,
    confidence: total ? Math.round(100 * known / total) : 0,
  };
}

/* ---------- aggregation helpers for the intelligence dashboards ---------- */
function countBy(rows, pick){
  const m = new Map();
  for(const r of rows || []){
    const keys = pick(r);
    for(const k of (Array.isArray(keys) ? keys : [keys])){
      const key = S(k, 120);
      if(key) m.set(key, (m.get(key) || 0) + 1);
    }
  }
  return [...m.entries()].map(([label, n]) => ({ label, n })).sort((a, b) => b.n - a.n);
}
function stats(values){
  const v = (values || []).map(x => N(x, NaN)).filter(Number.isFinite).sort((a, b) => a - b);
  if(!v.length) return null;
  const at = p => v[Math.min(v.length - 1, Math.floor(p * (v.length - 1)))];
  return { n: v.length, min: v[0], p25: at(.25), median: at(.5), p75: at(.75), max: v[v.length - 1] };
}
/** Rows created inside the last `days` — used by every "growth" widget. */
const since = (rows, days) => (rows || []).filter(r => N(r.created) >= Date.now() - days * 864e5);

module.exports = { DATA, file, uid, S, N, BOOL, ONE, LIST, SUBSET, collection, logEvent,
  norm, tokens, coverage, listFit, rangeFit, score, countBy, stats, since };
