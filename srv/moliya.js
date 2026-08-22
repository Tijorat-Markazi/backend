/* ============================================================
   MOLIYA BOZORI — financial marketplace + reverse finance auction
   TZ: "Tijorat markazi — Moliya bozori (Capital OS)", AI Lab, v1.0

   This half holds the money-supply side: the provider product
   catalogue (§4), the Funding Passport (§6) and the Reverse
   Finance Auction (§5). The capital side — investors, projects,
   startups, ideas — lives in moliya-capital.js.

   Legal boundary from the TZ, enforced in code, not just in copy:
   an offer created here is ALWAYS "indicative". Nothing in this
   module may present itself as a credit or investment commitment.
   ============================================================ */
const H = require("./store");

const CATEGORIES = ["banking", "nobank", "insurance", "fintech", "equity", "islamic", "development"];
const CURRENCIES = ["UZS", "USD", "EUR", "RUB"];
const SEGMENTS   = ["sme", "corporate", "startup", "exporter", "importer", "project", "agro"];
/* §5.1: Funding Request → eligibility routing → auction → compare → selection → underwriting */
const REQ_STATUS = ["open", "offers", "shortlisted", "underwriting", "closed"];
const OFFER_STATUS = ["indicative", "shortlisted", "declined", "withdrawn"];
/* §10 — instrument names are shown as-is; the platform never rules on Sharia compliance. */
const ISLAMIC = ["Murabaha", "Ijara", "Musharaka", "Mudaraba", "Salam", "Istisna", "Sukuk"];

const col  = H.collection("moliya.json",
  ["products", "requests", "offers", "passports", "investors", "projects", "startups", "ideas", "events"]);
const load = col.load, save = col.save;

/* ---------- provider product catalogue (TZ §4.2) ---------- */
function cleanProduct(b, provider, prev){
  const now = Date.now();
  return {
    id:           prev ? prev.id : H.uid("fp"),
    providerId:   H.S(provider.id, 40),
    providerName: H.S(provider.name, 160),
    category:     H.ONE(b.category, CATEGORIES, "banking"),
    name:         H.S(b.name, 200),
    instrument:   H.S(b.instrument, 120),
    summary:      H.S(b.summary, 2000),
    segments:     H.SUBSET(b.segments, SEGMENTS, 7),
    minAmount:    H.N(b.minAmount),
    maxAmount:    H.N(b.maxAmount),
    currency:     H.ONE(b.currency, CURRENCIES, "UZS"),
    tenorMin:     H.N(b.tenorMin),                  // months
    tenorMax:     H.N(b.tenorMax),
    rate:         H.S(b.rate, 120),                 // free text: rate OR fee model
    feeModel:     H.S(b.feeModel, 200),
    collateral:   H.S(b.collateral, 300),
    eligibility:  H.S(b.eligibility, 1500),
    rejectReasons:H.LIST(b.rejectReasons, 8, 200),
    docs:         H.LIST(b.docs, 15, 160),
    sectors:      H.LIST(b.sectors, 15),
    sla:          H.N(b.sla),                       // days to first decision, stated by the provider
    link:         /^https?:\/\//i.test(H.S(b.link, 400)) ? H.S(b.link, 400) : "",
    licence:      H.S(b.licence, 200),              // §4.2 requires the legal/licence status on the card
    sharia:       H.BOOL(b.sharia),
    status:       H.ONE(b.status, ["live", "archived"], "live"),
    created:      prev ? prev.created : now,
    updated:      now,
  };
}

/** §4.2: a card nobody has touched for a year is flagged, not silently trusted. */
const STALE_DAYS = 365;
const isStale = p => Date.now() - H.N(p.updated) > STALE_DAYS * 864e5;

