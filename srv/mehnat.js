/* ============================================================
   HUMAN CAPITAL MARKAZI — "Mehnat bozori"
   TZ: "Tijorat markazi — Human Capital Markazi", AI Lab, v1.0

   The TZ is emphatic (§27): this must not be built as a job
   board. Every hiring action is captured as a structured market
   event from day one, because the Labor Market Intelligence
   layer is computed from that stream, not from advert counts.
   ============================================================ */
const H = require("./store");

const SENIORITY  = ["intern", "junior", "middle", "senior", "lead", "head"];
const FORMATS    = ["onsite", "hybrid", "remote"];
const EMPLOYMENT = ["full", "part", "shift", "project", "seasonal", "internship"];
const AVAILABILITY = ["active", "open", "passive", "unavailable"];
const CURRENCIES = ["UZS", "USD"];
/* §7.1 — the eight-stage standard pipeline */
const STAGES = ["applied", "screening", "assessment", "interview", "offer", "hired", "rejected", "withdrawn"];
/* §7.2 — rejection reason codes are mandatory; free text alone poisons the analytics */
const REASONS = ["salary", "skill", "location", "availability", "culture", "experience", "no-show", "other"];
const VISIBILITY = ["public", "applied-only", "anonymous", "hidden"];

const col  = H.collection("mehnat.json", ["candidates", "vacancies", "applications", "events"]);
const load = col.load, save = col.save;

/* ---------- candidate: Human Capital Passport (§5.1) ---------- */
function candidateSave(actor, body){
  const st   = load();
  const prev = st.candidates.find(c => c.ownerId === actor.id);
  const row  = {
    id:        prev ? prev.id : H.uid("cd"),
    ownerId:   H.S(actor.id, 80),
    name:      H.S(body.name || actor.name, 160),
    headline:  H.S(body.headline, 200),
    region:    H.S(body.region, 120),
    occupation:H.S(body.occupation, 160),
    seniority: H.ONE(body.seniority, SENIORITY, "middle"),
    years:     H.N(body.years),
    skills:    H.LIST(body.skills, 40, 60),
    languages: H.LIST(body.languages, 8, 40),
    certificates: H.LIST(body.certificates, 12, 120),
    education: H.S(body.education, 400),
    experience:H.S(body.experience, 4000),
    portfolio: /^https?:\/\//i.test(H.S(body.portfolio, 400)) ? H.S(body.portfolio, 400) : "",
    expectedMin: H.N(body.expectedMin),
    expectedMax: H.N(body.expectedMax),
    currency:  H.ONE(body.currency, CURRENCIES, "UZS"),
    availability: H.ONE(body.availability, AVAILABILITY, "open"),
    availableFrom: H.S(body.availableFrom, 20),
    formats:   H.SUBSET(body.formats, FORMATS, 3),
    employment:H.SUBSET(body.employment, EMPLOYMENT, 6),
    relocate:  H.BOOL(body.relocate),
    intent:    H.S(body.intent, 600),
    /* §19 — the candidate, not the employer, decides how visible they are */
    visibility:H.ONE(body.visibility, VISIBILITY, "public"),
    verified:  prev ? prev.verified : false,
    created:   prev ? prev.created : Date.now(),
    updated:   Date.now(),
  };
  if(!row.name) return { error: "name_required" };
  st.candidates = prev ? st.candidates.map(c => (c.id === prev.id ? row : c)) : st.candidates.concat([row]);
  H.logEvent(st, prev ? "profile_updated" : "profile_created",
    { candidateId: row.id, occupation: row.occupation, region: row.region,
      seniority: row.seniority, skills: row.skills, availability: row.availability });
  if(prev && prev.availability !== row.availability){
    H.logEvent(st, "profile_availability_changed", { candidateId: row.id, status: row.availability });
  }
  save(st);
  return { ok: true, candidate: row };
}

/** What an employer is allowed to see, per the candidate's own visibility setting. */
function candidateView(c, opts){
  const o = opts || {};
  const anon = c.visibility === "anonymous" && !o.full;
  return {
    id: c.id,
    name: anon ? (c.occupation || "Nomzod") + " · anonim" : c.name,
    headline: c.headline, region: c.region, occupation: c.occupation,
    seniority: c.seniority, years: c.years, skills: c.skills, languages: c.languages,
    certificates: c.certificates, education: anon ? "" : c.education,
    experience: anon ? "" : c.experience, portfolio: anon ? "" : c.portfolio,
    expectedMin: c.expectedMin, expectedMax: c.expectedMax, currency: c.currency,
    availability: c.availability, availableFrom: c.availableFrom,
    formats: c.formats, employment: c.employment, relocate: c.relocate,
    verified: c.verified, visibility: c.visibility, updated: c.updated,
  };
}

