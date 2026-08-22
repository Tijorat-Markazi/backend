/* ============================================================
   INTELLIGENCE LAYER — the three analytics products

   Bozor  §13  Uzbekistan Market Intelligence
   Moliya §15  Capital Intelligence
   Mehnat §9   Labor Market Intelligence

   All three are computed from the event stream the domain
   modules write, not from record counts — that distinction is
   the point of all three TZs.

   Privacy: Human Capital §19 requires a minimum cohort size so
   small segments cannot re-identify a person. COHORT_MIN is
   applied to every candidate/salary cut here, and suppressed
   rows are reported as suppressed rather than silently dropped.
   ============================================================ */
const H = require("./store");
const B = require("./bozor");
const M = require("./moliya");
const K = require("./moliya-capital");
const W = require("./mehnat");

const COHORT_MIN = 5;

const pct = (a, b) => (b ? Math.round(100 * a / b) : 0);
const ev  = (rows, type) => rows.filter(e => e.type === type);
/** Median of the deltas a set of events carries — used for the speed indices. */
const medianOf = (rows, key) => H.stats(rows.map(r => H.N(r[key])).filter(x => x > 0));

/* ============================================================
   BOZOR — Market Intelligence (§13.1)
   ============================================================ */
function marketIntel(days){
  const st   = B.load();
  const win  = Math.max(7, H.N(days, 90));
  const recent = st.events.filter(e => e.t >= Date.now() - win * 864e5);
  const live = st.products.filter(p => p.status === "live");

  const searches = ev(recent, "search");
  const rfqs     = ev(recent, "rfq_created");
  const quotes   = ev(recent, "quote_sent");
  const deals    = ev(recent, "deal_opened");
  const stages   = ev(recent, "deal_stage");

  /* Demand vs supply per category: what buyers ask for against what is listed.
     A high ratio is exactly the "supply gap" the TZ wants surfaced (§13.1). */
  const demand = new Map();
  for(const r of rfqs) if(r.category) demand.set(r.category, (demand.get(r.category) || 0) + 1);
  for(const s of searches) if(s.q) for(const w of H.tokens(s.q)) demand.set(w, (demand.get(w) || 0) + 0.25);
  const supply = new Map();
  for(const p of live) if(p.category) supply.set(p.category, (supply.get(p.category) || 0) + 1);

  const gaps = [...demand.entries()]
    .map(([label, d]) => ({ label, demand: Math.round(d * 10) / 10, supply: supply.get(label) || 0,
      ratio: Math.round(10 * d / ((supply.get(label) || 0) + 1)) / 10 }))
    .filter(g => g.demand >= 1)
    .sort((a, b) => b.ratio - a.ratio).slice(0, 15);

  const won = stages.filter(s => s.to === "order" || s.to === "fulfilment" || s.to === "closed");
  const tradeValue = won.reduce((a, s) => a + H.N(s.value), 0);

  return {
    windowDays: win,
    headline: {
      liveProducts: live.length,
      verifiedSellers: new Set(live.filter(p => p.verified).map(p => p.companyId)).size,
      sellers: new Set(live.map(p => p.companyId)).size,
      rfqs: rfqs.length,
      quotes: quotes.length,
      deals: deals.length,
      tradeValue,
      matchRate: pct(new Set(quotes.map(q => q.rfqId)).size, rfqs.length),
      timeToFirstQuoteHours: medianOf(quotes, "hours"),
    },
    channels: B.CHANNELS.map(c => ({
      id: c,
      products: live.filter(p => (p.channels || []).includes(c)).length,
      rfqs: rfqs.filter(r => r.channel === c).length,
      deals: deals.filter(d => d.channel === c).length,
    })),
    topSearches:  H.countBy(searches.filter(s => s.q), s => s.q).slice(0, 12),
    topCategories: H.countBy(live, p => p.category).slice(0, 12),
    regions:      H.countBy(live, p => p.region).slice(0, 12),
    exportMarkets: H.countBy(live, p => p.markets).slice(0, 15),
    supplyGaps:   gaps,
    priceBands:   H.countBy(live, p => p.currency).map(c => ({
      currency: c.label, stats: H.stats(live.filter(p => p.currency === c.label).map(p => p.price)) })),
    funnel: {
      search: searches.length, rfq: rfqs.length, quote: quotes.length,
      deal: deals.length, won: won.length,
    },
    growth: {
      products: H.since(live, 30).length,
      rfqs: rfqs.filter(r => r.t >= Date.now() - 30 * 864e5).length,
    },
  };
}

