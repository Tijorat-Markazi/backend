/* ============================================================
   TIJORAT MARKAZI — Business ID

   Every association and company on the platform carries one public
   identity document: a number, a card and a QR code.

     A481203        C007754
     │└─────┬───    │└─────┬───
     │   six random │   six random digits, drawn once and never reused
     └ uyushma      └ korxona

   The digits are drawn at random, not counted up, so holding one
   number tells you nothing about who holds another and gives no clue
   how many organisations are registered.

   Two things follow from that, and both are deliberate:

   • There is no check character, so any well-formed string could
     exist. `verify` answers "known" or "unknown" against the
     register rather than rejecting an invention on sight.
   • Six digits is 999,999 values per kind. That defeats casual
     enumeration, not a determined scan — so the number identifies,
     it never authorises. Nothing is unlocked by knowing one.

   Numbers are assigned lazily by `ensure`, which is idempotent and
   reports `changed` only when it actually wrote something.
   ============================================================ */
const H = require("./store");
const crypto = require("crypto");

const KIND = { assoc: "A", company: "C" };

const SEQ_PAD = 6;
const ID_RE = /^([AC])(\d{6})$/;

/* ---------- the number itself ---------- */

function format(kind, seq){
  const k = kind === KIND.assoc ? KIND.assoc : KIND.company;
  return k + String(seq).padStart(SEQ_PAD, "0");
}

/**
 * Read an ID back. Returns null for anything that is not a well-formed
 * number, so callers never have to trust the string they were handed.
 *
 * Note this shape carries no check character: A000042 and A000043 are both
 * well-formed, so `verify` can only answer "known" or "unknown" against the
 * directory — it cannot reject an invented number on sight.
 */
function parse(raw){
  const s = String(raw || "").trim().toUpperCase().replace(/[\s-]+/g, "");
  const m = ID_RE.exec(s);
  if(!m) return null;
  const seq = parseInt(m[2], 10);
  if(!Number.isFinite(seq) || seq < 1) return null;
  return { id: format(m[1], seq), kind: m[1], seq };
}

const isAssoc = id => { const p = parse(id); return !!p && p.kind === KIND.assoc; };

/* ---------- assignment ---------- */

/* Numbers are drawn at random rather than counted up. A sequential number
   tells anyone holding one how many orgs exist and lets them walk the whole
   register by adding 1 — A000001, A000002, and so on. Random draws remove
   that: holding C000042 says nothing about who holds anything else.

   The draw uses crypto.randomInt, not Math.random: this is an identifier
   people are invited to trust, and randomInt is both unpredictable and free
   of the modulo bias a naive `% 1000000` would introduce.

   Honest limit: six digits is 999,999 possibilities per kind, so this stops
   casual enumeration, not a determined scan. The number is an identifier,
   never a credential — nothing is authorised by knowing one. */
const MIN_N = 1;
const MAX_N = 999999;
const SCHEME = "random-v1";        // bump to re-issue every number once

function draw(){
  return crypto.randomInt(MIN_N, MAX_N + 1);
}

/** Every number ever issued, so a retired one is never handed out twice. */
function usedSet(o, kind){
  const store = o.bizUsed && o.bizUsed[kind];
  return new Set(Array.isArray(store) ? store : []);
}

/**
 * Give every association and company a number. Mutates the orgs object in
 * place — that is how the rest of the codebase treats it — and reports
 * `changed` only when something was actually written, so the caller can
 * decide whether the write is worth persisting.
 *
 * Issued numbers are remembered in orgs.bizUsed and never reissued, even
 * after the org holding one is deleted: a retired document number stays
 * retired, or an old printed card would resolve to somebody else.
 */
