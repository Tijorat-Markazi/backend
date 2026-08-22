/* ============================================================
   COMPANY REGISTRATION

   Until now a company account could only be created from the
   inside: an admin, or the association, typed in a name and
   handed over a login. This lets a company apply for itself.

   It is an application, not an instant account. The platform's
   whole trust model rests on a company being vouched for by an
   association — that is what "Company Verified" (L2) means in
   the Bozor trust ladder — so the association it names is the
   one that approves it, and the admin can act for any of them.

   The chosen password lives on the application only while it is
   pending: approval moves it onto the company record, rejection
   discards it. Nothing else here is secret.
   ============================================================ */
const H = require("./store");

const STATUS = ["pending", "approved", "rejected"];
const CAP = 3000;                       // the endpoint is public; the list is bounded
const MAX_PENDING_PER_EMAIL = 5;

const col  = H.collection("registrations.json", ["applications", "events"]);
const load = col.load, save = col.save;

/* A short human-quotable reference, so an applicant can ask about it. */
const makeRef = () => "TM-" + Math.random().toString(36).slice(2, 6).toUpperCase()
                            + "-" + Date.now().toString(36).slice(-4).toUpperCase();

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const LOGIN = /^[a-z0-9][a-z0-9._-]{2,39}$/;   // what the login box already accepts elsewhere

/** Everything the applicant may see about their own application. */
const publicView = a => ({
  id: a.id, ref: a.ref, name: a.name, sector: a.sector, assocName: a.assocName,
  status: a.status, reason: a.reason || "", login: a.login,
  created: a.created, decided: a.decided || 0,
});

/** What an approver needs to judge it — contact details included, no password. */
const reviewView = a => {
  const { password, ...rest } = a;
  return rest;
};

function submit(body, orgs){
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

  /* A login has to be free against live accounts AND against anything already
     queued, or two approvals would race for the same name. */
  if((orgs.companies || []).some(c => String(c.login).toLowerCase() === login))
    return { error: "login_taken" };
  if(st.applications.some(a => a.status === "pending" && a.login === login))
    return { error: "login_pending" };

  const mine = st.applications.filter(a => a.email === email && a.status === "pending");
  if(mine.length >= MAX_PENDING_PER_EMAIL) return { error: "too_many_pending" };

  const row = {
    id: H.uid("rg"),
    ref: makeRef(),
    name, sector,
    assocId, assocName: H.S(assoc.name, 200),
    login, password,
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
    { applicationId: row.id, assocId, sector: row.sector, region: row.region });
  save(st);
  return { ok: true, application: publicView(row) };
}

/** Pending first, then most recently decided — the queue reads top-down. */
const order = (a, b) =>
  (a.status === "pending" ? 0 : 1) - (b.status === "pending" ? 0 : 1)
  || (b.created - a.created);

function listFor(assocId, filter){
  const f = filter || {};
  let rows = load().applications.filter(a => String(a.assocId) === String(assocId));
  if(f.status && STATUS.includes(f.status)) rows = rows.filter(a => a.status === f.status);
  return rows.sort(order).map(reviewView);
}

function listAll(filter){
  const f = filter || {};
  let rows = load().applications.slice();
  if(f.status && STATUS.includes(f.status)) rows = rows.filter(a => a.status === f.status);
  if(f.assocId) rows = rows.filter(a => String(a.assocId) === String(f.assocId));
  return rows.sort(order).map(reviewView);
}

const counts = assocId => {
  const rows = load().applications
    .filter(a => !assocId || String(a.assocId) === String(assocId));
  return { pending: rows.filter(a => a.status === "pending").length, total: rows.length };
};

/**
 * Approve or reject. Approval is what actually creates the company account,
 * so it re-checks the login against live accounts: the queue may have sat
 * long enough for someone else to take the name.
 */
function decide(body, actor, orgs, saveOrgs){
  const st = load();
  const id = H.S(body.id, 40);
  const app = st.applications.find(a => a.id === id);
  if(!app) return { error: "not_found" };
  if(app.status !== "pending") return { error: "already_decided", status: app.status };

  /* An association may only rule on applications addressed to it. */
  if(actor.type === "assoc" && String(app.assocId) !== String(actor.id))
    return { error: "forbidden" };

  const action = H.ONE(body.action, ["approve", "reject"], "");
  if(!action) return { error: "bad_action" };

  if(action === "reject"){
    const reason = H.S(body.reason, 500);
    if(!reason) return { error: "reason_required" };
    const next = Object.assign({}, app, { status: "rejected", reason,
      decided: Date.now(), decidedBy: H.S(actor.name, 160), password: "" });
    st.applications = st.applications.map(a => (a.id === id ? next : a));
    H.logEvent(st, "registration_rejected", { applicationId: id, by: actor.type });
    save(st);
    return { ok: true, application: reviewView(next) };
  }

  if((orgs.companies || []).some(c => String(c.login).toLowerCase() === app.login))
    return { error: "login_taken" };

  const company = {
    id: H.uid("c"),
    name: app.name,
    assocId: app.assocId,
    sector: app.sector,
    login: app.login,
    password: app.password,
    showroom: [],
    created: Date.now(),
  };
  orgs.companies = (orgs.companies || []).concat([company]);
  saveOrgs(orgs);

  const next = Object.assign({}, app, { status: "approved", decided: Date.now(),
    decidedBy: H.S(actor.name, 160), companyId: company.id, password: "" });
  st.applications = st.applications.map(a => (a.id === id ? next : a));
  H.logEvent(st, "registration_approved",
    { applicationId: id, companyId: company.id, assocId: app.assocId, by: actor.type });
  save(st);

  /* The approver sees the login once so they can pass it on; the password is
     the applicant's own, so it is never echoed back. */
  return { ok: true, application: reviewView(next),
    company: { id: company.id, name: company.name, login: company.login } };
}

/** An applicant checks their own application with the pair they were given. */
function status(email, ref){
  const e = H.S(email, 120).toLowerCase();
  const r = H.S(ref, 40).toUpperCase();
  if(!e || !r) return { error: "identify_first" };
  const app = load().applications.find(a => a.email === e && String(a.ref).toUpperCase() === r);
  if(!app) return { error: "not_found" };
  return { ok: true, application: publicView(app) };
}

module.exports = { STATUS, submit, listFor, listAll, counts, decide, status,
  publicView, reviewView, load, save };