function productSave(provider, body){
  const st   = load();
  const id   = H.S(body.id, 40);
  const prev = id ? st.products.find(p => p.id === id && p.providerId === provider.id) : null;
  if(id && !prev) return { error: "not_found" };
  const row = cleanProduct(body, provider, prev);
  if(!row.name) return { error: "name_required" };
  st.products = prev ? st.products.map(p => (p.id === prev.id ? row : p)) : st.products.concat([row]);
  H.logEvent(st, prev ? "product_updated" : "product_listed",
    { productId: row.id, category: row.category, providerId: provider.id });
  save(st);
  return { ok: true, product: pview(row) };
}

function productRemove(provider, id){
  const st = load();
  const before = st.products.length;
  st.products = st.products.filter(p => !(p.id === id && p.providerId === provider.id));
  if(st.products.length === before) return { error: "not_found" };
  save(st);
  return { ok: true };
}

const pview = p => Object.assign({}, p, { stale: isStale(p) });

/* ---------- Smart Finance Finder (TZ §4.3) ---------- */
function searchProducts(q){
  const st       = load();
  const query    = H.S(q.q, 300);
  const category = CATEGORIES.includes(H.S(q.category, 20)) ? H.S(q.category, 20) : "";
  const segment  = SEGMENTS.includes(H.S(q.segment, 20)) ? H.S(q.segment, 20) : "";
  const amount   = H.N(q.amount);
  const tenor    = H.N(q.tenor);
  const currency = CURRENCIES.includes(H.S(q.currency, 5)) ? H.S(q.currency, 5) : "";
  const sharia   = H.BOOL(q.sharia);
  const want     = query ? H.tokens(query) : null;

  let rows = st.products.filter(p => p.status === "live");
  if(category) rows = rows.filter(p => p.category === category);
  if(segment)  rows = rows.filter(p => !p.segments.length || p.segments.includes(segment));
  if(currency) rows = rows.filter(p => p.currency === currency);
  if(sharia)   rows = rows.filter(p => p.sharia || p.category === "islamic");
  if(amount)   rows = rows.filter(p => (!p.minAmount || amount >= p.minAmount) && (!p.maxAmount || amount <= p.maxAmount));
  if(tenor)    rows = rows.filter(p => (!p.tenorMin || tenor >= p.tenorMin) && (!p.tenorMax || tenor <= p.tenorMax));

  if(want){
    rows = rows
      .map(p => ({ p, r: H.coverage(want, [p.name, p.instrument, p.summary, p.eligibility, p.sectors.join(" ")].join(" ")) }))
      .filter(x => x.r > 0).sort((a, b) => b.r - a.r).map(x => x.p);
  } else {
    rows = rows.slice().sort((a, b) => b.updated - a.updated);
  }

  H.logEvent(st, "finance_search", { q: query, category, amount, tenor, currency, results: rows.length });
  save(st);

  const all = st.products.filter(p => p.status === "live");
  return {
    items: rows.slice(0, 200).map(pview),
    total: rows.length,
    facets: {
      categories: CATEGORIES.map(c => ({ id: c, n: all.filter(p => p.category === c).length })),
      providers:  H.countBy(all, p => p.providerName).map(x => x.label),
      sectors:    H.countBy(all, p => p.sectors).map(x => x.label),
    },
    disclaimer: "Katalogdagi shartlar maʼlumot uchun. Yakuniy qaror moliya tashkiloti tomonidan qabul qilinadi.",
  };
}

