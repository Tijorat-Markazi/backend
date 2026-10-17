/* ============================================================
   REGISTRATION — companies apply, and now buyers do too

   Until this file existed a company account could only be
   created from the inside: an admin, or the association, typed
   in a name and handed over a login. This lets an organisation
   apply for itself.

   It is an application, not an instant account. Two KINDS run
   through the same queue, and they differ in exactly one thing
   that matters — who is allowed to say yes:

   • company — approved by the association it names. The
     platform's trust model rests on a company being vouched for
     by a sector body; that is what "Company Verified" (L2) means
     on the Bozor trust ladder. The admin can act for any of them.

   • buyer — approved by OVERSIGHT ONLY. No association vouches
     for a buyer: they join no sector body, and asking one to
     rule on a stranger would be a rubber stamp with a signature
     on it. A buyer application carries no assocId at all, which
     is also why listFor() cannot accidentally surface one.

   The chosen password lives on the application only while it is
   pending: approval moves it onto the account record, rejection
   discards it. Nothing else here is secret.
   ============================================================ */
const H  = require("./store");
const BY = require("./buyer");
const PW = require("./passwords");
const L  = require("./legal");

const STATUS = ["pending", "approved", "rejected"];
const KINDS  = ["company", "buyer"];
const CAP = 3000;                       // the endpoint is public; the list is bounded
const MAX_PENDING_PER_EMAIL = 5;

const col  = H.collection("registrations.json", ["applications", "events"]);
const save = col.save;

/* ---------- migration ----------
   Applications submitted before credentials were hashed still carry the
   applicant's chosen password in the clear, and approveCompany() now reads
   `pwHash` — so a legacy row would not just leak, it would mint an account
   nobody could sign in to. Both problems end the first time the queue is
   read: the plaintext becomes a hash in place, and the row is saved.

   This sits in load() rather than in a one-off script because the queue is
   also written to by a running server; a migration that only ran at boot
   would miss anything restored from a backup afterwards. */
function load(){
  const st = col.load();
  let moved = 0;
  for(const a of st.applications){
    if(a && typeof a.password === "string" && a.password){
      if(!a.pwHash) a.pwHash = PW.hash(a.password);
      delete a.password;
      moved++;
    }
  }
  if(moved){
    save(st);
    console.log(`  [passwords] ${moved} pending application(s) hashed`);
  }
  return st;
}

/* Applications written before buyers existed have no `kind`. They were all
   companies, and saying so here means nothing downstream has to keep asking. */
const kindOf = a => (KINDS.includes(a && a.kind) ? a.kind : "company");

/* A short human-quotable reference, so an applicant can ask about it. */
const makeRef = () => "TM-" + Math.random().toString(36).slice(2, 6).toUpperCase()
                            + "-" + Date.now().toString(36).slice(-4).toUpperCase();

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const LOGIN = /^[a-z0-9][a-z0-9._-]{2,39}$/;   // what the login box already accepts elsewhere

/** Everything the applicant may see about their own application. */
const publicView = a => ({
  id: a.id, ref: a.ref, name: a.name, sector: a.sector, assocName: a.assocName,
  kind: kindOf(a),
  status: a.status, reason: a.reason || "", login: a.login,
  created: a.created, decided: a.decided || 0,
});

/** What an approver needs to judge it — contact details included, no password. */
const reviewView = a => {
  const { password, pwHash, ...rest } = a;
  return Object.assign(rest, { kind: kindOf(a) });
};

/* ---------- shared validation ----------
   A login has to be free against every tier that can sign in, not just the
   one this applicant is joining: /api/auth/login resolves rais → association
   → company → analyst → buyer in order, so a duplicate across tiers would be
   permanently shadowed by whichever is checked first. It also has to be free
   against anything already queued, or two approvals would race for the name. */
function loginFree(st, orgs, login){
  if(BY.loginTaken(orgs, login)) return "login_taken";
  if(st.applications.some(a => a.status === "pending" && a.login === login)) return "login_pending";
  return "";
}

/* Modda 21 ZRU-547 makes the OPERATOR prove consent was given. The form
   already refused to submit without the box ticked, but that check lived in
   the browser and left nothing behind — a person could deny ever agreeing and
   there would be no record to set against it. The gate is re-run here, where
   it cannot be skipped by posting straight at the endpoint, and what it
   produces is stored: document versions, timestamp, truncated address, agent. */
function consentGate(body, req){
  if(body.consent !== true && body.consent !== "true") return { error: "consent_required" };
  return { ok: true, record: L.consentRecord(req, true) };
}

function underEmailCap(st, email){
  return st.applications.filter(a => a.email === email && a.status === "pending").length
    < MAX_PENDING_PER_EMAIL;
}