const candidateOf = ownerId => load().candidates.find(c => c.ownerId === ownerId) || null;

/* ---------- vacancy: Smart Vacancy Builder (§6.2) ---------- */
function vacancySave(company, body){
  const st   = load();
  const id   = H.S(body.id, 40);
  const prev = id ? st.vacancies.find(v => v.id === id && v.companyId === company.id) : null;
  if(id && !prev) return { error: "not_found" };

  const row = {
    id:          prev ? prev.id : H.uid("vc"),
    companyId:   company.id,
    companyName: H.S(company.name, 160),
    sector:      H.S(company.sector, 120),
    title:       H.S(body.title, 200),
    occupation:  H.S(body.occupation, 160),
    summary:     H.S(body.summary, 3000),
    duties:      H.S(body.duties, 2000),
    skillsRequired:  H.LIST(body.skillsRequired, 25, 60),
    skillsPreferred: H.LIST(body.skillsPreferred, 25, 60),
    languages:   H.LIST(body.languages, 6, 40),
    certificates:H.LIST(body.certificates, 8, 120),
    seniority:   H.ONE(body.seniority, SENIORITY, "middle"),
    yearsMin:    H.N(body.yearsMin),
    salaryMin:   H.N(body.salaryMin),
    salaryMax:   H.N(body.salaryMax),
    currency:    H.ONE(body.currency, CURRENCIES, "UZS"),
    region:      H.S(body.region, 120),
    format:      H.ONE(body.format, FORMATS, "onsite"),
    employment:  H.ONE(body.employment, EMPLOYMENT, "full"),
    headcount:   Math.max(1, H.N(body.headcount, 1)),
    deadline:    H.S(body.deadline, 20),
    contact:     H.S(body.contact, 200),
    status:      H.ONE(body.status, ["draft", "open", "closed"], "open"),
    created:     prev ? prev.created : Date.now(),
    updated:     Date.now(),
  };
  if(!row.title) return { error: "title_required" };

  st.vacancies = prev ? st.vacancies.map(v => (v.id === prev.id ? row : v)) : st.vacancies.concat([row]);
  H.logEvent(st, prev ? "vacancy_updated" : "vacancy_created",
    { vacancyId: row.id, occupation: row.occupation, region: row.region, seniority: row.seniority,
      skills: row.skillsRequired, salaryMin: row.salaryMin, salaryMax: row.salaryMax,
      currency: row.currency, headcount: row.headcount, sector: row.sector });
  save(st);
  return { ok: true, vacancy: row, warnings: vacancyWarnings(row) };
}

/** §6.2 — flag requirements that read as discriminatory or simply impossible. */
function vacancyWarnings(v){
  const out = [];
  const text = [v.title, v.summary, v.duties].join(" ").toLowerCase();
  if(/\b(erkak|ayol|мужчин|женщин|male only|female only)\b/.test(text))
    out.push("Jins boʻyicha talab — bu diskriminatsion va matching uchun ishlatilmaydi.");
  if(/\b(\d{2})\s*(yosh|лет|years old)\b/.test(text))
    out.push("Yosh boʻyicha talab — bu diskriminatsion va matching uchun ishlatilmaydi.");
  if(v.yearsMin > 15) out.push("Talab qilinayotgan tajriba juda yuqori — nomzodlar oqimi keskin torayadi.");
  if(v.seniority === "junior" && v.yearsMin >= 5) out.push("Junior lavozimga 5+ yil tajriba mantiqsiz.");
  if(!v.salaryMin && !v.salaryMax) out.push("Ish haqi koʻrsatilmagan — ariza konversiyasi sezilarli pasayadi.");
  if(v.skillsRequired.length > 12) out.push("Majburiy skilllar juda koʻp — bir qismini 'afzal' ga oʻtkazing.");
  return out;
}

