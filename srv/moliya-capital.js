/* ============================================================
   MOLIYA BOZORI — capital side
   Investor Marketplace (§7) · Capital Stack Builder (§9) ·
   Project Generation Office G0–G8 (§11) · Idea Exchange (§12) ·
   Startup Market (§13)

   Shares one store with moliya.js — the TZ is explicit (§31.2)
   that these must not become separate mini-sites on separate
   data. Same document, same identities, same deal objects.
   ============================================================ */
const H = require("./store");
const M = require("./moliya");

const load = M.load, save = M.save;

const INVESTOR_TYPES = ["angel", "vc", "pe", "strategic", "family", "institutional", "dfi"];
const STAGES  = ["pre-seed", "seed", "growth", "mature", "project"];
const INSTRUMENTS = ["equity", "convertible", "mezzanine", "debt", "jv", "project-equity"];
/* §11.1 Project Factory pipeline */
const GATES = ["G0", "G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8"];
const GATE_LABEL = {
  G0: "Opportunity Capture", G1: "Opportunity Scan", G2: "Pre-feasibility",
  G3: "Business Case", G4: "Structuring", G5: "Investor Ready",
  G6: "Market Sounding", G7: "Transaction", G8: "Post-deal Monitoring",
};
/* §12.1 idea monetisation models */
const IDEA_MODELS = ["sale", "license", "royalty", "equity", "codev", "bounty"];

/* ---------- Investor Passport (§7.1) ---------- */
function investorSave(actor, body){
  const st   = load();
  const prev = st.investors.find(i => i.ownerId === actor.id);
  const row  = {
    id:        prev ? prev.id : H.uid("iv"),
    ownerId:   H.S(actor.id, 40),
    name:      H.S(body.name || actor.name, 160),
    type:      H.ONE(body.type, INVESTOR_TYPES, "angel"),
    ticketMin: H.N(body.ticketMin),
    ticketMax: H.N(body.ticketMax),
    currency:  H.ONE(body.currency, M.CURRENCIES, "USD"),
    stages:    H.SUBSET(body.stages, STAGES, 5),
    sectors:   H.LIST(body.sectors, 15),
    geos:      H.LIST(body.geos, 10),
    instruments: H.SUBSET(body.instruments, INSTRUMENTS, 6),
    control:   H.ONE(body.control, ["minority", "significant", "control", "jv"], "minority"),
    horizon:   H.N(body.horizon),                 // years
    thesis:    H.S(body.thesis, 2000),
    verified:  prev ? prev.verified : false,
    visible:   body.visible == null ? true : H.BOOL(body.visible),
    created:   prev ? prev.created : Date.now(),
    updated:   Date.now(),
  };
  st.investors = prev ? st.investors.map(i => (i.id === prev.id ? row : i)) : st.investors.concat([row]);
  H.logEvent(st, "investor_saved", { investorId: row.id, type: row.type, sectors: row.sectors, stages: row.stages });
  save(st);
  return { ok: true, investor: row };
}

const investorList = () => load().investors.filter(i => i.visible).sort((a, b) => b.updated - a.updated);
const investorOf = ownerId => load().investors.find(i => i.ownerId === ownerId) || null;

