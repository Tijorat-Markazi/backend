/* ============================================================
   DATA ANALYST WORKBENCH

   A read-only surface over everything the three market modules
   have recorded, for the customers all three TZs describe:
   banks, universities, investors and government bodies who buy
   intelligence but must never touch operational data.

   Two rules hold throughout and are enforced here, not by
   convention:

   1. Aggregates only. Nothing in this file returns a company
      name paired with its terms, a candidate, a buyer's contact
      or any credential. Every export is a count, a share or a
      distribution.
   2. Small cohorts are suppressed. A segment thin enough to
      re-identify one participant is reported as suppressed
      rather than silently dropped, so a reader can tell the
      difference between "none" and "too few to show".
   ============================================================ */
const H = require("./store");
const B = require("./bozor");
const M = require("./moliya");
const W = require("./mehnat");
const I = require("./intel");
const PW = require("./passwords");

const COHORT_MIN = I.COHORT_MIN;          // one definition of "too few", shared
const MODULES = ["bozor", "moliya", "mehnat"];
const BUCKETS = { day: 864e5, week: 7 * 864e5, month: 30 * 864e5 };

/* ---------- accounts ----------
   Analysts live alongside associations and companies in orgs.json, so the
   admin manages them with the machinery that already exists. */
function authenticate(orgs, login, password){
  const lg = H.S(login, 80).trim(), pw = String(password == null ? "" : password);
  if(!lg) return null;
  const a = (orgs.analysts || []).find(x => x.login === lg && !x.suspended && PW.verify(x, pw));
  if(!a) return null;
  /* The scope list is authoritative. Treating an empty one as "unset, so allow
     everything" inverted the admin's intent: unchecking every market handed the
     account all three. Anything that is not an explicit, recognised market
     grants nothing. */
  const scopes = Array.isArray(a.scopes) ? a.scopes.filter(m => MODULES.includes(m)) : [];
  return { id: a.id, name: a.name, org: a.org || "", login: a.login, scopes };
}

/* No analyst in play means an admin-side call, which is unrestricted. */
const canSee = (analyst, module) => !analyst || (analyst.scopes || []).includes(module);

/* ---------- helpers ---------- */
const within = (rows, days, key) => (rows || [])
  .filter(r => H.N(r[key || "created"]) >= Date.now() - days * 864e5);

/** A distribution, or an honest statement that the cohort is too thin. */
function cohort(values){
  const v = (values || []).map(x => H.N(x, NaN)).filter(n => Number.isFinite(n) && n > 0);
  if(v.length < COHORT_MIN) return { n: v.length, suppressed: true, min: COHORT_MIN, stats: null };
  return { n: v.length, suppressed: false, min: COHORT_MIN, stats: H.stats(v) };
}

/** Bucketed counts over time, from whatever timestamp the caller names. */
function bucketise(rows, days, bucket, key){
  const size = BUCKETS[bucket] || BUCKETS.week;
  const now = Date.now();
  const from = now - days * 864e5;
  const slots = Math.max(1, Math.min(120, Math.ceil((days * 864e5) / size)));
  const out = [];
  for(let i = slots - 1; i >= 0; i--){
    const end = now - i * size, start = end - size;
    out.push({ from: Math.max(start, from), to: end, n: 0, value: 0 });
  }
  for(const r of rows || []){
    const t = H.N(r[key || "created"]);
    if(!t || t < from) continue;
    const idx = Math.min(out.length - 1, Math.floor((t - (now - slots * size)) / size));
    if(idx < 0 || !out[idx]) continue;
    out[idx].n++;
    out[idx].value += H.N(r.__value);
  }
  return out;
}

/* ============================================================
   OVERVIEW — one screen, all three markets plus the platform
   ============================================================ */