function vacancyClose(company, id){
  const st = load();
  const v  = st.vacancies.find(x => x.id === id && x.companyId === company.id);
  if(!v) return { error: "not_found" };
  st.vacancies = st.vacancies.map(x => (x.id === id ? Object.assign({}, x, { status: "closed", updated: Date.now() }) : x));
  H.logEvent(st, "vacancy_closed", { vacancyId: id, occupation: v.occupation,
    days: Math.round((Date.now() - v.created) / 864e5) });
  save(st);
  return { ok: true };
}

const vacanciesOf = companyId => load().vacancies
  .filter(v => v.companyId === companyId).sort((a, b) => b.updated - a.updated);

/* ---------- job search ---------- */
function searchJobs(q){
  const st = load();
  const query = H.S(q.q, 300);
  const want  = query ? H.tokens(query) : null;
  let rows = st.vacancies.filter(v => v.status === "open");

  if(q.region)     rows = rows.filter(v => v.region === H.S(q.region, 120));
  if(q.seniority)  rows = rows.filter(v => v.seniority === H.S(q.seniority, 20));
  if(q.format)     rows = rows.filter(v => v.format === H.S(q.format, 20));
  if(q.employment) rows = rows.filter(v => v.employment === H.S(q.employment, 20));
  if(q.sector)     rows = rows.filter(v => v.sector === H.S(q.sector, 120));
  if(H.N(q.salaryMin)) rows = rows.filter(v => H.N(v.salaryMax) >= H.N(q.salaryMin) || H.N(v.salaryMin) >= H.N(q.salaryMin));

  if(want){
    rows = rows.map(v => ({ v, r: H.coverage(want, [v.title, v.occupation, v.summary, v.duties,
      v.skillsRequired.join(" "), v.skillsPreferred.join(" ")].join(" ")) }))
      .filter(x => x.r > 0).sort((a, b) => b.r - a.r).map(x => x.v);
  } else {
    rows = rows.slice().sort((a, b) => b.updated - a.updated);
  }

  H.logEvent(st, "search_performed", { q: query, region: H.S(q.region, 120), results: rows.length });
  save(st);

  const all = st.vacancies.filter(v => v.status === "open");
  return {
    items: rows.slice(0, 200).map(v => Object.assign({}, v, {
      applicants: st.applications.filter(a => a.vacancyId === v.id).length })),
    total: rows.length,
    facets: {
      regions:     H.countBy(all, v => v.region).map(x => x.label),
      sectors:     H.countBy(all, v => v.sector).map(x => x.label),
      occupations: H.countBy(all, v => v.occupation).map(x => x.label),
      seniority:   SENIORITY, formats: FORMATS, employment: EMPLOYMENT,
    },
  };
}

/* ---------- talent search (§6.3) ---------- */
function searchTalent(q){
  const st    = load();
  const query = H.S(q.q, 300);
  const want  = query ? H.tokens(query) : null;
  let rows = st.candidates.filter(c => c.visibility === "public" || c.visibility === "anonymous");

  if(q.region)    rows = rows.filter(c => c.region === H.S(q.region, 120));
  if(q.seniority) rows = rows.filter(c => c.seniority === H.S(q.seniority, 20));
  if(q.availability) rows = rows.filter(c => c.availability === H.S(q.availability, 20));
  if(H.BOOL(q.verified)) rows = rows.filter(c => c.verified);
  if(q.skill){
    const s = H.S(q.skill, 60).toLowerCase();
    rows = rows.filter(c => (c.skills || []).some(x => x.toLowerCase().includes(s)));
  }
  if(want){
    rows = rows.map(c => ({ c, r: H.coverage(want, [c.headline, c.occupation, c.skills.join(" "), c.experience].join(" ")) }))
      .filter(x => x.r > 0).sort((a, b) => b.r - a.r).map(x => x.c);
  } else {
    rows = rows.slice().sort((a, b) => b.updated - a.updated);
  }

  H.logEvent(st, "talent_search", { q: query, region: H.S(q.region, 120), results: rows.length });
  save(st);

  const all = st.candidates.filter(c => c.visibility !== "hidden");
  return {
    items: rows.slice(0, 200).map(c => candidateView(c)),
    total: rows.length,
    facets: {
      regions: H.countBy(all, c => c.region).map(x => x.label),
      skills:  H.countBy(all, c => c.skills).slice(0, 60).map(x => x.label),
      seniority: SENIORITY, availability: AVAILABILITY,
    },
  };
}