/* ---------- Project Generation Office (§11) ---------- */
function projectSave(actor, body){
  const st   = load();
  const id   = H.S(body.id, 40);
  const prev = id ? st.projects.find(p => p.id === id && p.ownerId === actor.id) : null;
  if(id && !prev) return { error: "not_found" };

  const row = {
    id:        prev ? prev.id : H.uid("pj"),
    ownerId:   H.S(actor.id, 40),
    sponsor:   H.S(body.sponsor || actor.name, 160),
    name:      H.S(body.name, 200),
    sector:    H.S(body.sector, 120),
    region:    H.S(body.region, 120),
    summary:   H.S(body.summary, 3000),
    gate:      H.ONE(body.gate, GATES, "G0"),
    capex:     H.N(body.capex),
    opex:      H.N(body.opex),
    revenue:   H.N(body.revenue),
    currency:  H.ONE(body.currency, M.CURRENCIES, "USD"),
    irr:       H.N(body.irr),
    npv:       H.N(body.npv),
    dscr:      H.N(body.dscr),
    payback:   H.N(body.payback),
    ask:       H.N(body.ask),
    instruments: H.SUBSET(body.instruments, INSTRUMENTS, 6),
    jobs:      H.N(body.jobs),                    // feeds Human Capital demand signals
    exportShare: H.N(body.exportShare),
    risks:     H.S(body.risks, 2000),
    /* §11.1 every gate keeps its own owner/task/status trail */
    tasks:     Array.isArray(prev && prev.tasks) ? prev.tasks : [],
    created:   prev ? prev.created : Date.now(),
    updated:   Date.now(),
  };
  if(!row.name) return { error: "name_required" };
  st.projects = prev ? st.projects.map(p => (p.id === prev.id ? row : p)) : st.projects.concat([row]);
  H.logEvent(st, prev ? "project_updated" : "project_created",
    { projectId: row.id, gate: row.gate, sector: row.sector, capex: row.capex, currency: row.currency });
  save(st);
  return { ok: true, project: row, readiness: projectReadiness(row) };
}

/** §11.1 — a gate only advances with an owner and a dated note; that is the audit trail. */
function projectGate(actor, body){
  const st = load();
  const p  = st.projects.find(x => x.id === H.S(body.id, 40));
  if(!p) return { error: "not_found" };
  if(!p.ownerId || p.ownerId !== actor.id) return { error: "forbidden" };
  const gate = GATES.includes(H.S(body.gate, 4)) ? H.S(body.gate, 4) : p.gate;
  const task = {
    gate, from: p.gate,
    owner: H.S(body.owner || actor.name, 160),
    note: H.S(body.note, 1000),
    t: Date.now(),
  };
  const next = Object.assign({}, p, { gate, tasks: (p.tasks || []).concat([task]).slice(-60), updated: Date.now() });
  st.projects = st.projects.map(x => (x.id === p.id ? next : x));
  H.logEvent(st, "project_gate", { projectId: p.id, from: p.gate, to: gate, sector: p.sector });
  save(st);
  return { ok: true, project: next, readiness: projectReadiness(next) };
}

/** §8.1 investment-readiness — completeness of the pack, with the gaps named. */
function projectReadiness(p){
  const blocks = [
    { key: "Konsepsiya",  ok: !!(p.name && p.summary && p.sector), hint: "Loyiha nomi, sektori va qisqacha mazmunini yozing" },
    { key: "Bozor",       ok: !!(p.region && p.revenue), hint: "Hudud va kutilayotgan yillik tushumni koʻrsating" },
    { key: "CAPEX/OPEX",  ok: !!(p.capex && p.opex), hint: "CAPEX va OPEX baholarini kiriting" },
    { key: "Moliyaviy model", ok: !!(p.irr || p.npv || p.dscr), hint: "IRR / NPV / DSCR dan kamida bittasini hisoblang" },
    { key: "Capital ask", ok: !!(p.ask && p.instruments.length), hint: "Soʻralayotgan summa va instrumentni belgilang" },
    { key: "Risk register", ok: !!p.risks, hint: "Asosiy risklar va mitigatsiyani yozing" },
    { key: "Gate trail",  ok: (p.tasks || []).length > 0, hint: "Gate oʻtishini mas'ul va izoh bilan qayd eting" },
  ];
  const done = blocks.filter(b => b.ok).length;
  return {
    score: Math.round(100 * done / blocks.length),
    gate: p.gate, gateLabel: GATE_LABEL[p.gate] || p.gate,
    blocks: blocks.map(b => ({ key: b.key, ok: b.ok, hint: b.ok ? "" : b.hint })),
  };
}