/* ---------- Funding Passport (TZ §6) ---------- */
function cleanPassport(b, owner, prev){
  return {
    id:        prev ? prev.id : H.uid("fpp"),
    ownerId:   H.S(owner.id, 40),
    ownerName: H.S(owner.name, 160),
    sector:    H.S(b.sector || owner.sector, 120),
    region:    H.S(b.region, 120),
    legalForm: H.S(b.legalForm, 120),
    founded:   H.N(b.founded),
    employees: H.N(b.employees),
    revenue:   H.N(b.revenue),
    ebitda:    H.N(b.ebitda),
    debt:      H.N(b.debt),
    currency:  H.ONE(b.currency, CURRENCIES, "UZS"),
    exporter:  H.BOOL(b.exporter),
    need:      H.N(b.need),
    purpose:   H.S(b.purpose, 1000),
    tenor:     H.N(b.tenor),
    instruments: H.LIST(b.instruments, 8, 60),
    collateral:H.S(b.collateral, 1000),
    collateralValue: H.N(b.collateralValue),
    receivables: H.N(b.receivables),
    contracts: H.S(b.contracts, 1000),
    docs:      H.LIST(b.docs, 20, 160),
    risks:     H.S(b.risks, 1000),
    /* §6.1 "share by purpose": the passport is private until the owner opens
       specific scopes to specific counterparties. */
    consents:  Array.isArray(prev && prev.consents) ? prev.consents : [],
    created:   prev ? prev.created : Date.now(),
    updated:   Date.now(),
  };
}

function passportSave(owner, body){
  const st   = load();
  const prev = st.passports.find(p => p.ownerId === owner.id);
  const row  = cleanPassport(body, owner, prev);
  st.passports = prev ? st.passports.map(p => (p.id === prev.id ? row : p)) : st.passports.concat([row]);
  H.logEvent(st, "passport_saved", { ownerId: owner.id, need: row.need, currency: row.currency, sector: row.sector });
  save(st);
  return { ok: true, passport: row, readiness: readiness(row) };
}

function passportOf(ownerId){
  const p = load().passports.find(x => x.ownerId === ownerId);
  return p ? { ok: true, passport: p, readiness: readiness(p) } : { ok: true, passport: null, readiness: null };
}

/** §30.1 Capital Passport Score — a funding-readiness gap map, NOT credit scoring. */
function readiness(p){
  if(!p) return null;
  const blocks = [
    { key: "Identity & KYB", ok: !!(p.legalForm && p.founded), hint: "Yuridik shakl va tashkil etilgan yilni koʻrsating" },
    { key: "Financials",     ok: !!(p.revenue && p.ebitda !== undefined && p.revenue > 0), hint: "Tushum va EBITDA raqamlarini kiriting" },
    { key: "Funding need",   ok: !!(p.need && p.tenor && p.purpose), hint: "Summa, muddat va maqsadni aniq yozing" },
    { key: "Collateral",     ok: !!(p.collateral || p.collateralValue || p.receivables), hint: "Taʼminot yoki debitorlik maʼlumotini qoʻshing" },
    { key: "Business",       ok: !!(p.sector && p.region && p.employees), hint: "Sektor, hudud va xodimlar sonini toʻldiring" },
    { key: "Documents",      ok: (p.docs || []).length >= 3, hint: "Kamida 3 ta asosiy hujjatni roʻyxatga oling" },
    { key: "Risk",           ok: !!p.risks, hint: "Asosiy risklar va ularni kamaytirish choralarini yozing" },
  ];
  const done = blocks.filter(b => b.ok).length;
  return {
    score: Math.round(100 * done / blocks.length),
    blocks: blocks.map(b => ({ key: b.key, ok: b.ok, hint: b.ok ? "" : b.hint })),
    note: "Bu kredit reytingi emas — moliyalashtirishga tayyorlik (funding readiness) koʻrsatkichi.",
  };
}

/** §6.1 consent: time-boxed, purpose-bound, revocable, and logged. */
function consentGrant(owner, body){
  const st = load();
  const p  = st.passports.find(x => x.ownerId === owner.id);
  if(!p) return { error: "passport_required" };
  const row = {
    id: H.uid("cs"),
    to: H.S(body.to, 160),
    purpose: H.S(body.purpose, 200),
    scope: H.LIST(body.scope, 10, 40),
    days: Math.min(365, Math.max(1, H.N(body.days, 30))),
    granted: Date.now(),
    revokedAt: 0,
  };
  const next = Object.assign({}, p, { consents: (p.consents || []).concat([row]).slice(-100) });
  st.passports = st.passports.map(x => (x.id === p.id ? next : x));
  H.logEvent(st, "consent_granted", { ownerId: owner.id, to: row.to, scope: row.scope, days: row.days });
  save(st);
  return { ok: true, consents: next.consents };
}