function ensure(orgs){
  const o = orgs || {};
  let changed = false;

  /* A scheme change re-issues everything exactly once. Anything numbered
     under the old sequential scheme is exactly what this is meant to undo,
     so those are dropped rather than carried across. */
  if(o.bizIdScheme !== SCHEME){
    [o.associations, o.companies].forEach(rows =>
      (rows || []).forEach(r => { if(r) delete r.bizId; }));
    o.bizUsed = {};
    delete o.bizSeq;                       // the old high-water counter
    o.bizIdScheme = SCHEME;
    changed = true;
  }

  if(!o.bizUsed || typeof o.bizUsed !== "object"){ o.bizUsed = {}; changed = true; }

  const run = (rows, kind) => {
    const used = usedSet(o, kind);
    /* Numbers currently held count as used even if the ledger lost them. */
    (rows || []).forEach(r => {
      const p = parse(r && r.bizId);
      if(p && p.kind === kind) used.add(p.seq);
    });

    const pending = (rows || []).filter(r => r && !parse(r.bizId));
    for(const r of pending){
      let n = draw();
      /* Collisions are rare at these volumes but must not be silently
         accepted — two orgs sharing a number would break every lookup. */
      for(let tries = 0; used.has(n) && tries < 10000; tries++) n = draw();
      if(used.has(n)) throw new Error("business-id: number space exhausted for " + kind);
      used.add(n);
      r.bizId = format(kind, n);
      changed = true;
    }

    const before = (o.bizUsed[kind] || []).length;
    if(used.size !== before){
      o.bizUsed[kind] = [...used].sort((a, b) => a - b);
      changed = true;
    }
  };

  run(o.associations, KIND.assoc);
  run(o.companies, KIND.company);
  return { orgs: o, changed };
}

/** Find whoever holds a number. Returns null for invalid or unknown ids. */
function holderOf(orgs, raw){
  const p = parse(raw);
  if(!p) return null;
  const rows = p.kind === KIND.assoc ? (orgs.associations || []) : (orgs.companies || []);
  const row = rows.find(r => r && r.bizId === p.id);
  if(!row) return null;
  return { row, kind: p.kind === KIND.assoc ? "assoc" : "company", id: p.id };
}

/* ---------- contact details ---------- */

/* An association is reached through its office and its site, not through a
   shop counter: a street address and a general mailbox say nothing useful
   about a body that exists to represent its members. A company is the
   opposite — that is exactly how a buyer reaches it. So the two kinds carry
   different field sets, and the association's card never renders, stores or
   accepts the two it does not use. */
const CONTACT_FIELDS = {
  assoc:   ["phone", "website"],
  company: ["phone", "email", "location", "website"],
};

const LIMITS = { phone: 60, email: 120, location: 160, website: 300 };
const EMAIL_RE = /^[^@\s]+@[^@\s.]+\.[^@\s]+$/;

/** Which fields a kind carries. Unknown kinds get the fuller company set. */
const fieldsFor = kind => CONTACT_FIELDS[kind] || CONTACT_FIELDS.company;

/**
 * Public-facing contact block. The shape follows the kind, so a consumer can
 * simply render what it is given rather than knowing which fields to skip.
 */
function contactOf(row, kind){
  const out = {};
  fieldsFor(kind).forEach(f => { out[f] = H.S(row && row[f], LIMITS[f]); });
  return out;
}

/**
 * Validate and normalise a contact submission for one kind. Fields that kind
 * does not carry are ignored rather than rejected, so an old client posting
 * an address to an association cannot quietly write one. Returns { error }
 * rather than throwing, matching how srv/register.js reports bad input.
 */
