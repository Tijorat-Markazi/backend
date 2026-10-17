"use strict";
// One process owns the document mirror. Successful responses wait for flush().
const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");
const DATA = path.join(__dirname, "data");
const cache = new Map();
let pool, ready = false, fatal = null, chain = Promise.resolve(), failureHandler = () => {};
const UPSERT = "INSERT INTO documents(key,data,updated_at) VALUES($1,$2,now()) ON CONFLICT(key) DO UPDATE SET data=EXCLUDED.data,updated_at=now()";
function fail(error) { ready = false; if (!fatal) { fatal = error; failureHandler(error); } }
async function init(options = {}) {
  ready = false;
  if (!options.pool && !process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  pool = options.pool || new Pool({ connectionString: process.env.DATABASE_URL,
    max: 6, connectionTimeoutMillis: 3000, query_timeout: 5000, statement_timeout: 5000, idleTimeoutMillis: 30000 });
  pool.on?.("error", fail);
  cache.clear(); fatal = null; chain = Promise.resolve();
  await pool.query("CREATE TABLE IF NOT EXISTS documents(key TEXT PRIMARY KEY,data JSONB NOT NULL,updated_at TIMESTAMPTZ NOT NULL DEFAULT now())");
  const { rows } = await pool.query("SELECT key,data FROM documents");
  for (const row of rows) cache.set(row.key, row.data);
  // JSON migration is an explicit operator operation, never a fallback.
  if (options.importFiles) {
    for (const name of fs.readdirSync(DATA).filter(n => n.endsWith(".json"))) {
      if (cache.has(name)) continue;
      const value = JSON.parse(fs.readFileSync(path.join(DATA, name), "utf8"));
      await pool.query("INSERT INTO documents(key,data) VALUES($1,$2) ON CONFLICT(key) DO NOTHING", [name, JSON.stringify(value)]);
      cache.set(name, value);
    }
  }
  ready = true; return true;
}
function get(file, fallback) {
  if (!ready || fatal) throw new Error("Database unavailable");
  const key = path.basename(file); return cache.has(key) ? cache.get(key) : fallback;
}
function set(file, value) {
  if (!ready || fatal) throw new Error("Database unavailable");
  const key = path.basename(file), payload = JSON.stringify(value);
  cache.set(key, value);
  chain = chain.then(() => pool.query(UPSERT, [key, payload]));
  chain.catch(fail); // Observe immediately; flush still rejects.
  return value;
}
async function flush() { await chain; if (fatal) throw fatal; }
async function query(text, values) {
  if (!pool || fatal) throw new Error("Database unavailable");
  try { return await pool.query(text, values); } catch (error) { fail(error); throw error; }
}
async function probe() { if (!ready || fatal) return false; try { await query("SELECT 1"); return true; } catch { return false; } }
async function close() { try { await flush(); } finally { ready = false; await pool?.end(); } }
const status = () => ({ ready: ready && !fatal, collections: cache.size });
module.exports = { init, get, set, flush, close, query, probe, status,
  keyOf: file => path.basename(file), onFailure: handler => { failureHandler = handler; } };
