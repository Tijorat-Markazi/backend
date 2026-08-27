/* ============================================================
   XARIDOR — the buying side of the B2B market

   Every other cabinet on the platform belongs to someone who
   SELLS: a company lists products, an association vouches for
   companies, an analyst reads what they did. The one role with
   no account was the one paying for all of it — a buyer was an
   e-mail address in an inquiry and nothing more.

   That was not merely a missing feature. `person()` in api.js
   mints an identity from any e-mail typed into a request body,
   so "the buyer of RFQ X" was a claim, never a fact. A buyer
   with a real account is a stable, checkable id — which is what
   lets deals, quotes and threads be owned rather than guessed.

   Two rules define this tier, and both are enforced here rather
   than trusted to the client:

   1  ADMIN-APPROVED. A buyer account is created by approving an
      application, never by signing up. Unlike a company, a buyer
      is not vouched for by an association — there is no sector
      body that knows them — so oversight is the only approver.
      That lives in register.js; this module only ever sees
      accounts that already exist.

   2  B2B ONLY. The platform sells through three channels (b2b,
      b2g, export). A buyer here is a business buying from a
      business: CHANNEL is a constant, not a parameter, and every
      route that could widen it pins it back to "b2b".
   ============================================================ */
const H = require("./store");
const PW = require("./passwords");

/* The one channel this tier may ever act on. Exported so the routes pin
   themselves to it instead of each re-deciding what a buyer is allowed. */
const CHANNEL = "b2b";

const LOGIN = /^[a-z0-9][a-z0-9._-]{2,39}$/;   // identical to every other tier's rule
const SAVED_CAP = 200;

/** Everything a buyer may see about itself — the password is not on it. */
const view = b => ({
  id: b.id,
  name:         b.name || "",             // the buying company
  phone:        b.phone || "",            // the company's own number
  login:        b.login || "",
  contactName:  b.contactName || "",
  role:         b.role || "",
  email:        b.email || "",
  contactPhone: b.contactPhone || "",
  region:       b.region || "",
  about:        b.about || "",
  saved:        Array.isArray(b.saved) ? b.saved : [],
  created:      b.created || 0,
});

/** What an approver or the admin list may see. Also password-free. */
const adminView = b => Object.assign(view(b), { savedCount: (b.saved || []).length });

const all = orgs => (Array.isArray(orgs.buyers) ? orgs.buyers : []);

function authenticate(orgs, login, password){
  const lg = H.S(login, 80).trim().toLowerCase();
  const pw = String(password == null ? "" : password);
  if(!lg || !pw) return null;
  const b = all(orgs).find(x => String(x.login || "").toLowerCase() === lg
                              && !x.suspended && PW.verify(x, pw));
  if(!b) return null;
  /* The shape api.js's actor() expects: an id and a display name. `name` is
     the buying COMPANY, because that is who appears on an RFQ, not the
     individual who happens to be typing. */
  return { id: b.id, name: b.name, login: b.login, email: b.email || "", raw: b };
}

const findById = (orgs, id) => all(orgs).find(x => x.id === H.S(id, 40)) || null;

/** Fields a buyer may change about itself. The login can never move: it is
    what every RFQ, deal and thread already points at. */
function profileSave(orgs, buyer, body, saveOrgs){
  const name = H.S(body.name, 200);
  if(!name) return { error: "name_required" };
  const phone = H.S(body.phone, 60);
  if(!phone) return { error: "phone_required" };

  const next = Object.assign({}, buyer.raw, {
    name, phone,
    contactName:  H.S(body.contactName, 160),
    role:         H.S(body.role, 120),
    contactPhone: H.S(body.contactPhone, 60),
    region:       H.S(body.region, 120),
    about:        H.S(body.about, 2000),
    updated: Date.now(),
  });
  orgs.buyers = all(orgs).map(x => (x.id === buyer.id ? next : x));
  saveOrgs(orgs);
  return { ok: true, buyer: view(next) };
}

/** A shortlist of sellers worth coming back to. Ids only — the names are
    resolved from live records at read time, so a renamed supplier does not
    leave a stale label behind in someone's list. */
function savedToggle(orgs, buyer, companyId, saveOrgs){
  const id = H.S(companyId, 40);
  if(!id) return { error: "id_required" };
  if(!(orgs.companies || []).some(c => c.id === id)) return { error: "company_not_found" };

  const have = Array.isArray(buyer.raw.saved) ? buyer.raw.saved : [];
  const saved = have.includes(id) ? have.filter(x => x !== id) : have.concat([id]).slice(-SAVED_CAP);
  const next = Object.assign({}, buyer.raw, { saved, updated: Date.now() });
  orgs.buyers = all(orgs).map(x => (x.id === buyer.id ? next : x));
  saveOrgs(orgs);
  return { ok: true, saved, on: saved.includes(id) };
}

/** The shortlist, resolved against live company records. */
function savedSuppliers(orgs, buyer){
  const ids = new Set(Array.isArray(buyer.raw.saved) ? buyer.raw.saved : []);
  return (orgs.companies || []).filter(c => ids.has(c.id)).map(c => ({
    id: c.id, name: c.name || "", sector: c.sector || "",
    region: c.location || "", email: c.email || "", phone: c.phone || "",
    website: c.website || "",
  }));
}

/**
 * Create the account an approved application earns. Kept here rather than in
 * register.js so that everything which defines a buyer record — its fields,
 * its defaults, its login rule — lives in one file.
 */
function fromApplication(app){
  return {
    id: H.uid("by"),
    name:         app.name || "",
    phone:        app.phone || "",
    login:        String(app.login || "").toLowerCase(),
    /* The application already stores its chosen password as a hash, so it
       moves across as one — the plaintext never existed on disk. */
    pwHash:       app.pwHash || "",
    contactName:  app.contactName || "",
    role:         app.role || "",
    email:        app.email || "",
    contactPhone: app.contactPhone || "",
    region:       app.region || "",
    about:        app.about || "",
    saved: [],
    created: Date.now(),
  };
}

/** Is this login free across every tier that can sign in? */
function loginTaken(orgs, login){
  const lg = String(login || "").toLowerCase();
  if(!lg) return true;
  const hit = x => String(x && x.login || "").toLowerCase() === lg;
  return (orgs.companies || []).some(hit)
      || (orgs.associations || []).some(hit)
      || (orgs.analysts || []).some(hit)
      || all(orgs).some(hit)
      || hit(orgs.rais);
}

module.exports = { CHANNEL, LOGIN, view, adminView, authenticate, findById,
  profileSave, savedToggle, savedSuppliers, fromApplication, loginTaken, all };