/* ============================================================
   MOLIYA — Capital Intelligence (§15.1)
   ============================================================ */
function capitalIntel(days){
  const st  = M.load();
  const win = Math.max(7, H.N(days, 90));
  const recent = st.events.filter(e => e.t >= Date.now() - win * 864e5);

  const requests = st.requests.filter(r => r.created >= Date.now() - win * 864e5);
  const offers   = st.offers.filter(o => o.created >= Date.now() - win * 864e5);
  const live     = st.products.filter(p => p.status === "live");

  /* Funding Gap Index: demand raised against demand that drew at least one
     indicative offer. The gap is what the market did not answer. */
  const answered = new Set(offers.map(o => o.requestId));
  const askedValue    = requests.reduce((a, r) => a + H.N(r.amount), 0);
  const answeredValue = requests.filter(r => answered.has(r.id)).reduce((a, r) => a + H.N(r.amount), 0);

  const bySector = H.countBy(requests, r => r.sector || "—").map(s => {
    const rows = requests.filter(r => (r.sector || "—") === s.label);
    const hit  = rows.filter(r => answered.has(r.id)).length;
    return { label: s.label, requests: s.n, answered: hit, gap: pct(s.n - hit, s.n),
      amount: rows.reduce((a, r) => a + H.N(r.amount), 0) };
  });

  const progressed = st.requests.filter(r => ["shortlisted", "underwriting", "closed"].includes(r.status));

  return {
    windowDays: win,
    headline: {
      providers: new Set(live.map(p => p.providerId)).size,
      products: live.length,
      staleProducts: live.filter(p => M.pview(p).stale).length,
      investors: st.investors.filter(i => i.visible).length,
      requests: requests.length,
      offers: offers.length,
      askedValue, answeredValue,
      fundingGapPct: pct(askedValue - answeredValue, askedValue),
      timeToFirstOfferHours: medianOf(ev(recent, "offer_made"), "hours"),
      /* North Star (§26): capital that actually moved past matching. */
      capitalProgressed: progressed.reduce((a, r) => a + H.N(r.amount), 0),
    },
    demandMap: {
      bySector,
      byRegion: H.countBy(requests, r => r.region || "—").slice(0, 12),
      byCategory: M.CATEGORIES.map(c => ({ label: c, n: requests.filter(r => r.category === c).length })),
      ticket: H.stats(requests.map(r => r.amount)),
      tenor: H.stats(requests.map(r => r.tenor)),
    },
    supply: {
      byCategory: M.CATEGORIES.map(c => ({ label: c, n: live.filter(p => p.category === c).length })),
      shariaProducts: live.filter(p => p.sharia || p.category === "islamic").length,
      amountBands: H.stats(live.map(p => p.maxAmount).filter(Boolean)),
    },
    /* §15.1 Financing Terms Monitor — aggregate only, never per-provider pricing. */
    termsMonitor: {
      ratePct: H.stats(offers.map(o => o.ratePct).filter(x => x > 0)),
      feePct: H.stats(offers.map(o => o.feePct).filter(x => x > 0)),
      tenor: H.stats(offers.map(o => o.tenor).filter(x => x > 0)),
      note: offers.length < COHORT_MIN ? "Namuna kichik — koʻrsatkichlar indikativ." : "",
    },
    investorAppetite: {
      bySector: H.countBy(st.investors.filter(i => i.visible), i => i.sectors).slice(0, 15),
      byStage: K.STAGES.map(s => ({ label: s, n: st.investors.filter(i => (i.stages || []).includes(s)).length })),
      ticket: H.stats(st.investors.map(i => i.ticketMax).filter(Boolean)),
    },
    projectPipeline: K.GATES.map(g => ({ gate: g, label: K.GATE_LABEL[g],
      n: st.projects.filter(p => p.gate === g).length,
      capex: st.projects.filter(p => p.gate === g).reduce((a, p) => a + H.N(p.capex), 0) })),
    startupPulse: {
      total: st.startups.length,
      byStage: K.STAGES.map(s => ({ label: s, n: st.startups.filter(x => x.stage === s).length })),
      ask: H.stats(st.startups.map(s => s.ask).filter(Boolean)),
      bySector: H.countBy(st.startups, s => s.sector).slice(0, 10),
    },
    ideaExchange: {
      total: st.ideas.length,
      byModel: K.IDEA_MODELS.map(m => ({ label: m, n: st.ideas.filter(i => i.model === m).length })),
      ndas: st.ideas.reduce((a, i) => a + (i.ndas || []).length, 0),
      conversion: pct(st.ideas.filter(i => (i.ndas || []).length).length, st.ideas.length),
    },
    privacy: "Koʻrsatkichlar agregat. Alohida kompaniya yoki investorning maxfiy shartlari koʻrsatilmaydi.",
  };
}