const projectList = filter => {
  const f = filter || {};
  let rows = load().projects.slice().sort((a, b) => b.updated - a.updated);
  if(f.gate && GATES.includes(H.S(f.gate, 4))) rows = rows.filter(p => p.gate === f.gate);
  if(f.sector) rows = rows.filter(p => p.sector === H.S(f.sector, 120));
  return rows.slice(0, 200).map(p => Object.assign({}, p, { readiness: projectReadiness(p).score }));
};

/* ---------- Startup Market (§13) ---------- */
function startupSave(actor, body){
  const st   = load();
  const prev = st.startups.find(s => s.ownerId === actor.id);
  const row  = {
    id:       prev ? prev.id : H.uid("su"),
    ownerId:  H.S(actor.id, 40),
    name:     H.S(body.name || actor.name, 160),
    stage:    H.ONE(body.stage, STAGES, "seed"),
    sector:   H.S(body.sector, 120),
    region:   H.S(body.region, 120),
    pitch:    H.S(body.pitch, 2000),
    founders: H.LIST(body.founders, 8, 120),
    mrr:      H.N(body.mrr),
    users:    H.N(body.users),
    growth:   H.N(body.growth),                  // % month over month
    burn:     H.N(body.burn),
    runway:   H.N(body.runway),                  // months
    ask:      H.N(body.ask),
    currency: H.ONE(body.currency, M.CURRENCIES, "USD"),
    valuation:H.N(body.valuation),
    instrument: H.ONE(body.instrument, INSTRUMENTS, "equity"),
    deck:     /^https?:\/\//i.test(H.S(body.deck, 400)) ? H.S(body.deck, 400) : "",
    verified: prev ? prev.verified : false,
    created:  prev ? prev.created : Date.now(),
    updated:  Date.now(),
  };
  st.startups = prev ? st.startups.map(s => (s.id === prev.id ? row : s)) : st.startups.concat([row]);
  H.logEvent(st, "startup_saved", { startupId: row.id, stage: row.stage, sector: row.sector,
    ask: row.ask, currency: row.currency, mrr: row.mrr });
  save(st);
  return { ok: true, startup: row };
}

const startupList = () => load().startups.slice().sort((a, b) => b.updated - a.updated);

/* ---------- Idea Exchange (§12) ----------
   Two layers by construction: the teaser is public, the confidential payload
   is only ever returned after an NDA acceptance is recorded against the
   requester. §12.2 also wants a timestamp trail — every NDA is logged. */
function ideaSave(actor, body){
  const st   = load();
  const id   = H.S(body.id, 40);
  const prev = id ? st.ideas.find(i => i.id === id && i.ownerId === actor.id) : null;
  if(id && !prev) return { error: "not_found" };

  const row = {
    id:       prev ? prev.id : H.uid("id"),
    ownerId:  H.S(actor.id, 40),
    author:   H.S(body.author || actor.name, 160),
    title:    H.S(body.title, 200),
    teaser:   H.S(body.teaser, 1200),            // public
    confidential: H.S(body.confidential, 6000),  // NDA-gated
    sector:   H.S(body.sector, 120),
    model:    H.ONE(body.model, IDEA_MODELS, "license"),
    price:    H.N(body.price),
    currency: H.ONE(body.currency, M.CURRENCIES, "USD"),
    terms:    H.S(body.terms, 1500),
    ipStatus: H.S(body.ipStatus, 200),
    ndas:     Array.isArray(prev && prev.ndas) ? prev.ndas : [],
    views:    prev ? H.N(prev.views) : 0,
    status:   H.ONE(body.status, ["open", "reserved", "closed"], "open"),
    created:  prev ? prev.created : Date.now(),
    updated:  Date.now(),
  };
  if(!row.title || !row.teaser) return { error: "teaser_required" };
  st.ideas = prev ? st.ideas.map(i => (i.id === prev.id ? row : i)) : st.ideas.concat([row]);
  H.logEvent(st, prev ? "idea_updated" : "idea_published",
    { ideaId: row.id, sector: row.sector, model: row.model });
  save(st);
  return { ok: true, idea: teaserView(row) };
}