/* ---------- company applications ---------- */
function submit(body, orgs, req){
  const st = load();

  const name    = H.S(body.name, 200);
  const sector  = H.S(body.sector, 120);
  const assocId = H.S(body.assocId, 40);
  const login   = H.S(body.login, 40).toLowerCase();
  const password= String(body.password == null ? "" : body.password);
  const email   = H.S(body.email, 120).toLowerCase();

  if(!name)   return { error: "name_required" };
  if(!assocId) return { error: "assoc_required" };
  const assoc = (orgs.associations || []).find(a => String(a.id) === assocId);
  if(!assoc)  return { error: "assoc_unknown" };
  if(!EMAIL.test(email)) return { error: "email_invalid" };
  if(!LOGIN.test(login)) return { error: "login_invalid" };
  if(password.length < 8) return { error: "password_short" };

  const gate = consentGate(body, req);
  if(gate.error) return gate;

  const clash = loginFree(st, orgs, login);
  if(clash) return { error: clash };
  if(!underEmailCap(st, email)) return { error: "too_many_pending" };

  const row = {
    id: H.uid("rg"),
    ownerId: require("./auth").owner(),
    ref: makeRef(),
    kind: "company",
    name, sector,
    assocId, assocName: H.S(assoc.name, 200),
    /* Hashed on arrival. A pending application used to hold the chosen
       password in the clear for as long as the queue took to move. */
    login, pwHash: PW.hash(password),
    consent: gate.record,
    email,
    phone:       H.S(body.phone, 60),
    contactName: H.S(body.contactName, 160),
    role:        H.S(body.role, 120),
    region:      H.S(body.region, 120),
    tin:         H.S(body.tin, 40),          // STIR / tax number, if they give one
    website:     /^https?:\/\//i.test(H.S(body.website, 300)) ? H.S(body.website, 300) : "",
    about:       H.S(body.about, 2000),
    status: "pending", reason: "",
    created: Date.now(), decided: 0, decidedBy: "",
  };

  st.applications = st.applications.concat([row]).slice(-CAP);
  H.logEvent(st, "registration_submitted",
    { applicationId: row.id, kind: "company", assocId, sector: row.sector, region: row.region });
  save(st);
  return { ok: true, application: publicView(row) };
}

/* ---------- buyer applications ----------
   Deliberately shorter than the company form. A buyer is not published
   anywhere — no showroom, no sector directory, no association page — so the
   only things asked for are what an approver needs to believe this is a real
   organisation, and what a seller needs in order to answer them. */
function submitBuyer(body, orgs, req){
  const st = load();

  const name     = H.S(body.name, 200);
  const phone    = H.S(body.phone, 60);            // the COMPANY's number
  const login    = H.S(body.login, 40).toLowerCase();
  const password = String(body.password == null ? "" : body.password);
  const email    = H.S(body.email, 120).toLowerCase();
  const contactName = H.S(body.contactName, 160);

  if(!name)  return { error: "name_required" };
  if(!phone) return { error: "phone_required" };
  if(!contactName) return { error: "contact_required" };
  if(!EMAIL.test(email))  return { error: "email_invalid" };
  if(!LOGIN.test(login))  return { error: "login_invalid" };
  if(password.length < 8) return { error: "password_short" };

  const gate = consentGate(body, req);
  if(gate.error) return gate;

  const clash = loginFree(st, orgs, login);
  if(clash) return { error: clash };
  if(!underEmailCap(st, email)) return { error: "too_many_pending" };

  const row = {
    id: H.uid("rg"),
    ownerId: require("./auth").owner(),
    ref: makeRef(),
    kind: "buyer",
    name,
    /* No association vouches for a buyer. Both fields stay empty rather than
       being faked, because listFor() reads assocId to decide what an
       association may see. */
    assocId: "", assocName: "",
    sector: "",
    login, pwHash: PW.hash(password),
    consent: gate.record,
    email,
    phone,                                          // company number
    contactPhone: H.S(body.contactPhone, 60),       // the person's own line
    contactName,
    role:   H.S(body.role, 120),
    region: H.S(body.region, 120),
    about:  H.S(body.about, 2000),
    status: "pending", reason: "",
    created: Date.now(), decided: 0, decidedBy: "",
  };

  st.applications = st.applications.concat([row]).slice(-CAP);
  H.logEvent(st, "registration_submitted",
    { applicationId: row.id, kind: "buyer", region: row.region });
  save(st);
  return { ok: true, application: publicView(row) };
}

/** Pending first, then most recently decided — the queue reads top-down. */
const order = (a, b) =>
  (a.status === "pending" ? 0 : 1) - (b.status === "pending" ? 0 : 1)
  || (b.created - a.created);

/* An association sees company applications addressed to it, and nothing else.
   The kind test is not redundant with the assocId test — it is what stops a
   future application type from leaking in here by leaving assocId unset. */
function listFor(assocId, filter){
  const f = filter || {};
  let rows = load().applications
    .filter(a => kindOf(a) === "company" && String(a.assocId) === String(assocId));
  if(f.status && STATUS.includes(f.status)) rows = rows.filter(a => a.status === f.status);
  return rows.sort(order).map(reviewView);
}

