/* ============================================================
   PASSWORDS — hashing at rest, and the migration off plaintext

   Every account in this platform used to keep its password as a
   readable string in data/orgs.json, and three endpoints handed
   that string back to the browser so an association could read
   its members' credentials off the panel.

   That is the finding a regulator opens with. Modda 27 of the
   Law "Shaxsga doir ma'lumotlar to'g'risida" (ZRU-547) obliges
   the owner of a personal-data base to take measures against
   unauthorised access; storing a credential in the clear is the
   absence of the measure, not a weak version of it. KoAO 46-2
   prices it at 7 BHM for a citizen and 50 BHM for an official,
   and the enforcement that actually hurts is suspension of
   access to the resource while it is fixed.

   So: scrypt, one salt per record, and a verify() that is the
   only thing in the codebase allowed to look at a password.

   MIGRATION is eager, not lazy. migrate() runs once on the
   first getOrgs() of the process and rewrites every legacy
   record in place. A lazy upgrade-on-login would leave the
   plaintext of everyone who has not signed in yet sitting in
   the file indefinitely — which is precisely the state we are
   trying to leave. Nobody's password changes; only its storage.
   ============================================================ */
const crypto = require("crypto");

/* 128 * N * r = 16 MB of work per hash. Comfortably inside Node's 32 MB
   scrypt ceiling, and slow enough that an exfiltrated orgs.json is not a
   password list. Recorded in the encoded string so these can be raised
   later without stranding the hashes written under the old cost. */
const N = 16384, R = 8, P = 1, KEYLEN = 32;
const SCHEME = "scrypt";

/** A credential the platform generates itself — for seeded associations and
    for admin-minted accounts. Math.random() is not a secret source; it was
    being used for exactly that, six characters at a time. */
function generate(len = 14){
  /* No look-alike characters: these get read off a screen and typed by hand,
     so 0/O and 1/l/I cost support calls rather than buying entropy. */
  const A = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(len);
  let out = "";
  for(let i = 0; i < len; i++) out += A[bytes[i] % A.length];
  return out;
}

function hash(plain){
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(String(plain == null ? "" : plain), salt, KEYLEN, { N, r: R, p: P });
  return [SCHEME, N, R, P, salt.toString("base64"), dk.toString("base64")].join("$");
}

const isHash = v => typeof v === "string" && v.startsWith(SCHEME + "$");

/** Constant-time compare of a candidate against an encoded hash. */
function matches(encoded, plain){
  if(!isHash(encoded)) return false;
  const [, n, r, p, salt, want] = encoded.split("$");
  let got;
  try{
    got = crypto.scryptSync(String(plain == null ? "" : plain),
      Buffer.from(salt, "base64"), KEYLEN, { N: Number(n), r: Number(r), p: Number(p) });
  }catch(e){ return false; }
  const expect = Buffer.from(want, "base64");
  return got.length === expect.length && crypto.timingSafeEqual(got, expect);
}

/**
 * The single question the rest of the codebase is allowed to ask.
 *
 * `rec` is any account record — rais, association, company, analyst, buyer.
 * The legacy plaintext branch exists so that a record written by a route
 * that has not been converted yet, or restored from an old backup, still
 * lets its owner in; migrate() then removes it on the next boot. An empty
 * stored credential never matches, or every blank field would be an open door.
 */
function verify(rec, plain){
  if(!rec) return false;
  const pw = String(plain == null ? "" : plain);
  if(isHash(rec.pwHash)) return matches(rec.pwHash, pw);
  const legacy = rec.password;
  if(typeof legacy === "string" && legacy.length > 0){
    const a = Buffer.from(legacy), b = Buffer.from(pw);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  return false;
}

/** Set a new password on a record, clearing any plaintext left beside it. */
function set(rec, plain){
  if(!rec) return rec;
  rec.pwHash = hash(plain);
  delete rec.password;
  return rec;
}

/** A copy of a record with every credential field removed, for API responses. */
function strip(rec){
  if(!rec || typeof rec !== "object") return rec;
  const { password, pwHash, ...rest } = rec;
  return rest;
}

/* ---------- migration ----------
   Runs over every tier that can sign in. Buyers and analysts live on the
   same orgs document as companies and associations, so one pass covers all
   of them; registrations.json is handled by srv/register.js, which holds a
   pending applicant's chosen password until it is approved or discarded. */
const TIERS = ["associations", "companies", "analysts", "buyers"];

/** Rewrite plaintext credentials as hashes. Returns how many changed. */
function migrate(orgs){
  let n = 0;
  const one = rec => {
    if(!rec || typeof rec !== "object") return;
    if(isHash(rec.pwHash)){ if("password" in rec){ delete rec.password; n++; } return; }
    if(typeof rec.password === "string" && rec.password.length){ set(rec, rec.password); n++; }
  };
  if(orgs && orgs.rais) one(orgs.rais);
  for(const tier of TIERS) if(Array.isArray(orgs && orgs[tier])) orgs[tier].forEach(one);
  return n;
}

module.exports = { generate, hash, verify, set, strip, migrate, isHash };