function consentRevoke(owner, id){
  const st = load();
  const p  = st.passports.find(x => x.ownerId === owner.id);
  if(!p) return { error: "not_found" };
  const next = Object.assign({}, p, {
    consents: (p.consents || []).map(c => (c.id === id ? Object.assign({}, c, { revokedAt: Date.now() }) : c)),
  });
  st.passports = st.passports.map(x => (x.id === p.id ? next : x));
  H.logEvent(st, "consent_revoked", { ownerId: owner.id, consentId: id });
  save(st);
  return { ok: true, consents: next.consents };
}

/* ---------- Reverse Finance Auction (TZ §5) ---------- */
function requestAdd(body, actor){
  const st  = load();
  const row = {
    id:        H.uid("fr"),
    ownerId:   H.S(actor && actor.id, 40),
    ownerName: H.S((actor && actor.name) || body.ownerName, 160) || "Anonim soʻrov",
    /* §5.1 step 3 — the requester chooses blind or identified. */
    anonymous: H.BOOL(body.anonymous),
    amount:    H.N(body.amount),
    currency:  H.ONE(body.currency, CURRENCIES, "UZS"),
    purpose:   H.S(body.purpose, 1000),
    tenor:     H.N(body.tenor),
    instruments: H.LIST(body.instruments, 8, 60),
    category:  CATEGORIES.includes(H.S(body.category, 20)) ? H.S(body.category, 20) : "",
    sector:    H.S(body.sector, 120),
    region:    H.S(body.region, 120),
    revenue:   H.N(body.revenue),
    collateral:H.S(body.collateral, 500),
    sharia:    H.BOOL(body.sharia),
    deadline:  H.S(body.deadline, 20),
    contact:   H.S(body.contact, 200),
    status:    "open",
    created:   Date.now(),
  };
  if(!row.amount) return { error: "amount_required" };
  st.requests = st.requests.concat([row]);
  H.logEvent(st, "funding_request", { requestId: row.id, amount: row.amount, currency: row.currency,
    tenor: row.tenor, sector: row.sector, region: row.region, category: row.category });
  save(st);
  return { ok: true, request: publicRequest(row), matches: routeRequest(row, st).slice(0, 10) };
}

/** Blind auction: the identity is withheld from the board, the deal room is where it opens. */
const publicRequest = r => Object.assign({}, r, {
  ownerName: r.anonymous ? "Anonim (verifikatsiyalangan)" : r.ownerName,
  contact: "",
});

function requestList(filter){
  const st = load();
  const f  = filter || {};
  let rows = st.requests.slice().sort((a, b) => b.created - a.created);
  if(f.status) rows = rows.filter(r => r.status === H.S(f.status, 20));
  if(f.category) rows = rows.filter(r => r.category === H.S(f.category, 20));
  return rows.slice(0, 200).map(r => Object.assign(publicRequest(r), {
    offerCount: st.offers.filter(o => o.requestId === r.id).length,
  }));
}