function listAll(filter){
  const f = filter || {};
  let rows = load().applications.slice();
  if(f.kind && KINDS.includes(f.kind)) rows = rows.filter(a => kindOf(a) === f.kind);
  if(f.status && STATUS.includes(f.status)) rows = rows.filter(a => a.status === f.status);
  if(f.assocId) rows = rows.filter(a => String(a.assocId) === String(f.assocId));
  return rows.sort(order).map(reviewView);
}

/** Counts for a sidebar badge. `kind` narrows it to one queue. */
const counts = (assocId, kind) => {
  const rows = load().applications
    .filter(a => !assocId || String(a.assocId) === String(assocId))
    .filter(a => !kind || kindOf(a) === kind);
  return { pending: rows.filter(a => a.status === "pending").length, total: rows.length };
};

/**
 * Approve or reject. Approval is what actually creates the account, so it
 * re-checks the login against every live tier: the queue may have sat long
 * enough for someone else to take the name.
 */
function decide(body, actor, orgs, saveOrgs){
  const st = load();
  const id = H.S(body.id, 40);
  const app = st.applications.find(a => a.id === id);
  if(!app) return { error: "not_found" };
  if(app.status !== "pending") return { error: "already_decided", status: app.status };

  const kind = kindOf(app);

  /* An association may only rule on company applications addressed to it —
     and on a buyer, never. Oversight is the only approver for that tier. */
  if(actor.type === "assoc"){
    if(kind !== "company") return { error: "forbidden" };
    if(String(app.assocId) !== String(actor.id)) return { error: "forbidden" };
  }

  const action = H.ONE(body.action, ["approve", "reject"], "");
  if(!action) return { error: "bad_action" };

  if(action === "reject"){
    const reason = H.S(body.reason, 500);
    if(!reason) return { error: "reason_required" };
    const next = Object.assign({}, app, { status: "rejected", reason,
      decided: Date.now(), decidedBy: H.S(actor.name, 160), password: "" });
    st.applications = st.applications.map(a => (a.id === id ? next : a));
    H.logEvent(st, "registration_rejected", { applicationId: id, kind, by: actor.type });
    save(st);
    return { ok: true, application: reviewView(next) };
  }

  if(BY.loginTaken(orgs, app.login)) return { error: "login_taken" };

  const created = kind === "buyer"
    ? approveBuyer(app, orgs, saveOrgs)
    : approveCompany(app, orgs, saveOrgs);

  const next = Object.assign({}, app, { status: "approved", decided: Date.now(),
    decidedBy: H.S(actor.name, 160), accountId: created.id, companyId: created.id, pwHash: "" });
  st.applications = st.applications.map(a => (a.id === id ? next : a));
  H.logEvent(st, "registration_approved",
    { applicationId: id, kind, accountId: created.id, assocId: app.assocId, by: actor.type });
  save(st);

  /* The approver sees the login once so they can pass it on; the password is
     the applicant's own, so it is never echoed back. */
  return { ok: true, application: reviewView(next), kind,
    account: { id: created.id, name: created.name, login: created.login },
    company: { id: created.id, name: created.name, login: created.login } };
}

/* The applicant already gave a reachable e-mail, phone, region and site.
   Those used to stay behind in the application queue, so an approved company
   started life with an empty Business ID card and had to retype what it had
   just submitted. They are carried across instead — the org can still edit
   them from its cabinet afterwards. */
function approveCompany(app, orgs, saveOrgs){
  const company = {
    id: H.uid("c"),
    name: app.name,
    assocId: app.assocId,
    sector: app.sector,
    login: app.login,
    pwHash: app.pwHash || "",
    email: app.email || "",
    phone: app.phone || "",
    location: app.region || "",
    website: app.website || "",
    showroom: [],
    created: Date.now(),
  };
  orgs.companies = (orgs.companies || []).concat([company]);
  saveOrgs(orgs);
  return company;
}

function approveBuyer(app, orgs, saveOrgs){
  const buyer = BY.fromApplication(app);
  orgs.buyers = BY.all(orgs).concat([buyer]);
  saveOrgs(orgs);
  return buyer;
}

/** An applicant checks their own application with the pair they were given. */
function status(email, ref){
  const e = H.S(email, 120).toLowerCase();
  const r = H.S(ref, 40).toUpperCase();
  if(!e || !r) return { error: "identify_first" };
  const app = load().applications.find(a => a.ownerId === require("./auth").owner() && String(a.ref).toUpperCase() === r);
  if(!app) return { error: "not_found" };
  return { ok: true, application: publicView(app) };
}

module.exports = { STATUS, KINDS, kindOf, submit, submitBuyer, listFor, listAll, counts,
  decide, status, publicView, reviewView, load, save };