function overview(days, orgs){
  const d = Math.max(7, H.N(days, 90));
  const b = B.load(), m = M.load(), w = W.load();

  const bi = I.marketIntel(d), mi = I.capitalIntel(d), wi = I.laborIntel(d, {});
  const companies = (orgs && orgs.companies) || [];
  const assocs = (orgs && orgs.associations) || [];

  return {
    windowDays: d,
    platform: {
      associations: assocs.length,
      companies: companies.length,
      newCompanies: within(companies, d).length,
      sectors: new Set(companies.map(c => c.sector).filter(Boolean)).size,
      showroomItems: companies.reduce((a, c) => a + ((c.showroom || []).length), 0),
    },
    bozor: {
      products: bi.headline.liveProducts, sellers: bi.headline.sellers,
      rfqs: bi.headline.rfqs, quotes: bi.headline.quotes, deals: bi.headline.deals,
      matchRate: bi.headline.matchRate, tradeValue: bi.headline.tradeValue,
      inquiries: within(b.inquiries, d).length,
    },
    moliya: {
      providers: mi.headline.providers, products: mi.headline.products,
      investors: mi.headline.investors, requests: mi.headline.requests,
      offers: mi.headline.offers, askedValue: mi.headline.askedValue,
      fundingGapPct: mi.headline.fundingGapPct, capitalProgressed: mi.headline.capitalProgressed,
      projects: m.projects.length, startups: m.startups.length, ideas: m.ideas.length,
    },
    mehnat: {
      vacancies: wi.headline.openVacancies, seats: wi.headline.seats,
      candidates: wi.headline.activeCandidates, applications: wi.headline.applications,
      hires: wi.headline.hires, shortageIndex: wi.headline.shortageIndex,
      acceptanceRate: wi.headline.offerAcceptanceRate,
    },
    /* the funnels side by side — the comparison the three separate pages
       cannot show, and the reason this cabinet exists */
    funnels: [
      { module: "bozor", steps: [
        { label: "search", n: bi.funnel.search }, { label: "rfq", n: bi.funnel.rfq },
        { label: "quote", n: bi.funnel.quote }, { label: "deal", n: bi.funnel.deal },
        { label: "won", n: bi.funnel.won }] },
      { module: "moliya", steps: [
        { label: "request", n: mi.headline.requests }, { label: "offer", n: mi.headline.offers },
        { label: "progressed", n: m.requests.filter(r =>
            ["shortlisted", "underwriting", "closed"].includes(r.status)).length }] },
      { module: "mehnat", steps: [
        { label: "applied", n: wi.funnel.applied }, { label: "screened", n: wi.funnel.screened },
        { label: "interviewed", n: wi.funnel.interviewed }, { label: "offered", n: wi.funnel.offered },
        { label: "hired", n: wi.funnel.hired }] },
    ],
  };
}

/* ============================================================
   SEGMENTS — slice one module by one dimension
   ============================================================ */
const DIMENSIONS = {
  bozor:  ["sector", "category", "region", "channel", "market", "currency"],
  moliya: ["category", "sector", "region", "currency", "instrument", "stage"],
  mehnat: ["occupation", "region", "sector", "seniority", "format", "skill"],
};

function segment(opts){
  const module = MODULES.includes(H.S(opts.module, 10)) ? H.S(opts.module, 10) : "bozor";
  const dims = DIMENSIONS[module];
  const dimension = dims.includes(H.S(opts.dimension, 20)) ? H.S(opts.dimension, 20) : dims[0];
  const d = Math.max(7, H.N(opts.days, 90));

  const rows = module === "bozor"  ? bozorSegment(dimension, d)
             : module === "moliya" ? moliyaSegment(dimension, d)
             :                       mehnatSegment(dimension, d);

  return { module, dimension, dimensions: dims, windowDays: d,
           rows: rows.sort((a, b) => b.n - a.n).slice(0, 40),
           note: "Barcha ko'rsatkichlar agregat. Alohida ishtirokchi ma'lumoti ko'rsatilmaydi." };
}

function bozorSegment(dim, d){
  const st = B.load();
  const live = st.products.filter(p => p.status === "live");
  const rfqs = within(st.rfqs, d);
  const pick = p => dim === "channel" ? p.channels
              : dim === "market" ? p.markets
              : [p[dim]];
  const groups = new Map();
  const add = (k, f) => { if(!k) return; const g = groups.get(k) || { n: 0, demand: 0, prices: [] };
    f(g); groups.set(k, g); };

  live.forEach(p => (pick(p) || []).forEach(k => add(H.S(k, 120), g => { g.n++; if(p.price) g.prices.push(p.price); })));
  rfqs.forEach(r => {
    const keys = dim === "channel" ? [r.channel] : dim === "category" ? [r.category]
               : dim === "region" ? [r.region] : dim === "currency" ? [r.currency] : [];
    keys.forEach(k => add(H.S(k, 120), g => { g.demand++; }));
  });

  return [...groups.entries()].map(([label, g]) => ({
    label, n: g.n, demand: g.demand,
    ratio: Math.round(10 * g.demand / (g.n + 1)) / 10,
    price: cohort(g.prices),
  }));
}