/* ---------- AI Matching Engine (§8.1) ----------
   Weights are exactly those the TZ tables: core skills 30, relevant
   experience 18, seniority 10, location 8, compensation 10, availability 7,
   language/certification 7, assessment evidence 5, preference fit 5.
   §8.2 requires a bidirectional score — the same factors read from each
   side — plus reasons and gaps. §16.2 forbids sensitive attributes; none
   are collected, so none can leak into ranking. */
function matchPair(cand, vac){
  const core = H.listFit(vac.skillsRequired, cand.skills);
  const pref = H.listFit(vac.skillsPreferred, cand.skills);
  const exp  = H.coverage(H.tokens([vac.title, vac.occupation, vac.duties].join(" ")),
    [cand.headline, cand.occupation, cand.experience, cand.skills.join(" ")].join(" "));
  const si = SENIORITY.indexOf(cand.seniority), vi = SENIORITY.indexOf(vac.seniority);
  const sen = si < 0 || vi < 0 ? { value: 0.5, known: false }
    : { value: Math.max(0, 1 - Math.abs(si - vi) / 3), known: true };
  const loc = !vac.region || !cand.region ? { value: 0.6, known: false }
    : { value: vac.region === cand.region ? 1 : (vac.format === "remote" || cand.relocate ? 0.8 : 0.25), known: true };
  const pay = H.rangeFit(cand.expectedMin, cand.expectedMax, vac.salaryMin, vac.salaryMax);
  const avail = { value: cand.availability === "active" ? 1 : cand.availability === "open" ? 0.8
    : cand.availability === "passive" ? 0.4 : 0.1, known: true };
  const lang = H.listFit(vac.languages, cand.languages);
  const cert = H.listFit(vac.certificates, cand.certificates);
  const evidence = { value: cand.verified ? 1 : (cand.portfolio ? 0.6 : 0.3), known: true };
  const prefFit = (vac.format && (cand.formats || []).length
    ? ((cand.formats || []).includes(vac.format) ? 1 : 0.4)
    : 0.6);

  const factors = [
    { weight: 30, value: core.value, known: core.known,
      why: "Majburiy skilllar mos: " + (core.matched || []).join(", "),
      gap: (core.missing || []).length ? "Yetishmayotgan majburiy skill: " + core.missing.join(", ") : "Skill maʼlumoti yoʻq" },
    { weight: 18, value: exp, why: "Tajriba lavozimga mos", gap: "Lavozimga tegishli tajriba koʻrinmadi" },
    { weight: 10, value: sen.value, known: sen.known, why: "Seniority darajasi mos", gap: "Seniority darajasi farq qiladi" },
    { weight: 8,  value: loc.value, known: loc.known, why: "Hudud/format mos", gap: "Hudud mos emas va relokatsiya belgilanmagan" },
    { weight: 10, value: pay.value, known: pay.known, why: "Maosh kutilmasi byudjetga mos", gap: "Maosh kutilmasi byudjetdan tashqarida" },
    { weight: 7,  value: avail.value, known: avail.known, why: "Nomzod hozir ish qidirmoqda", gap: "Nomzod passiv holatda" },
    { weight: 7,  value: (lang.value + cert.value) / 2, known: lang.known || cert.known,
      why: "Til va sertifikat talablari bajarilgan",
      gap: [].concat(lang.missing || [], cert.missing || []).length
        ? "Til/sertifikat yetishmaydi: " + [].concat(lang.missing || [], cert.missing || []).join(", ") : "" },
    { weight: 5,  value: evidence.value, known: true, why: "Profil tasdiqlangan yoki portfolio bor", gap: "Skill isboti yoʻq — portfolio yoki test qoʻshing" },
    { weight: 5,  value: (pref.value + prefFit) / 2, why: "Afzal skilllar va ish formati mos", gap: "Ish formati yoki afzal skilllar mos emas" },
  ];
  const s = H.score(factors);

  /* §8.2 — the employer and the candidate do not weigh the same things.
     For the candidate, pay and format dominate; for the employer, skills do. */
  const candidateSide = H.score([
    { weight: 35, value: pay.value, known: pay.known },
    { weight: 20, value: prefFit },
    { weight: 20, value: loc.value, known: loc.known },
    { weight: 15, value: sen.value, known: sen.known },
    { weight: 10, value: core.value, known: core.known },
  ]);
  return Object.assign({}, s, { employerScore: s.score, candidateScore: candidateSide.score });
}