const teaserView = i => ({
  id: i.id, author: i.author, title: i.title, teaser: i.teaser, sector: i.sector,
  model: i.model, price: i.price, currency: i.currency, ipStatus: i.ipStatus,
  status: i.status, ndaCount: (i.ndas || []).length, views: i.views,
  created: i.created, updated: i.updated,
});

function ideaList(){
  const st = load();
  return st.ideas.filter(i => i.status !== "closed").sort((a, b) => b.updated - a.updated).map(teaserView);
}

/** §12.2 — the gate. Confidential content is returned only with a recorded NDA. */
function ideaOpen(id, actor){
  const st   = load();
  const idea = st.ideas.find(i => i.id === H.S(id, 40));
  if(!idea) return { error: "not_found" };
  const who = H.S(actor && actor.id, 40);
  const signed = (idea.ndas || []).some(n => n.by === who && !n.revoked);
  const next = Object.assign({}, idea, { views: H.N(idea.views) + 1 });
  st.ideas = st.ideas.map(i => (i.id === idea.id ? next : i));
  H.logEvent(st, "idea_viewed", { ideaId: idea.id, by: who, confidential: signed });
  save(st);
  return signed
    ? { ok: true, idea: teaserView(next), confidential: idea.confidential, terms: idea.terms, ndaSigned: true }
    : { ok: true, idea: teaserView(next), confidential: null, ndaSigned: false,
        notice: "Maxfiy qism NDA qabul qilingandan keyin ochiladi." };
}

function ideaNda(id, actor){
  const st   = load();
  const idea = st.ideas.find(i => i.id === H.S(id, 40));
  if(!idea) return { error: "not_found" };
  const who = H.S(actor && actor.id, 40);
  if(!who) return { error: "identify_first" };
  if((idea.ndas || []).some(n => n.by === who && !n.revoked)) return ideaOpen(id, actor);

  const nda = { id: H.uid("nd"), by: who, name: H.S(actor.name, 160), t: Date.now() };
  const next = Object.assign({}, idea, { ndas: (idea.ndas || []).concat([nda]).slice(-200) });
  st.ideas = st.ideas.map(i => (i.id === idea.id ? next : i));
  H.logEvent(st, "idea_nda", { ideaId: idea.id, by: who });
  save(st);
  return { ok: true, idea: teaserView(next), confidential: idea.confidential, terms: idea.terms, ndaSigned: true };
}

/* ---------- AI Investor Matching Engine (§7.2) ----------
   Weights are the ones the TZ specifies: thesis 25, ticket 15,
   traction 20, risk 15, synergy 15, engagement 10. */