function moliyaSegment(dim, d){
  const st = M.load();
  const live = st.products.filter(p => p.status === "live");
  const reqs = within(st.requests, d);
  const offers = within(st.offers, d);
  const answered = new Set(offers.map(o => o.requestId));
  const groups = new Map();
  const add = (k, f) => { if(!k) return; const g = groups.get(k) ||
    { n: 0, demand: 0, amounts: [], rates: [], answered: 0 }; f(g); groups.set(k, g); };

  const pickP = p => dim === "instrument" ? [p.instrument]
                   : dim === "sector" ? p.sectors : [p[dim]];
  live.forEach(p => (pickP(p) || []).forEach(k => add(H.S(k, 120), g => { g.n++; })));

  reqs.forEach(r => {
    const keys = dim === "category" ? [r.category] : dim === "sector" ? [r.sector]
               : dim === "region" ? [r.region] : dim === "currency" ? [r.currency]
               : dim === "instrument" ? (r.instruments || []) : [];
    keys.forEach(k => add(H.S(k, 120), g => {
      g.demand++; if(r.amount) g.amounts.push(r.amount);
      if(answered.has(r.id)) g.answered++;
    }));
  });

  if(dim === "stage"){
    groups.clear();
    st.projects.forEach(p => add(p.gate, g => { g.n++; if(p.capex) g.amounts.push(p.capex); }));
    st.startups.forEach(sx => add(sx.stage, g => { g.n++; if(sx.ask) g.amounts.push(sx.ask); }));
  }
  offers.forEach(o => { if(dim !== "currency") return;
    add(H.S(o.currency, 10), g => { if(o.ratePct) g.rates.push(o.ratePct); }); });

  return [...groups.entries()].map(([label, g]) => ({
    label, n: g.n, demand: g.demand,
    answeredPct: g.demand ? Math.round(100 * g.answered / g.demand) : null,
    amount: cohort(g.amounts), rate: cohort(g.rates),
  }));
}

function mehnatSegment(dim, d){
  const st = W.load();
  const open = st.vacancies.filter(v => v.status === "open");
  const cands = st.candidates.filter(c => c.availability === "active" || c.availability === "open");
  const groups = new Map();
  const add = (k, f) => { if(!k) return; const g = groups.get(k) ||
    { n: 0, supply: 0, seats: 0, salaries: [], expects: [] }; f(g); groups.set(k, g); };

  const pickV = v => dim === "skill" ? v.skillsRequired : [v[dim]];
  const pickC = c => dim === "skill" ? c.skills
                   : dim === "occupation" ? [c.occupation]
                   : dim === "region" ? [c.region]
                   : dim === "seniority" ? [c.seniority]
                   : dim === "format" ? (c.formats || []) : [];

  open.forEach(v => (pickV(v) || []).forEach(k => add(H.S(k, 120), g => {
    g.n++; g.seats += H.N(v.headcount, 1);
    const s = v.salaryMax || v.salaryMin; if(s) g.salaries.push(s);
  })));
  cands.forEach(c => (pickC(c) || []).forEach(k => add(H.S(k, 120), g => {
    g.supply++;
    const e = c.expectedMax || c.expectedMin; if(e) g.expects.push(e);
  })));

  return [...groups.entries()].map(([label, g]) => ({
    label, n: g.n, seats: g.seats, supply: g.supply,
    shortage: g.supply ? Math.round(100 * g.seats / g.supply) / 100 : null,
    offered: cohort(g.salaries), expected: cohort(g.expects),
  }));
}

/* ============================================================
   SERIES — the same metric over time
   ============================================================ */
const METRICS = {
  bozor:  ["products", "rfqs", "quotes", "deals", "inquiries", "searches"],
  moliya: ["requests", "offers", "products", "projects", "startups", "ideas"],
  mehnat: ["vacancies", "candidates", "applications", "hires", "searches"],
};

function series(opts){
  const module = MODULES.includes(H.S(opts.module, 10)) ? H.S(opts.module, 10) : "bozor";
  const metrics = METRICS[module];
  const metric = metrics.includes(H.S(opts.metric, 20)) ? H.S(opts.metric, 20) : metrics[0];
  const d = Math.max(7, H.N(opts.days, 90));
  const bucket = BUCKETS[H.S(opts.bucket, 10)] ? H.S(opts.bucket, 10) : "week";

  const st = module === "bozor" ? B.load() : module === "moliya" ? M.load() : W.load();
  const ev = t => st.events.filter(e => e.type === t).map(e => ({ created: e.t }));

  const source = {
    products: st.products, rfqs: st.rfqs, quotes: st.quotes, deals: st.deals,
    inquiries: st.inquiries, searches: ev("search"),
    requests: st.requests, offers: st.offers, projects: st.projects,
    startups: st.startups, ideas: st.ideas,
    vacancies: st.vacancies, candidates: st.candidates,
    applications: st.applications, hires: ev("hire_completed"),
  }[metric] || [];

  const points = bucketise(source, d, bucket, "created");
  const total = points.reduce((a, p) => a + p.n, 0);
  const half = Math.floor(points.length / 2);
  const older = points.slice(0, half).reduce((a, p) => a + p.n, 0);
  const newer = points.slice(half).reduce((a, p) => a + p.n, 0);

  return { module, metric, metrics, bucket, windowDays: d, points, total,
           trendPct: older ? Math.round(100 * (newer - older) / older) : null };
}