function cleanContact(body, kind){
  const b = body || {};
  const allowed = fieldsFor(kind);
  const value = {};

  if(allowed.includes("phone")){
    value.phone = H.S(b.phone, LIMITS.phone);
    if(value.phone && !/^[+()\d\s-]{6,}$/.test(value.phone)) return { error: "phone_invalid" };
  }
  if(allowed.includes("email")){
    value.email = H.S(b.email, LIMITS.email).toLowerCase();
    if(value.email && !EMAIL_RE.test(value.email)) return { error: "email_invalid" };
  }
  if(allowed.includes("location")){
    value.location = H.S(b.location, LIMITS.location);
  }
  if(allowed.includes("website")){
    let w = H.S(b.website, LIMITS.website);
    if(w){
      if(!/^https?:\/\//i.test(w)) w = "https://" + w;
      if(!/^https?:\/\/[^\s]+\.[^\s]+$/i.test(w)) return { error: "website_invalid" };
    }
    value.website = w;
  }
  return { value };
}

/**
 * Write contact fields onto an org row. Only ever touches the fields that
 * kind carries — and clears any the kind has since stopped carrying, so an
 * address saved before this split cannot linger on an association.
 */
function applyContact(row, clean, kind){
  const allowed = fieldsFor(kind);
  allowed.forEach(f => { row[f] = clean[f] || ""; });
  Object.keys(LIMITS).forEach(f => { if(!allowed.includes(f)) delete row[f]; });
  return row;
}

/* ---------- the card ---------- */

function assocCard(orgs, a, names){
  const members = (orgs.companies || []).filter(c => c.assocId === a.id);
  return {
    chairman: H.S(a.chairman, 160),
    memberCount: members.length,
    productCount: members.reduce((n, c) => n + (c.showroom || []).length, 0),
    companies: members.map(c => ({
      bizId: c.bizId || "",
      name: H.S(c.name, 200),
      sector: H.S(c.sector, 120),
      products: (c.showroom || []).length,
    })),
  };
}

function companyCard(orgs, c, names){
  const a = (orgs.associations || []).find(x => x.id === c.assocId) || null;
  const showroom = (c.showroom || [])
    .filter(p => p && (p.name || p.img))
    .map(p => ({
      id: p.id || "",
      name: H.S(p.name, 200),
      price: H.S(p.price, 60),
      img: H.S(p.img, 400),
      trade: p.trade === "import" ? "import" : "export",
    }));
  return {
    sector: H.S(c.sector, 120),
    assoc: a ? { bizId: a.bizId || "", name: H.S(a.name, 200), id: a.id } : null,
    productCount: showroom.length,
    showroom,
  };
}

/**
 * The public card. `names` is core.js's orgNames, injected so this module
 * stays free of the AI core; `since` is the join date the card prints.
 */
function card(orgs, raw, names){
  const found = holderOf(orgs, raw);
  if(!found) return null;
  const row = found.row;
  const base = {
    ok: true,
    bizId: found.id,
    kind: found.kind,
    name: H.S(row.name, 200),
    i18n: names ? names(row) : null,
    since: row.created || 0,
    contact: contactOf(row, found.kind),
  };
  return Object.assign(base, found.kind === "assoc"
    ? assocCard(orgs, row, names)
    : companyCard(orgs, row, names));
}

/**
 * Verification is deliberately thin: it confirms a number is real and says
 * who holds it, without exposing contact details or membership.
 */
function verify(orgs, raw){
  const p = parse(raw);
  if(!p) return { ok: false, reason: "malformed" };
  const found = holderOf(orgs, raw);
  if(!found) return { ok: false, reason: "unknown", bizId: p.id };
  return {
    ok: true,
    bizId: found.id,
    kind: found.kind,
    name: H.S(found.row.name, 200),
    since: found.row.created || 0,
  };
}

/** Directory listing — every card, for the lookup page and for crawlers. */
function directory(orgs, names){
  const one = (row, kind) => ({
    bizId: row.bizId || "",
    kind,
    name: H.S(row.name, 200),
    i18n: names ? names(row) : null,
    sector: kind === "company" ? H.S(row.sector, 120) : "",
  });
  return [].concat(
    (orgs.associations || []).filter(a => a.bizId).map(a => one(a, "assoc")),
    (orgs.companies || []).filter(c => c.bizId).map(c => one(c, "company"))
  );
}

module.exports = {
  KIND, CONTACT_FIELDS, fieldsFor,
  format, parse, isAssoc, SCHEME,
  ensure, holderOf,
  contactOf, cleanContact, applyContact,
  card, verify, directory,
};
