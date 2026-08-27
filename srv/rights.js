/* ============================================================
   RIGHTS — what a person may do about their own data

   ZRU-547 gives the subject four things, and a platform that
   only publishes a policy about them has done half the job.
   Each is answered by a route here:

   • ACCESS (modda 22) — be told what is held, why, who receives
     it and for how long. exportFor() returns the actual stored
     records, not a description of them.

   • CORRECTION — already available: every tier can edit its own
     cabinet profile, so nothing new is needed for it.

   • WITHDRAWAL OF CONSENT (modda 21) — consent that cannot be
     taken back is not consent. withdraw() records the act with
     the same evidentiary weight as the original agreement.

   • ERASURE — and this is the one worth being honest about.

   ---------------------------------------------------------
   WHY ERASURE IS A REQUEST AND NOT A BUTTON

   The tempting implementation is a "delete my account" button
   that removes the row. It would be unlawful here more often
   than not. Two obligations outlive consent:

     - transaction records, which accounting rules require be
       kept for five years, and which stop being the person's
       data to erase the moment they document a deal with a
       counterparty who has their own interest in them;
     - the consent record itself, which is the operator's only
       defence against a claim that data was processed without
       agreement. Erasing it on request destroys the evidence
       that the processing was lawful.

   So an erasure request is filed, answered by a named person
   inside RESPONSE_DAYS working days, and the answer says which
   data was erased and which was retained under which rule.
   That is what modda 22 actually asks for — a reasoned answer
   within a deadline — and it is defensible in a way that
   silently keeping data behind a delete button is not.

   Withdrawing consent, by contrast, IS immediate: it suspends
   the account, because consent is the ground the cabinet runs
   on, and nothing is lost by stopping.
   ============================================================ */
const H = require("./store");
const L = require("./legal");
const PW = require("./passwords");

const col  = H.collection("rights.json", ["requests", "events"]);
const load = col.load, save = col.save;

const KINDS  = ["access", "withdraw", "erase"];
const STATUS = ["open", "answered", "refused"];
const CAP = 4000;
const OPEN_PER_SUBJECT = 3;      // an open queue is not a place to shout twice

const ref = () => "DS-" + Math.random().toString(36).slice(2, 6).toUpperCase()
                 + "-" + Date.now().toString(36).slice(-4).toUpperCase();

/** Working days, not calendar days — the deadline the policy promises. */
function dueAt(from){
  let d = new Date(from), left = L.RESPONSE_DAYS;
  while(left > 0){
    d = new Date(d.getTime() + 864e5);
    const wd = d.getUTCDay();
    if(wd !== 0 && wd !== 6) left--;
  }
  return d.getTime();
}

/* ---------- who is asking ----------
   A right is exercised over ONE person's data, so the request has to be tied
   to an authenticated account. An e-mail typed into a public box would let
   anyone pull anyone's file, which is the breach the right is meant to
   prevent. Identity therefore comes from the same credentials the cabinet
   uses — never from the body. */
function subjectOf(core, body){
  const o = core.getOrgs();
  const lg = H.S(body.login, 80).trim(), pw = String(body.password == null ? "" : body.password);
  if(!lg) return null;

  const c = core.findCompany(o, lg, pw);
  if(c) return { tier: "company", id: c.id, name: c.name, email: c.email || "", raw: c, orgs: o };

  const b = (o.buyers || []).find(x => String(x.login || "").toLowerCase() === lg.toLowerCase()
                                    && PW.verify(x, pw));
  if(b) return { tier: "buyer", id: b.id, name: b.name, email: b.email || "", raw: b, orgs: o };

  const a = (o.associations || []).find(x => x.login === lg && PW.verify(x, pw));
  if(a) return { tier: "assoc", id: a.id, name: a.chairman || a.name, email: a.email || "", raw: a, orgs: o };

  return null;
}

/* ---------- access ----------
   Everything actually held, assembled from the stores that hold it. Kept
   deliberately literal: this is a subject-access response, so a paraphrase
   would defeat the point. Credentials are the one thing withheld, and the
   response says so rather than quietly omitting them. */
function exportFor(subject, core){
  const reg = safeLoad("registrations.json", ["applications"]);
  const applications = (reg.applications || [])
    .filter(a => sameSubject(a, subject))
    .map(a => { const { password, pwHash, ...rest } = a; return rest; });

  /* AI assistant threads are keyed by e-mail, which is how the assistant
     identifies an unauthenticated visitor as well. */
  let chats = [];
  try{
    const store = core.getStore() || {};
    const mine = subject.email ? store[subject.email] : null;
    chats = mine ? Object.values(mine.sessions || {}).map(s => ({
      id: s.id, title: s.title || "", created: s.created, updated: s.updated,
      messages: s.messages || [],
    })) : [];
  }catch(e){ chats = []; }

  const mine = load().requests.filter(r => r.subjectId === subject.id);

  return {
    generated: Date.now(),
    subject: { tier: subject.tier, id: subject.id, name: subject.name },
    /* the live account record, minus the credential */
    account: PW.strip(subject.raw),
    /* the application that created it, including the consent proof — the
       person is entitled to see the evidence held about their own agreement */
    applications,
    aiConversations: chats,
    rightsRequests: mine.map(publicRequest),
    notice: {
      withheld: {
        uz: "Parol qaytarilmas kriptografik shaklda saqlanadi va uni ochib bo'lmaydi — shuning uchun ushbu faylda yo'q.",
        ru: "Пароль хранится в необратимой криптографической форме и не может быть раскрыт — поэтому его нет в этом файле.",
        en: "The password is stored as an irreversible hash and cannot be disclosed, so it is not in this file.",
      },
      retention: L.RETENTION,
      transfers: L.TRANSFERS,
      contact: L.OPERATOR.dpoEmail,
    },
  };
}