/* ============================================================
   MEHNAT — Labor Market Intelligence (§9.1)
   ============================================================ */
function laborIntel(days, filter){
  const st  = W.load();
  const win = Math.max(7, H.N(days, 90));
  const f   = filter || {};
  const region = H.S(f.region, 120);
  const occ    = H.S(f.occupation, 160);

  const keep = v => (!region || v.region === region) && (!occ || v.occupation === occ);
  const open = st.vacancies.filter(v => v.status === "open").filter(keep);
  const all  = st.vacancies.filter(keep);
  const cands = st.candidates.filter(c => !region || c.region === region)
    .filter(c => !occ || c.occupation === occ);
  const activeCands = cands.filter(c => c.availability === "active" || c.availability === "open");

  const recent = st.events.filter(e => e.t >= Date.now() - win * 864e5);
  const apps = ev(recent, "application_submitted");
  const hires = ev(recent, "hire_completed");
  const offersSent = ev(recent, "offer_sent");
  const offersAcc  = ev(recent, "offer_accepted");
  const offersRej  = ev(recent, "offer_rejected");

  /* §9.1 Shortage Index = demand seats ÷ qualified active supply. */
  const seats = open.reduce((a, v) => a + H.N(v.headcount, 1), 0);
  const shortage = activeCands.length ? Math.round(100 * seats / activeCands.length) / 100 : null;

  /* Wage: only reported where the cohort is large enough to stay anonymous. */
  const wage = cohort(open.map(v => v.salaryMax || v.salaryMin).filter(Boolean));
  const expectation = cohort(activeCands.map(c => c.expectedMax || c.expectedMin).filter(Boolean));
  const accepted = cohort(offersAcc.map(o => o.salary).filter(Boolean));

  const skillDemand = H.countBy(open, v => v.skillsRequired).slice(0, 25);
  const skillSupply = H.countBy(activeCands, c => c.skills);
  const supplyMap = new Map(skillSupply.map(s => [s.label.toLowerCase(), s.n]));
  const skillGap = skillDemand.map(s => ({
    skill: s.label, demand: s.n, supply: supplyMap.get(s.label.toLowerCase()) || 0,
    gap: Math.round(10 * s.n / ((supplyMap.get(s.label.toLowerCase()) || 0) + 1)) / 10,
  })).sort((a, b) => b.gap - a.gap).slice(0, 15);

  return {
    windowDays: win,
    filter: { region, occupation: occ },
    headline: {
      openVacancies: open.length, seats,
      activeCandidates: activeCands.length, candidates: cands.length,
      applications: apps.length, hires: hires.length,
      demandIndex: open.length + ev(recent, "talent_search").length,
      supplyIndex: activeCands.length,
      shortageIndex: shortage,
      timeToFillDays: medianOf(hires, "timeToFill"),
      offerAcceptanceRate: pct(offersAcc.length, offersSent.length),
    },
    wages: { offered: wage, expected: expectation, accepted,
      pressurePct: wage.stats && expectation.stats
        ? pct(expectation.stats.median - wage.stats.median, wage.stats.median || 1) : null },
    occupations: H.countBy(open, v => v.occupation || "—").slice(0, 15),
    regions: H.countBy(st.vacancies.filter(v => v.status === "open"), v => v.region || "—").slice(0, 15),
    sectors: H.countBy(open, v => v.sector || "—").slice(0, 12),
    seniority: W.SENIORITY.map(s => ({ label: s, demand: open.filter(v => v.seniority === s).length,
      supply: activeCands.filter(c => c.seniority === s).length })),
    formats: W.FORMATS.map(x => ({ label: x, n: open.filter(v => v.format === x).length })),
    skillDemand, skillGap,
    /* §9.1 Conversion Benchmark */
    funnel: {
      applied: apps.length,
      screened: ev(recent, "screen_passed").length,
      interviewed: ev(recent, "interview_completed").length,
      offered: offersSent.length,
      hired: hires.length,
    },
    rejectionReasons: H.countBy(offersRej.filter(r => r.reason), r => r.reason),
    /* §11.2 Training Purchase Signal — where demand outruns supply, say so out loud. */
    trainingSignals: skillGap.filter(s => s.demand >= 3 && s.gap >= 2)
      .map(s => ({ skill: s.skill, demand: s.demand, supply: s.supply,
        note: "Talab yuqori, mos nomzod kam — oʻquv kursi ochish uchun signal." })),
    privacy: "Kohorta " + COHORT_MIN + " tadan kam boʻlgan kesimlar koʻrsatilmaydi.",
  };
}