/** §5.1 step 2 — eligibility routing: which live products can even look at this. */
function routeRequest(req, st){
  const store = st || load();
  return store.products
    .filter(p => p.status === "live")
    .filter(p => !req.sharia || p.sharia || p.category === "islamic")
    .map(p => {
      const amt = (!req.amount || !(p.minAmount || p.maxAmount))
        ? { value: 0.6, known: false }
        : { value: (!p.minAmount || req.amount >= p.minAmount) && (!p.maxAmount || req.amount <= p.maxAmount) ? 1 : 0.2, known: true };
      const ten = (!req.tenor || !(p.tenorMin || p.tenorMax))
        ? { value: 0.6, known: false }
        : { value: (!p.tenorMin || req.tenor >= p.tenorMin) && (!p.tenorMax || req.tenor <= p.tenorMax) ? 1 : 0.25, known: true };
      const cur = { value: !req.currency || !p.currency ? 0.6 : (req.currency === p.currency ? 1 : 0.3),
                    known: !!(req.currency && p.currency) };
      const cat = req.category ? { value: req.category === p.category ? 1 : 0.3, known: true } : { value: 0.6, known: false };
      const sec = (p.sectors || []).length && req.sector
        ? { value: p.sectors.some(s => s.toLowerCase() === req.sector.toLowerCase()) ? 1 : 0.4, known: true }
        : { value: 0.6, known: false };
      const purpose = H.coverage(H.tokens([req.purpose, req.instruments.join(" ")].join(" ")),
        [p.name, p.instrument, p.summary, p.eligibility].join(" "));

      const s = H.score([
        { weight: 26, value: amt.value, known: amt.known, why: "Summa mahsulot diapazonida", gap: "Summa mahsulot diapazonidan tashqarida" },
        { weight: 20, value: ten.value, known: ten.known, why: "Muddat mahsulot shartlariga mos", gap: "Muddat mahsulot shartlariga mos emas" },
        { weight: 14, value: cur.value, known: cur.known, why: "Valyuta mos", gap: "Valyuta farq qiladi" },
        { weight: 14, value: cat.value, known: cat.known, why: "Soʻralgan moliya turi mos", gap: "Boshqa toifadagi mahsulot" },
        { weight: 12, value: sec.value, known: sec.known, why: "Provayder shu sektor bilan ishlaydi", gap: "Provayder sektor roʻyxatida bu soha yoʻq" },
        { weight: 14, value: purpose, why: "Maqsad mahsulot taʼrifiga mos", gap: "Maqsad mahsulot taʼrifi bilan bogʻlanmadi" },
      ]);
      return Object.assign({ product: pview(p) }, s);
    })
    .filter(m => m.score > 0)
    .sort((a, b) => b.score - a.score);
}

function requestMatches(id){
  const st  = load();
  const req = st.requests.find(r => r.id === id);
  if(!req) return { error: "not_found" };
  return { ok: true, request: publicRequest(req), matches: routeRequest(req, st).slice(0, 25) };
}

/* ---------- indicative offers (TZ §5.2) ---------- */
function offerAdd(body, provider){
  const st  = load();
  const req = st.requests.find(r => r.id === H.S(body.requestId, 40));
  if(!req) return { error: "request_not_found" };
  if(req.status === "closed") return { error: "request_closed" };

  const amount = H.N(body.amount) || req.amount;
  const row = {
    id:           H.uid("of"),
    requestId:    req.id,
    providerId:   H.S(provider.id, 40),
    providerName: H.S(provider.name, 160),
    productId:    H.S(body.productId, 40),
    amount,
    currency:     H.ONE(body.currency, CURRENCIES, req.currency),
    ratePct:      H.N(body.ratePct),
    feePct:       H.N(body.feePct),
    tenor:        H.N(body.tenor) || req.tenor,
    grace:        H.N(body.grace),
    collateral:   H.S(body.collateral, 400),
    covenants:    H.S(body.covenants, 800),
    conditions:   H.S(body.conditions, 1200),
    validity:     H.S(body.validity, 20),
    slaDays:      H.N(body.slaDays),
    /* Never anything but indicative — see the module header. */
    status:       "indicative",
    created:      Date.now(),
  };
  st.offers   = st.offers.concat([row]);
  st.requests = st.requests.map(r => (r.id === req.id && r.status === "open" ? Object.assign({}, r, { status: "offers" }) : r));
  H.logEvent(st, "offer_made", { requestId: req.id, offerId: row.id, providerId: provider.id,
    amount: row.amount, currency: row.currency, ratePct: row.ratePct, tenor: row.tenor,
    hours: Math.round((row.created - req.created) / 36e5) });
  save(st);
  return { ok: true, offer: row };
}