function matchInvestors(subject){
  const st = load();
  return st.investors.filter(i => i.visible).map(inv => {
    const sectorFit = (inv.sectors || []).length && subject.sector
      ? (inv.sectors.some(s => s.toLowerCase() === String(subject.sector).toLowerCase()) ? 1 : 0.25)
      : 0.5;
    const stageFit = (inv.stages || []).length && subject.stage
      ? (inv.stages.includes(subject.stage) ? 1 : 0.3) : 0.5;
    const geoFit = (inv.geos || []).length && subject.region
      ? (inv.geos.some(g => String(subject.region).toLowerCase().includes(g.toLowerCase())
          || g.toLowerCase().includes("uzbek") || g.toLowerCase().includes("global")) ? 1 : 0.4)
      : 0.5;
    const instrFit = (inv.instruments || []).length && (subject.instruments || []).length
      ? ((subject.instruments || []).some(x => inv.instruments.includes(x)) ? 1 : 0.3) : 0.5;
    const thesis = (sectorFit + stageFit + geoFit + instrFit) / 4;

    const ticket = H.rangeFit(subject.ask, subject.ask, inv.ticketMin, inv.ticketMax);
    /* traction: whatever evidence the subject actually carries */
    const evidence = [subject.revenue, subject.mrr, subject.users, subject.irr, subject.npv]
      .filter(x => H.N(x) > 0).length;
    const traction = { value: Math.min(1, evidence / 2), known: evidence > 0 };
    /* risk fit: a later stage with numbers behind it is a calmer risk class */
    const risk = { value: subject.stage === "pre-seed" ? 0.5 : evidence >= 2 ? 1 : 0.6, known: evidence > 0 };
    const synergy = H.coverage(H.tokens(inv.thesis), [subject.name, subject.summary || subject.pitch, subject.sector].join(" "));
    const engagement = { value: 0.5, known: false };  // no behavioural history yet — declared, not faked

    const s = H.score([
      { weight: 25, value: thesis, why: "Sektor, bosqich, hudud va instrument tezisga mos", gap: "Investor tezisi bilan mos kelmadi" },
      { weight: 15, value: ticket.value, known: ticket.known, why: "Soʻralayotgan summa ticket diapazonida", gap: "Summa investor ticket diapazonidan tashqarida" },
      { weight: 20, value: traction.value, known: traction.known, why: "Traction/moliyaviy dalillar mavjud", gap: "Traction raqamlari yetishmaydi (revenue, MRR, IRR)" },
      { weight: 15, value: risk.value, known: risk.known, why: "Risk klassi investor toleransiga yaqin", gap: "Risk profili yuqori — dalillar bilan mustahkamlang" },
      { weight: 15, value: synergy, why: "Investor tezisi bilan strategik sinergiya bor", gap: "Strategik sinergiya matni topilmadi" },
      { weight: 10, value: engagement.value, known: false },
    ]);
    return Object.assign({
      investor: { id: inv.id, name: inv.name, type: inv.type, ticketMin: inv.ticketMin,
        ticketMax: inv.ticketMax, currency: inv.currency, stages: inv.stages,
        sectors: inv.sectors, instruments: inv.instruments, thesis: inv.thesis, verified: inv.verified },
    }, s);
  }).filter(m => m.score > 0).sort((a, b) => b.score - a.score);
}

function matchFor(kind, id){
  const st = load();
  if(kind === "project"){
    const p = st.projects.find(x => x.id === id);
    if(!p) return { error: "not_found" };
    return { ok: true, subject: { kind, name: p.name }, matches: matchInvestors({
      sector: p.sector, region: p.region, stage: "project", ask: p.ask,
      instruments: p.instruments, revenue: p.revenue, irr: p.irr, npv: p.npv,
      name: p.name, summary: p.summary }).slice(0, 20) };
  }
  const s = st.startups.find(x => x.id === id);
  if(!s) return { error: "not_found" };
  return { ok: true, subject: { kind: "startup", name: s.name }, matches: matchInvestors({
    sector: s.sector, region: s.region, stage: s.stage, ask: s.ask,
    instruments: [s.instrument], mrr: s.mrr, users: s.users,
    name: s.name, summary: s.pitch }).slice(0, 20) };
}

/* ---------- Capital Stack Builder (§9) ----------
   Three scenarios — Conservative / Balanced / Growth — built from the
   project's own cash-flow, collateral and asset profile. Percentages are a
   starting structure for discussion, never a recommendation to transact. */