function matchesForVacancy(vacancyId, limit){
  const st = load();
  const v  = st.vacancies.find(x => x.id === vacancyId);
  if(!v) return { error: "not_found" };
  const rows = st.candidates
    .filter(c => c.visibility === "public" || c.visibility === "anonymous")
    .map(c => Object.assign({ candidate: candidateView(c) }, matchPair(c, v)))
    .filter(m => m.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(100, H.N(limit, 25)));
  return { ok: true, vacancy: v, matches: rows };
}

function matchesForCandidate(ownerId, limit){
  const st = load();
  const c  = st.candidates.find(x => x.ownerId === ownerId);
  /* Not an error: a visitor who has not built a passport yet simply has no
     matches. Returning 400 here made every first visit look like a failure. */
  if(!c) return { ok: true, needsProfile: true, candidate: null, matches: [] };
  const applied = new Set(st.applications.filter(a => a.candidateId === c.id).map(a => a.vacancyId));
  const rows = st.vacancies.filter(v => v.status === "open")
    .map(v => Object.assign({ vacancy: v, applied: applied.has(v.id) }, matchPair(c, v)))
    .filter(m => m.score > 0)
    .sort((a, b) => b.candidateScore - a.candidateScore)
    .slice(0, Math.min(100, H.N(limit, 25)));
  return { ok: true, candidate: candidateView(c, { full: true }), matches: rows };
}

/* ---------- ATS (§7.1) ---------- */
function apply(actor, body){
  const st = load();
  const c  = st.candidates.find(x => x.ownerId === actor.id);
  if(!c) return { error: "profile_required" };
  const v = st.vacancies.find(x => x.id === H.S(body.vacancyId, 40));
  if(!v) return { error: "vacancy_not_found" };
  if(v.status !== "open") return { error: "vacancy_closed" };
  if(st.applications.some(a => a.vacancyId === v.id && a.candidateId === c.id)) return { error: "already_applied" };

  const m = matchPair(c, v);
  const row = {
    id: H.uid("ap"), vacancyId: v.id, candidateId: c.id,
    candidateName: c.name, companyId: v.companyId, vacancyTitle: v.title,
    source: H.ONE(body.source, ["search", "match", "invite", "direct"], "search"),
    note: H.S(body.note, 1500),
    stage: "applied", reason: "", score: m.score,
    history: [{ stage: "applied", t: Date.now(), by: c.name }],
    created: Date.now(), updated: Date.now(),
  };
  st.applications = st.applications.concat([row]);
  H.logEvent(st, "application_submitted", { vacancyId: v.id, candidateId: c.id,
    occupation: v.occupation, region: v.region, score: m.score, source: row.source });
  save(st);
  return { ok: true, application: row, match: m };
}

/** Employer moves an application along; every hop is timestamped and attributed. */
function stageSet(company, body){
  const st = load();
  const a  = st.applications.find(x => x.id === H.S(body.id, 40));
  if(!a) return { error: "not_found" };
  if(a.companyId !== company.id) return { error: "forbidden" };
  const stage = STAGES.includes(H.S(body.stage, 20)) ? H.S(body.stage, 20) : a.stage;
  const reason = REASONS.includes(H.S(body.reason, 20)) ? H.S(body.reason, 20) : "";
  /* §7.2 — a rejection without a reason code is refused, not silently stored. */
  if(stage === "rejected" && !reason) return { error: "reason_required", reasons: REASONS };

  const v = st.vacancies.find(x => x.id === a.vacancyId);
  const next = Object.assign({}, a, {
    stage, reason,
    salary: H.N(body.salary) || a.salary || 0,
    currency: H.ONE(body.currency, CURRENCIES, (v && v.currency) || "UZS"),
    note: body.note != null ? H.S(body.note, 1500) : a.note,
    history: (a.history || []).concat([{ stage, reason, t: Date.now(), by: H.S(company.name, 160) }]).slice(-40),
    updated: Date.now(),
  });
  st.applications = st.applications.map(x => (x.id === a.id ? next : x));

  const base = { vacancyId: a.vacancyId, candidateId: a.candidateId,
    occupation: v ? v.occupation : "", region: v ? v.region : "", sector: v ? v.sector : "" };
  if(stage === "screening") H.logEvent(st, "screen_passed", base);
  if(stage === "interview") H.logEvent(st, "interview_completed", base);
  if(stage === "offer")     H.logEvent(st, "offer_sent", Object.assign({ salary: next.salary, currency: next.currency }, base));
  if(stage === "hired")     H.logEvent(st, "hire_completed", Object.assign({
    salary: next.salary, currency: next.currency, source: a.source,
    timeToFill: Math.round((Date.now() - (v ? v.created : a.created)) / 864e5) }, base));
  if(stage === "rejected")  H.logEvent(st, "offer_rejected", Object.assign({ reason }, base));
  save(st);
  return { ok: true, application: next };
}