/* ============================================================
   EXPORT — the same aggregates as a workbook or a document
   ============================================================ */
function sheets(opts, orgs){
  const d = Math.max(7, H.N(opts.days, 90));
  const ov = overview(d, orgs);
  const out = [];

  out.push({ name: "Umumiy", rows: [
    ["Ko'rsatkich", "Qiymat"],
    ["Davr (kun)", d],
    ["Uyushmalar", ov.platform.associations],
    ["Kompaniyalar", ov.platform.companies],
    ["Yangi kompaniyalar", ov.platform.newCompanies],
    ["Bozor — live mahsulot", ov.bozor.products],
    ["Bozor — RFQ", ov.bozor.rfqs],
    ["Bozor — bitim", ov.bozor.deals],
    ["Bozor — match rate %", ov.bozor.matchRate],
    ["Moliya — provayder", ov.moliya.providers],
    ["Moliya — so'rov", ov.moliya.requests],
    ["Moliya — taklif", ov.moliya.offers],
    ["Moliya — funding gap %", ov.moliya.fundingGapPct],
    ["Mehnat — ochiq vakansiya", ov.mehnat.vacancies],
    ["Mehnat — faol nomzod", ov.mehnat.candidates],
    ["Mehnat — yollash", ov.mehnat.hires],
    ["Mehnat — shortage index", ov.mehnat.shortageIndex],
  ]});

  for(const mod of MODULES){
    if(opts.scopes && !opts.scopes.includes(mod)) continue;
    const dim = DIMENSIONS[mod][0];
    const seg = segment({ module: mod, dimension: dim, days: d });
    const head = mod === "mehnat"
      ? [dim, "vakansiya", "o'rin", "nomzod", "shortage", "maosh mediana"]
      : mod === "moliya"
      ? [dim, "mahsulot", "so'rov", "javob %", "summa mediana"]
      : [dim, "mahsulot", "talab", "talab/taklif", "narx mediana"];
    const rows = [head].concat(seg.rows.map(r => mod === "mehnat"
      ? [r.label, r.n, r.seats, r.supply, r.shortage,
         r.offered.suppressed ? "—" : r.offered.stats.median]
      : mod === "moliya"
      ? [r.label, r.n, r.demand, r.answeredPct,
         r.amount.suppressed ? "—" : r.amount.stats.median]
      : [r.label, r.n, r.demand, r.ratio,
         r.price.suppressed ? "—" : r.price.stats.median]));
    out.push({ name: mod[0].toUpperCase() + mod.slice(1), rows });
  }

  out.push({ name: "Izoh", rows: [
    ["Eslatma"],
    ["Barcha ko'rsatkichlar agregat holatda."],
    ["Kohortasi " + COHORT_MIN + " tadan kam bo'lgan kesimlar — belgisi bilan yashiriladi."],
    ["Shaxsiy va maxfiy tijorat ma'lumotlari eksportga kirmaydi."],
  ]});
  return out;
}

async function toXlsx(sheetList){
  const ExcelJS=require("exceljs"),wb=new ExcelJS.Workbook();
  for(const sheet of sheetList){const ws=wb.addWorksheet(String(sheet.name).replace(/[\\/*?:\[\]]/g," ").slice(0,28)||"Sheet");for(const row of sheet.rows)ws.addRow(row);}
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** The same figures as a Word-readable document, matching the platform's
 *  other reports, which are all .doc HTML. */
function toDoc(sheetList, title){
  const esc = s => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const body = sheetList.map(s => {
    const [head, ...rest] = s.rows;
    return `<h2>${esc(s.name)}</h2><table border="1" cellspacing="0" cellpadding="6">` +
      `<tr>${(head || []).map(h => `<th>${esc(h)}</th>`).join("")}</tr>` +
      rest.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join("")}</tr>`).join("") +
      `</table>`;
  }).join("");
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office"
    xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
    <head><meta charset="utf-8"><title>${esc(title)}</title>
    <style>body{font-family:Georgia,serif;padding:28px}h1{font-size:20pt}h2{font-size:13pt;margin-top:22px}
    table{border-collapse:collapse;width:100%;font-size:10pt}th{background:#eee;text-align:left}</style></head>
    <body><h1>${esc(title)}</h1>${body}</body></html>`;
}

module.exports = { MODULES, DIMENSIONS, METRICS, COHORT_MIN,
  authenticate, canSee, overview, segment, series, sheets, toXlsx, toDoc, cohort };