/** Application rows belonging to this subject — by account id where the
    approval linked one, and by login otherwise for pre-approval rows. */
function sameSubject(a, subject){
  if(a.accountId && a.accountId === subject.id) return true;
  const lg = String(subject.raw && subject.raw.login || "").toLowerCase();
  return !!lg && String(a.login || "").toLowerCase() === lg;
}

function safeLoad(fileName, keys){
  try{ return H.collection(fileName, keys).load(); }
  catch(e){ const out = {}; for(const k of keys) out[k] = []; return out; }
}

/* ---------- withdrawal ----------
   Immediate, and it says what it costs. The account is suspended rather
   than deleted: deletion is the separate right below, and conflating them
   would erase transaction history the counterparty is entitled to. */
function withdraw(subject, core, req, body){
  const o = subject.orgs;
  const tierKey = { company: "companies", buyer: "buyers", assoc: "associations" }[subject.tier];
  const rec = (o[tierKey] || []).find(x => x.id === subject.id);
  if(!rec) return { error: "not_found" };

  if(rec.consentWithdrawn) return { error: "already_withdrawn" };

  rec.consentWithdrawn = L.consentRecord(req, false);
  rec.suspended = true;
  rec.suspendedReason = "consent_withdrawn";
  core.saveOrgs(o);

  const filed = file(subject, "withdraw", req, H.S(body && body.note, 1000));
  return { ok: true, ref: filed.ref, due: filed.due,
    effect: {
      uz: "Rozilik qaytarib olindi. Kabinetga kirish to'xtatildi. Bitim hujjatlari qonun talab qilgan muddat davomida saqlanadi.",
      ru: "Согласие отозвано. Доступ в кабинет приостановлен. Документы сделок хранятся в течение установленного законом срока.",
      en: "Consent withdrawn. Cabinet access is suspended. Transaction records are kept for the period the law requires.",
    } };
}

/* ---------- erasure ----------
   Filed, not executed. See the header for why. */
function requestErasure(subject, req, body){
  const r = file(subject, "erase", req, H.S(body && body.note, 1000));
  return { ok: true, ref: r.ref, due: r.due, request: publicRequest(r) };
}

/** The shared filing step behind every kind of request. */
function file(subject, kind, req, note){
  const st = load();
  const k = KINDS.includes(kind) ? kind : "access";

  const open = st.requests.filter(r => r.subjectId === subject.id && r.status === "open");
  if(open.length >= OPEN_PER_SUBJECT){
    const dup = open.find(r => r.kind === k);
    if(dup) return dup;                       // re-asking does not restart the clock
  }

  const now = Date.now();
  const row = {
    id: H.uid("ds"), ref: ref(), kind: k,
    subjectTier: subject.tier, subjectId: subject.id, subjectName: subject.name,
    subjectEmail: subject.email || "",
    note: note || "",
    status: "open", answer: "", answeredBy: "", answered: 0,
    created: now, due: dueAt(now),
    /* the same evidentiary shape as a consent, because a request and its
       answer are the record that the deadline was met */
    filedFrom: { ip: L.clientIp(req), ua: String((req.headers || {})["user-agent"] || "").slice(0, 200) },
  };
  st.requests = st.requests.concat([row]).slice(-CAP);
  H.logEvent(st, "dsr_filed", { requestId: row.id, kind: k, tier: subject.tier });
  save(st);
  return row;
}

const publicRequest = r => ({
  ref: r.ref, kind: r.kind, status: r.status, note: r.note,
  answer: r.answer || "", created: r.created, due: r.due, answered: r.answered || 0,
});

/* ---------- oversight side ----------
   The queue exists so somebody is accountable for the deadline. Overdue is
   computed rather than stored, so it is always true as of now. */
function list(filter){
  const f = filter || {};
  let rows = load().requests.slice();
  if(f.status && STATUS.includes(f.status)) rows = rows.filter(r => r.status === f.status);
  const now = Date.now();
  return rows
    .sort((a, b) => (a.status === "open" ? 0 : 1) - (b.status === "open" ? 0 : 1) || a.due - b.due)
    .map(r => Object.assign({}, r, { overdue: r.status === "open" && r.due < now }));
}

function answer(id, body, actor){
  const st = load();
  const r = st.requests.find(x => x.id === H.S(id, 40) || x.ref === H.S(id, 40).toUpperCase());
  if(!r) return { error: "not_found" };
  if(r.status !== "open") return { error: "already_answered" };

  const status = body.refuse ? "refused" : "answered";
  const text = H.S(body.answer, 4000);
  /* A refusal without a reason is not an answer — modda 22 requires the
     ground to be given, so the queue will not accept an empty one. */
  if(!text) return { error: "answer_required" };

  Object.assign(r, { status, answer: text, answeredBy: H.S(actor && actor.name, 160),
    answered: Date.now() });
  st.requests = st.requests.map(x => (x.id === r.id ? r : x));
  H.logEvent(st, "dsr_answered", { requestId: r.id, kind: r.kind, status });
  save(st);
  return { ok: true, request: r };
}

/** Open requests past their deadline — surfaced on the admin dashboard so a
    missed deadline is visible before a regulator is the one who notices. */
function overdueCount(){
  const now = Date.now();
  return load().requests.filter(r => r.status === "open" && r.due < now).length;
}

module.exports = { subjectOf, exportFor, withdraw, requestErasure, file,
  list, answer, overdueCount, publicRequest, dueAt, KINDS, STATUS };