/** §19 minimum cohort threshold — suppressed, and reported as suppressed. */
function cohort(values){
  const v = (values || []).filter(x => H.N(x) > 0);
  if(v.length < COHORT_MIN) return { stats: null, n: v.length, suppressed: true, min: COHORT_MIN };
  return { stats: H.stats(v), n: v.length, suppressed: false };
}

/** Salary benchmark for one role/region, same privacy rule (§5.2 Salary Coach). */
function salaryBenchmark(q){
  const st  = W.load();
  const occ = H.S(q.occupation, 160).toLowerCase();
  const region = H.S(q.region, 120);
  const seniority = H.S(q.seniority, 20);
  const match = v => (!occ || String(v.occupation || v.title || "").toLowerCase().includes(occ))
    && (!region || v.region === region)
    && (!seniority || v.seniority === seniority);

  const offered = st.vacancies.filter(v => v.status === "open").filter(match)
    .map(v => v.salaryMax || v.salaryMin).filter(Boolean);
  const expected = st.candidates.filter(c => (!occ || String(c.occupation || "").toLowerCase().includes(occ))
    && (!region || c.region === region) && (!seniority || c.seniority === seniority))
    .map(c => c.expectedMax || c.expectedMin).filter(Boolean);

  return { ok: true, query: { occupation: occ, region, seniority },
    offered: cohort(offered), expected: cohort(expected),
    note: "Diapazon platformadagi ochiq vakansiya va nomzod kutilmalaridan hisoblanadi." };
}

module.exports = { COHORT_MIN, marketIntel, capitalIntel, laborIntel, salaryBenchmark, cohort };