/** Candidate-side accept/decline of an offer — the clearing-price signal (§4.2). */
function offerRespond(actor, body){
  const st = load();
  const c  = st.candidates.find(x => x.ownerId === actor.id);
  if(!c) return { error: "profile_required" };
  const a = st.applications.find(x => x.id === H.S(body.id, 40) && x.candidateId === c.id);
  if(!a) return { error: "not_found" };
  if(a.stage !== "offer") return { error: "no_offer" };

  const accept = H.BOOL(body.accept);
  const reason = REASONS.includes(H.S(body.reason, 20)) ? H.S(body.reason, 20) : "";
  if(!accept && !reason) return { error: "reason_required", reasons: REASONS };

  const next = Object.assign({}, a, {
    stage: accept ? "hired" : "withdrawn", reason: accept ? "" : reason,
    history: (a.history || []).concat([{ stage: accept ? "hired" : "withdrawn", reason, t: Date.now(), by: c.name }]).slice(-40),
    updated: Date.now(),
  });
  st.applications = st.applications.map(x => (x.id === a.id ? next : x));
  const v = st.vacancies.find(x => x.id === a.vacancyId);
  const base = { vacancyId: a.vacancyId, candidateId: c.id, occupation: v ? v.occupation : "",
    region: v ? v.region : "", sector: v ? v.sector : "", salary: a.salary, currency: a.currency };
  H.logEvent(st, accept ? "offer_accepted" : "offer_rejected", Object.assign({ reason }, base));
  if(accept) H.logEvent(st, "hire_completed", Object.assign({ source: a.source,
    timeToFill: Math.round((Date.now() - (v ? v.created : a.created)) / 864e5) }, base));
  save(st);
  return { ok: true, application: next };
}

/** Recruiter workspace: the kanban the employer actually works in (§7.2). */
function pipeline(companyId, vacancyId){
  const st = load();
  let rows = st.applications.filter(a => a.companyId === companyId);
  if(vacancyId) rows = rows.filter(a => a.vacancyId === vacancyId);
  const byStage = {};
  for(const s of STAGES) byStage[s] = [];
  for(const a of rows.sort((x, y) => y.updated - x.updated)){
    const c = st.candidates.find(x => x.id === a.candidateId);
    (byStage[a.stage] || byStage.applied).push(Object.assign({}, a, {
      candidate: c ? candidateView(c, { full: a.stage !== "applied" }) : null }));
  }
  /* §7.2 funnel: source → applicant → screen → interview → offer → hire */
  const at = s => rows.filter(a => a.stage === s).length;
  const reached = s => rows.filter(a => (a.history || []).some(h => h.stage === s)).length;
  return {
    ok: true, stages: STAGES, byStage,
    funnel: {
      applied: rows.length,
      screened: reached("screening"), interviewed: reached("interview"),
      offered: reached("offer"), hired: at("hired"), rejected: at("rejected"),
    },
    reasons: H.countBy(rows.filter(a => a.reason), a => a.reason),
  };
}

const applicationsOf = candidateId => {
  const st = load();
  return st.applications.filter(a => a.candidateId === candidateId)
    .sort((a, b) => b.updated - a.updated)
    .map(a => Object.assign({}, a, { vacancy: st.vacancies.find(v => v.id === a.vacancyId) || null }));
};

module.exports = {
  SENIORITY, FORMATS, EMPLOYMENT, AVAILABILITY, STAGES, REASONS, VISIBILITY, CURRENCIES,
  load, save, candidateView,
  candidateSave, candidateOf, vacancySave, vacancyClose, vacanciesOf, vacancyWarnings,
  searchJobs, searchTalent,
  matchPair, matchesForVacancy, matchesForCandidate,
  apply, stageSet, offerRespond, pipeline, applicationsOf,
};