function capitalStack(input){
  const need = H.N(input.amount);
  if(!need) return { error: "amount_required" };
  const hasCollateral = H.N(input.collateral) > 0 || H.BOOL(input.collateral);
  const hasReceivables = H.N(input.receivables) > 0;
  const isExporter = H.BOOL(input.exporter);
  const isAsset   = H.BOOL(input.equipment);
  const cashflow  = H.N(input.ebitda);
  const sharia    = H.BOOL(input.sharia);

  const source = (key, label, pct, when) => ({ key, label, pct, amount: Math.round(need * pct / 100), why: when });

  const build = (name, mix, cost, note) => ({
    name,
    sources: mix.filter(s => s.pct > 0),
    costOfCapital: cost,
    dilution: mix.filter(s => s.key === "equity" || s.key === "mezzanine").reduce((a, s) => a + s.pct, 0),
    note,
  });

  /* Debt capacity is the honest constraint: without cash-flow or collateral,
     leverage is not available at any label. */
  const debtRoom = (hasCollateral ? 45 : 0) + (cashflow > 0 ? 15 : 0);
  const tradeRoom = isExporter ? 20 : 0;
  const factorRoom = hasReceivables ? 20 : 0;
  const leaseRoom = isAsset ? 25 : 0;

  const norm = arr => {
    const total = arr.reduce((a, s) => a + s.pct, 0) || 1;
    return arr.map(s => Object.assign({}, s, { pct: Math.round(s.pct * 100 / total),
      amount: Math.round(need * (s.pct / total)) }));
  };

  const conservative = norm([
    source(sharia ? "islamic" : "debt", sharia ? "Islom moliyasi (Murabaha/Ijara)" : "Bank krediti",
      Math.min(debtRoom, 40), hasCollateral ? "Taʼminot mavjud" : "Taʼminot cheklangan"),
    source("lease", "Lizing", leaseRoom, "Uskuna/transport xaridi"),
    source("trade", "Trade finance", tradeRoom, "Eksport kontrakti asosida"),
    source("equity", "Oʻz mablagʻi / equity", 30, "Qolgan qismi oʻz hissasi"),
  ]);
  const balanced = norm([
    source(sharia ? "islamic" : "debt", sharia ? "Islom moliyasi" : "Bank krediti", Math.min(debtRoom, 30), "Barqaror qism"),
    source("factoring", "Faktoring", factorRoom, "Debitorlik aylanmasi"),
    source("lease", "Lizing", leaseRoom * 0.8, "Asset finance"),
    source("trade", "Trade finance", tradeRoom, "Kontrakt sikli"),
    source("equity", "Equity / investor", 35, "Oʻsish uchun kapital"),
  ]);
  const growth = norm([
    source("equity", "Equity / investor", 50, "Yuqori oʻsish, past repayment bosimi"),
    source("mezzanine", "Mezzanine / convertible", 15, "Debt va equity oraligʻi"),
    source(sharia ? "islamic" : "debt", sharia ? "Islom moliyasi" : "Bank krediti", Math.min(debtRoom, 20), "Cheklangan leverage"),
    source("grant", "Grant / IFI / blended", 15, "Development yoki prioritet loyiha boʻlsa"),
  ]);

  return {
    ok: true, amount: need, currency: H.ONE(input.currency, M.CURRENCIES, "USD"),
    scenarios: [
      build("Conservative", conservative, "Past–oʻrta", "Eng kam dilution, eng yuqori repayment bosimi."),
      build("Balanced", balanced, "Oʻrta", "Qarz va equity muvozanati; aylanma mablagʻ qoplanadi."),
      build("Growth", growth, "Oʻrta–yuqori", "Tez oʻsish uchun; ulush berish evaziga repayment bosimi past."),
    ],
    inputs: { hasCollateral, hasReceivables, isExporter, isAsset, cashflow, sharia },
    disclaimer: "Bu muhokama uchun boshlangʻich struktura. Yakuniy capital stack moliya va yuridik ekspert bilan tasdiqlanadi.",
  };
}

module.exports = {
  INVESTOR_TYPES, STAGES, INSTRUMENTS, GATES, GATE_LABEL, IDEA_MODELS,
  investorSave, investorList, investorOf,
  projectSave, projectGate, projectList, projectReadiness,
  startupSave, startupList,
  ideaSave, ideaList, ideaOpen, ideaNda,
  matchInvestors, matchFor, capitalStack,
};
