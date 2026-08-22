/* ============================================================
   TIJORAT MARKAZI — PostgreSQL storage

   Every data file the platform used to keep in data/*.json now lives
   in Postgres, one row per collection in `documents`.

   Why it looks like this: core.js reads and writes its state through
   two SYNCHRONOUS helpers (loadJSON / saveJSON) that are called from
   ~45 places, and everything above them is synchronous too. Postgres
   is async. Rather than rewrite the whole call chain, the table is
   read once at boot into memory, reads are served from there, and
   every write goes to memory AND straight on to Postgres. Postgres is
   the source of truth and survives restarts; memory is a mirror.

   That trade is sound for one server process. If this ever runs as
   more than one process, two instances would each hold their own
   mirror and last-write-wins — at that point these reads need to go
   to the database directly.

   Connection: DATABASE_URL, or postgres.key next to this file, else
   the local default below.
   ============================================================ */
const fs   = require("fs");
const path = require("path");

let Pool = null;
try { ({ Pool } = require("pg")); } catch(e){ Pool = null; }

const ROOT = __dirname;
const DATA = path.join(ROOT, "data");
const DEFAULT_URL = "postgres://postgres:tijorat_pg_2026@localhost:5432/tijorat";

function connectionString(){
  if(process.env.DATABASE_URL) return process.env.DATABASE_URL.trim();
  try { return fs.readFileSync(path.join(ROOT, "postgres.key"), "utf8").trim(); } catch(e){}
  return DEFAULT_URL;
}

let pool = null;
let ready = false;              // true once the mirror is loaded from Postgres
const cache = new Map();        // key -> parsed object
const files = new Map();        // key -> original file path, for the fallback
let writeChain = Promise.resolve();
let lastError = "";

const status = () => ({ ready, driver: !!Pool, error: lastError,
  collections: cache.size, url: connectionString().replace(/:[^:@/]*@/, ":***@") });

/* ---------- boot ---------- */
async function init(){
  if(!Pool){ lastError = "pg driver missing"; console.error("[db] " + lastError + " — falling back to files"); return false; }
  try{
    pool = new Pool({ connectionString: connectionString(), max: 6, idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 8000 });
    /* An error on an IDLE client is emitted on the pool. Without this listener
       Node treats it as unhandled and kills the process — a Postgres restart
       would take the whole site down. */
    pool.on("error", e => {
      lastError = String(e.message || e);
      ready = false;
      console.error("[db] pool error:", lastError, "— will retry on next write");
    });
    await pool.query(`CREATE TABLE IF NOT EXISTS documents (
      key         TEXT PRIMARY KEY,
      data        JSONB NOT NULL,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const { rows } = await pool.query("SELECT key, data FROM documents");
    for(const r of rows) cache.set(r.key, r.data);
    const imported = await importFiles();
    ready = true; lastError = "";
    console.log(`  DB: postgres ready — ${cache.size} collection(s)${imported ? `, ${imported} imported from JSON` : ""}`);
    return true;
  }catch(e){
    lastError = String(e.message || e);
    console.error("[db] connection failed:", lastError, "— falling back to files");
    ready = false;
    return false;
  }
}

/* One-time lift of the existing data/*.json files into the table. A file is
   only imported when the database has no row for it yet, so this never
   overwrites newer data on a later boot. */
async function importFiles(){
  let n = 0;
  let names = [];
  try { names = fs.readdirSync(DATA).filter(f => f.endsWith(".json")); } catch(e){ return 0; }
  for(const name of names){
    if(cache.has(name)) continue;
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(path.join(DATA, name), "utf8")); }
    catch(e){ continue; }                       // unreadable or empty — skip, don't fail the boot
    await pool.query(
      "INSERT INTO documents (key, data) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING",
      [name, JSON.stringify(parsed)]);
    cache.set(name, parsed);
    n++;
  }
  return n;
}

/* ---------- the synchronous surface core.js uses ---------- */
function keyOf(file){ return path.basename(String(file || "")); }

function get(file, def){
  const key = keyOf(file);
  files.set(key, file);
  if(cache.has(key)) return cache.get(key);
  // not in the mirror (db down, or a brand-new collection) — read the file
  try{
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    cache.set(key, raw);
    return raw;
  }catch(e){ return def; }
}

const UPSERT = `INSERT INTO documents (key, data, updated_at) VALUES ($1, $2, now())
  ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* Never lose a write. Postgres restarting, a dropped connection or a network
   blip get retried with backoff; if it still will not land, the collection is
   written to its JSON file so the data survives a process restart and can be
   re-imported. */
async function writeWithRetry(key, file, obj){
  const payload = JSON.stringify(obj);
  for(let attempt = 1; attempt <= 3; attempt++){
    try{
      await pool.query(UPSERT, [key, payload]);
      if(!ready){ ready = true; lastError = ""; console.log("[db] postgres write path recovered"); }
      return;
    }catch(e){
      lastError = String(e.message || e);
      if(attempt === 3) break;
      await sleep(attempt * 400);
    }
  }
  ready = false;                                   // fall back until a write succeeds again
  console.error(`[db] write failed for ${key} after 3 attempts (${lastError}) — writing to file`);
  toFile(file, obj);
}

function toFile(file, obj){
  try{
    fs.mkdirSync(path.dirname(file), { recursive:true });
    fs.writeFileSync(file, JSON.stringify(obj, null, 2));
  }catch(e){ console.error("[db] file fallback failed for " + keyOf(file) + ":", e.message); }
}

function set(file, obj){
  const key = keyOf(file);
  files.set(key, file);
  cache.set(key, obj);
  if(pool){
    // serialise writes so two rapid saves of the same collection keep their order
    writeChain = writeChain.then(() => writeWithRetry(key, file, obj)).catch(()=>{});
  } else {
    toFile(file, obj);                             // no driver at all — behave exactly as before
  }
  return obj;
}

/* let a shutdown finish the queued writes instead of losing them */
async function flush(){ try{ await writeChain; }catch(e){} }
async function close(){ await flush(); if(pool) await pool.end().catch(()=>{}); }

module.exports = { init, get, set, status, flush, close, keyOf };