/**
 * §5.2 — every offer is normalised to the same all-in cost basis before it is
 * compared, so a low headline rate with a fat arrangement fee cannot look
 * cheaper than it is.
 */
function offerCompare(requestId){
  const st  = load();
  const req = st.requests.find(r => r.id === requestId);
  if(!req) return { error: "not_found" };
  const rows = st.offers.filter(o => o.requestId === requestId).sort((a, b) => a.created - b.created);

  const priced = rows.map(o => {
    const years = Math.max(H.N(o.tenor) / 12, 1 / 12);
    /* fee is one-off, spread across the life of the facility; rate is annual */
    const allIn = H.N(o.ratePct) + (H.N(o.feePct) / years);
    return Object.assign({}, o, { allInPct: Math.round(allIn * 100) / 100 });
  });
  const costs = priced.map(o => o.allInPct).filter(x => x > 0);
  const best  = costs.length ? Math.min.apply(null, costs) : null;

  return {
    ok: true,
    request: publicRequest(req),
    offers: priced.map(o => Object.assign({}, o, { bestCost: best != null && o.allInPct === best })),
    summary: { count: priced.length, allIn: H.stats(costs), tenor: H.stats(priced.map(o => o.tenor)) },
    method: "All-in % = yillik stavka + (bir martalik komissiya ÷ muddat, yilda). Barcha takliflar bir xil metodologiyada.",
    disclaimer: "Takliflar indikativ. Ular kredit yoki investitsiya majburiyati emas.",
  };
}

function requestSetStatus(owner, body){
  const st  = load();
  const id  = H.S(body.id, 40);
  const req = st.requests.find(r => r.id === id);
  if(!req) return { error: "not_found" };
  if(req.ownerId && owner && req.ownerId !== owner.id) return { error: "forbidden" };
  const status = REQ_STATUS.includes(H.S(body.status, 20)) ? H.S(body.status, 20) : req.status;
  const next = Object.assign({}, req, { status });
  st.requests = st.requests.map(r => (r.id === id ? next : r));
  if(H.S(body.offerId, 40)){
    st.offers = st.offers.map(o => (o.requestId === id
      ? Object.assign({}, o, { status: o.id === body.offerId ? "shortlisted" : "declined" })
      : o));
  }
  H.logEvent(st, "request_status", { requestId: id, status, offerId: H.S(body.offerId, 40) });
  save(st);
  return { ok: true, request: publicRequest(next) };
}

function offersOf(providerId){
  const st = load();
  return st.offers.filter(o => o.providerId === providerId)
    .sort((a, b) => b.created - a.created)
    .map(o => Object.assign({}, o, {
      request: (() => { const r = st.requests.find(x => x.id === o.requestId); return r ? publicRequest(r) : null; })(),
    }));
}

function requestsOf(ownerId){
  const st = load();
  return st.requests.filter(r => r.ownerId === ownerId)
    .sort((a, b) => b.created - a.created)
    .map(r => Object.assign({}, r, { offerCount: st.offers.filter(o => o.requestId === r.id).length }));
}

function productsOf(providerId){
  return load().products.filter(p => p.providerId === providerId)
    .sort((a, b) => b.updated - a.updated).map(pview);
}

module.exports = {
  CATEGORIES, CURRENCIES, SEGMENTS, REQ_STATUS, OFFER_STATUS, ISLAMIC,
  load, save, pview, publicRequest,
  productSave, productRemove, productsOf, searchProducts,
  passportSave, passportOf, readiness, consentGrant, consentRevoke,
  requestAdd, requestList, requestMatches, requestSetStatus, requestsOf, routeRequest,
  offerAdd, offerCompare, offersOf,
};
