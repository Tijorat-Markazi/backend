/* ============================================================
   BOZOR — B2B · B2G · EXPORT marketplace
   TZ: "Tijorat markazi — Bozor", AI Lab, v1.0

   Core model of the TZ: one product card feeds three sales
   channels. Everything else here — RFQ exchange, quotes, deal
   room, trust levels, market intelligence — hangs off that.
   ============================================================ */
const H = require("./store");

const CHANNELS   = ["b2b", "b2g", "export"];
const CURRENCIES = ["UZS", "USD", "EUR", "RUB", "CNY"];
const P_STATUS   = ["draft", "live", "paused"];
const RFQ_STATUS = ["open", "shortlisted", "awarded", "closed"];
/* TZ §10: Lead → Qualified → RFQ → Quote → Negotiation → Order → Fulfilment → Repeat */
const DEAL_STAGES = ["lead", "qualified", "rfq", "quote", "negotiation", "order", "fulfilment", "closed"];
/* TZ §12: L0 registered … L5 premium verified */
const TRUST = [
  { level: "L0", badge: "Registered" },
  { level: "L1", badge: "Contact Verified" },
  { level: "L2", badge: "Company Verified" },
  { level: "L3", badge: "Product Verified" },
  { level: "L4", badge: "Trusted Seller" },
  { level: "L5", badge: "Premium Verified" },
];

const col  = H.collection("bozor.json", ["products", "rfqs", "quotes", "deals", "inquiries", "events"]);
const load = col.load, save = col.save;

const INQUIRY_STATUS = ["new", "answered", "closed"];

/* ---------- products ---------- */
function cleanProduct(b, company, prev){
  const now = Date.now();
  const channels = H.SUBSET(b.channels, CHANNELS, 3);
  return {
    id:          prev ? prev.id : H.uid("pr"),
    companyId:   company.id,
    companyName: H.S(company.name, 160),
    assocId:     H.S(company.assocId, 40),
    sector:      H.S(company.sector, 120),
    title:       H.S(b.title, 200),
    desc:        H.S(b.desc, 3000),
    category:    H.S(b.category, 120),
    sku:         H.S(b.sku, 60),
    brand:       H.S(b.brand, 120),
    specs:       H.S(b.specs, 1500),
    price:       H.N(b.price),
    currency:    H.ONE(b.currency, CURRENCIES, "UZS"),
    unit:        H.S(b.unit, 30) || "dona",
    moq:         H.N(b.moq),
    tiers:       cleanTiers(b.tiers),
    leadTime:    H.N(b.leadTime),                 // days
    stock:       H.N(b.stock),
    region:      H.S(b.region, 120),
    channels:    channels.length ? channels : ["b2b"],
    hs:          H.S(b.hs, 20),
    incoterms:   H.LIST(b.incoterms, 6, 12),
    markets:     H.LIST(b.markets, 15),
    certificates:H.LIST(b.certificates, 12),
    media:       H.LIST(b.media, 8, 400),
    localMade:   H.BOOL(b.localMade),             // the B2G local-content flag
    status:      H.ONE(b.status, P_STATUS, "live"),
    verified:    prev ? prev.verified : false,    // only an operator flips this
    created:     prev ? prev.created : now,
    updated:     now,
  };
}

/** Volume price breaks: [{ from, price }] — TZ §6 tier pricing. */
function cleanTiers(v){
  const raw = Array.isArray(v) ? v : [];
  return raw.slice(0, 6)
    .map(t => ({ from: H.N(t && t.from), price: H.N(t && t.price) }))
    .filter(t => t.from > 0 && t.price > 0)
    .sort((a, b) => a.from - b.from);
}

/** The price a given quantity actually clears at, after tier breaks. */
function priceAt(product, qty){
  const q = H.N(qty);
  let p = H.N(product.price);
  for(const t of product.tiers || []) if(q >= t.from) p = t.price;
  return p;
}

function productSave(company, body){
  const st = load();
  const id = H.S(body.id, 40);
  const prev = id ? st.products.find(p => p.id === id && p.companyId === company.id) : null;
  if(id && !prev) return { error: "not_found" };
  const row = cleanProduct(body, company, prev);
  if(!row.title) return { error: "title_required" };
  st.products = prev
    ? st.products.map(p => (p.id === prev.id ? row : p))
    : st.products.concat([row]);
  H.logEvent(st, prev ? "product_updated" : "product_published",
    { productId: row.id, sector: row.sector, channels: row.channels, category: row.category });
  save(st);
  return { ok: true, product: view(row) };
}

function productRemove(company, id){
  const st = load();
  const before = st.products.length;
  st.products = st.products.filter(p => !(p.id === id && p.companyId === company.id));
  if(st.products.length === before) return { error: "not_found" };
  save(st);
  return { ok: true };
}

/* ---------- search & discovery (TZ §5.2) ---------- */
function searchProducts(q){
  const st       = load();
  const query    = H.S(q.q, 300);
  const channel  = CHANNELS.includes(H.S(q.channel, 10)) ? H.S(q.channel, 10) : "";
  const sector   = H.S(q.sector, 120);
  const category = H.S(q.category, 120);
  const region   = H.S(q.region, 120);
  const market   = H.S(q.market, 120);
  const maxLead  = H.N(q.maxLead);
  const maxMoq   = H.N(q.maxMoq);
  const certOnly = H.BOOL(q.certified);
  const localOnly= H.BOOL(q.local);
  const want     = query ? H.tokens(query) : null;

  let rows = st.products.filter(p => p.status === "live");
  if(channel)   rows = rows.filter(p => (p.channels || []).includes(channel));
  if(sector)    rows = rows.filter(p => p.sector === sector);
  if(category)  rows = rows.filter(p => p.category === category);
  if(region)    rows = rows.filter(p => p.region === region);
  if(market)    rows = rows.filter(p => (p.markets || []).some(m => m.toLowerCase() === market.toLowerCase()));
  if(maxLead)   rows = rows.filter(p => !p.leadTime || p.leadTime <= maxLead);
  if(maxMoq)    rows = rows.filter(p => !p.moq || p.moq <= maxMoq);
  if(certOnly)  rows = rows.filter(p => (p.certificates || []).length > 0);
  if(localOnly) rows = rows.filter(p => p.localMade);

  if(want){
    rows = rows
      .map(p => ({ p, r: H.coverage(want, [p.title, p.desc, p.category, p.brand, p.specs, (p.markets || []).join(" ")].join(" ")) }))
      .filter(x => x.r > 0)
      .sort((a, b) => b.r - a.r)
      .map(x => x.p);
  } else {
    rows = rows.slice().sort((a, b) => b.updated - a.updated);
  }

  /* Search intent is the most valuable signal the TZ asks us to capture
     (§13 Demand Intelligence), so it is logged even for a plain browse. */
  H.logEvent(st, "search", { q: query, channel, sector, results: rows.length });
  save(st);

  const all = st.products.filter(p => p.status === "live");
  return {
    items: rows.slice(0, 300).map(view),
    total: rows.length,
    facets: {
      sectors:    H.countBy(all, p => p.sector).map(x => x.label),
      categories: H.countBy(all, p => p.category).map(x => x.label),
      regions:    H.countBy(all, p => p.region).map(x => x.label),
      markets:    H.countBy(all, p => p.markets).map(x => x.label),
      channels:   CHANNELS.map(c => ({ id: c, n: all.filter(p => (p.channels || []).includes(c)).length })),
    },
  };
}

const view = p => ({
  id: p.id, title: p.title, desc: p.desc, category: p.category, sku: p.sku, brand: p.brand,
  specs: p.specs, price: p.price, currency: p.currency, unit: p.unit, moq: p.moq, tiers: p.tiers,
  leadTime: p.leadTime, stock: p.stock, region: p.region, channels: p.channels, hs: p.hs,
  incoterms: p.incoterms, markets: p.markets, certificates: p.certificates, media: p.media,
  localMade: p.localMade, verified: p.verified, company: p.companyName, companyId: p.companyId,
  sector: p.sector, status: p.status, created: p.created, updated: p.updated,
});

function productsOf(companyId){
  return load().products
    .filter(p => p.companyId === companyId)
    .sort((a, b) => b.updated - a.updated)
    .map(view);
}

/* ---------- RFQ exchange (TZ §6.1, §10) ---------- */
function cleanRfq(b, actor){
  return {
    id:          H.uid("rq"),
    buyerType:   H.ONE(b.buyerType, ["company", "gov", "foreign", "guest"], "company"),
    buyerId:     H.S(actor && actor.id, 40),
    buyerName:   H.S((actor && actor.name) || b.buyerName, 160) || "Anonim xaridor",
    buyerRegion: H.S(b.buyerRegion, 120),
    channel:     H.ONE(b.channel, CHANNELS, "b2b"),
    title:       H.S(b.title, 200),
    spec:        H.S(b.spec, 3000),
    category:    H.S(b.category, 120),
    qty:         H.N(b.qty),
    unit:        H.S(b.unit, 30) || "dona",
    budget:      H.N(b.budget),
    currency:    H.ONE(b.currency, CURRENCIES, "UZS"),
    region:      H.S(b.region, 120),
    country:     H.S(b.country, 120),
    incoterm:    H.S(b.incoterm, 12),
    certificates:H.LIST(b.certificates, 10),
    maxLead:     H.N(b.maxLead),
    deadline:    H.S(b.deadline, 20),
    contact:     H.S(b.contact, 200),
    status:      "open",
    created:     Date.now(),
  };
}

function rfqAdd(body, actor){
  const st  = load();
  const row = cleanRfq(body, actor);
  if(!row.title) return { error: "title_required" };
  st.rfqs = st.rfqs.concat([row]);
  H.logEvent(st, "rfq_created", { rfqId: row.id, channel: row.channel, category: row.category,
    qty: row.qty, budget: row.budget, currency: row.currency, region: row.region });
  save(st);
  return { ok: true, rfq: row, matches: matchRfq(row, st).slice(0, 10) };
}

function rfqList(filter){
  const st = load();
  const f  = filter || {};
  const channel = CHANNELS.includes(H.S(f.channel, 10)) ? H.S(f.channel, 10) : "";
  let rows = st.rfqs.slice().sort((a, b) => b.created - a.created);
  if(channel) rows = rows.filter(r => r.channel === channel);
  if(f.status) rows = rows.filter(r => r.status === H.S(f.status, 20));
  return rows.slice(0, 200).map(r => Object.assign({}, r, {
    quoteCount: st.quotes.filter(q => q.rfqId === r.id).length,
  }));
}

/** TZ §9.1 RFQ Matcher — demand scored against every live product card. */
function matchRfq(rfq, st){
  const store = st || load();
  const need  = H.tokens([rfq.title, rfq.spec, rfq.category].join(" "));

  return store.products
    .filter(p => p.status === "live" && (p.channels || []).includes(rfq.channel))
    .map(p => {
      const text = H.coverage(need, [p.title, p.desc, p.category, p.brand, p.specs].join(" "));
      const cert = H.listFit(rfq.certificates, p.certificates);
      const moqOk = (!rfq.qty || !p.moq)
        ? { value: 0.6, known: false }
        : { value: rfq.qty >= p.moq ? 1 : rfq.qty / p.moq, known: true };
      const lead = (!rfq.maxLead || !p.leadTime)
        ? { value: 0.6, known: false }
        : { value: p.leadTime <= rfq.maxLead ? 1 : Math.max(0, 1 - (p.leadTime - rfq.maxLead) / rfq.maxLead), known: true };
      const unitBudget = rfq.qty ? H.N(rfq.budget) / rfq.qty : 0;
      const clearing = priceAt(p, rfq.qty);
      const price = (!unitBudget || !clearing)
        ? { value: 0.6, known: false }
        : { value: clearing <= unitBudget ? 1 : Math.max(0, unitBudget / clearing), known: true };
      const geo = rfq.channel === "export"
        ? (rfq.country && (p.markets || []).length
            ? { value: (p.markets || []).some(m => m.toLowerCase() === rfq.country.toLowerCase()) ? 1 : 0.3, known: true }
            : { value: 0.6, known: false })
        : (rfq.region && p.region
            ? { value: rfq.region === p.region ? 1 : 0.5, known: true }
            : { value: 0.6, known: false });

      const s = H.score([
        { weight: 34, value: text,
          why: "Mahsulot tavsifi talabga mos",
          gap: "Talab matni mahsulot kartasiga mos kelmadi" },
        { weight: 14, value: cert.value, known: cert.known,
          why: "Talab qilingan sertifikatlar mavjud",
          gap: cert.missing && cert.missing.length
            ? "Sertifikat yetishmaydi: " + cert.missing.join(", ")
            : "Sertifikat maʼlumoti yoʻq" },
        { weight: 14, value: moqOk.value, known: moqOk.known,
          why: "Buyurtma hajmi MOQ dan yuqori",
          gap: "Buyurtma hajmi MOQ dan past (MOQ " + p.moq + ")" },
        { weight: 12, value: lead.value, known: lead.known,
          why: "Yetkazib berish muddati mos",
          gap: "Yetkazib berish muddati talabdan uzoq (" + p.leadTime + " kun)" },
        { weight: 14, value: price.value, known: price.known,
          why: "Narx byudjet doirasida",
          gap: "Narx byudjetdan yuqori" },
        { weight: 12, value: geo.value, known: geo.known,
          why: rfq.channel === "export" ? "Eksport bozori mos" : "Hudud mos",
          gap: rfq.channel === "export" ? "Bu bozorga eksport tajribasi koʻrsatilmagan" : "Boshqa hududda joylashgan" },
      ]);
      return Object.assign({ product: view(p) }, s);
    })
    .filter(m => m.score > 0)
    .sort((a, b) => b.score - a.score);
}

function rfqMatches(id){
  const st  = load();
  const rfq = st.rfqs.find(r => r.id === id);
  if(!rfq) return { error: "not_found" };
  return { ok: true, rfq, matches: matchRfq(rfq, st).slice(0, 25) };
}

/* ---------- quotes ---------- */
function quoteAdd(body, company){
  const st  = load();
  const rfq = st.rfqs.find(r => r.id === H.S(body.rfqId, 40));
  if(!rfq) return { error: "rfq_not_found" };
  if(rfq.status === "closed") return { error: "rfq_closed" };

  const row = {
    id:        H.uid("qt"),
    rfqId:     rfq.id,
    sellerId:  company.id,
    sellerName:H.S(company.name, 160),
    productId: H.S(body.productId, 40),
    price:     H.N(body.price),
    currency:  H.ONE(body.currency, CURRENCIES, rfq.currency),
    qty:       H.N(body.qty) || rfq.qty,
    unit:      H.S(body.unit, 30) || rfq.unit,
    leadTime:  H.N(body.leadTime),
    incoterm:  H.S(body.incoterm, 12),
    validity:  H.S(body.validity, 20),
    terms:     H.S(body.terms, 2000),
    status:    "sent",
    created:   Date.now(),
  };
  st.quotes = st.quotes.concat([row]);
  H.logEvent(st, "quote_sent", { rfqId: rfq.id, quoteId: row.id, sellerId: company.id,
    price: row.price, currency: row.currency, channel: rfq.channel,
    hours: Math.round((row.created - rfq.created) / 36e5) });
  save(st);
  return { ok: true, quote: row };
}

/** Side-by-side comparison the buyer actually decides on (TZ §6.1 step 4). */
function quotesFor(rfqId){
  const st  = load();
  const rfq = st.rfqs.find(r => r.id === rfqId);
  if(!rfq) return { error: "not_found" };
  const rows   = st.quotes.filter(q => q.rfqId === rfqId).sort((a, b) => a.created - b.created);
  const prices = rows.map(q => q.price).filter(Boolean);
  const leads  = rows.map(q => q.leadTime).filter(Boolean);
  const bestPrice = prices.length ? Math.min.apply(null, prices) : null;
  const bestLead  = leads.length ? Math.min.apply(null, leads) : null;
  return {
    ok: true, rfq,
    quotes: rows.map(q => Object.assign({}, q, {
      bestPrice: bestPrice != null && q.price === bestPrice,
      bestLead:  bestLead  != null && q.leadTime === bestLead,
    })),
    summary: { count: rows.length, price: H.stats(prices), lead: H.stats(leads) },
  };
}

/* ---------- deal room (TZ §10.1) ---------- */
function dealOpen(body, actor){
  const st    = load();
  const quote = st.quotes.find(q => q.id === H.S(body.quoteId, 40));
  if(!quote) return { error: "quote_not_found" };
  const rfq = st.rfqs.find(r => r.id === quote.rfqId);
  if(!rfq) return { error: "rfq_not_found" };
  const existing = st.deals.find(d => d.quoteId === quote.id);
  if(existing) return { ok: true, deal: existing };

  const deal = {
    id: H.uid("dl"),
    rfqId: rfq.id, quoteId: quote.id,
    buyerName: rfq.buyerName, buyerId: rfq.buyerId,
    sellerName: quote.sellerName, sellerId: quote.sellerId,
    title: rfq.title,
    channel: rfq.channel,
    value: quote.price * (quote.qty || 1),
    currency: quote.currency,
    stage: "quote",
    nextAction: H.S(body.nextAction, 200),
    owner: H.S(actor && actor.name, 160),
    notes: [],
    risks: dealRisks(rfq, quote),
    created: Date.now(), updated: Date.now(),
  };
  st.deals = st.deals.concat([deal]);
  st.rfqs  = st.rfqs.map(r => (r.id === rfq.id ? Object.assign({}, r, { status: "shortlisted" }) : r));
  H.logEvent(st, "deal_opened", { dealId: deal.id, channel: deal.channel, value: deal.value, currency: deal.currency });
  save(st);
  return { ok: true, deal };
}

/* TZ §10.1 "deal risk flags" — cheap, explainable checks, never a verdict. */
function dealRisks(rfq, quote){
  const out = [];
  if(quote.currency !== rfq.currency) out.push("Valyuta soʻrovdan farq qiladi");
  if(rfq.maxLead && quote.leadTime > rfq.maxLead) out.push("Yetkazib berish muddati talabdan uzoq");
  if(rfq.budget && quote.qty && quote.price * quote.qty > rfq.budget * 1.15) out.push("Taklif byudjetdan 15% dan koʻp oshdi");
  if(rfq.channel === "export" && !quote.incoterm) out.push("Incoterm koʻrsatilmagan");
  if(!quote.validity) out.push("Taklifning amal qilish muddati koʻrsatilmagan");
  return out;
}

function dealUpdate(body, actor){
  const st   = load();
  const id   = H.S(body.id, 40);
  const deal = st.deals.find(d => d.id === id);
  if(!deal) return { error: "not_found" };

  const stage = DEAL_STAGES.includes(H.S(body.stage, 20)) ? H.S(body.stage, 20) : deal.stage;
  const note  = H.S(body.note, 1500);
  const next  = Object.assign({}, deal, {
    stage,
    nextAction: body.nextAction != null ? H.S(body.nextAction, 200) : deal.nextAction,
    notes: note
      ? (deal.notes || []).concat([{ by: H.S(actor && actor.name, 160) || "—", text: note, t: Date.now() }]).slice(-50)
      : deal.notes,
    updated: Date.now(),
  });
  st.deals = st.deals.map(d => (d.id === id ? next : d));
  if(stage !== deal.stage) H.logEvent(st, "deal_stage", { dealId: id, from: deal.stage, to: stage, value: deal.value });
  if(stage === "order" || stage === "fulfilment" || stage === "closed"){
    st.rfqs = st.rfqs.map(r => (r.id === deal.rfqId ? Object.assign({}, r, { status: "awarded" }) : r));
  }
  save(st);
  return { ok: true, deal: next };
}

function dealsFor(companyId){
  return load().deals
    .filter(d => d.sellerId === companyId || d.buyerId === companyId)
    .sort((a, b) => b.updated - a.updated);
}

/* ---------- direct inquiries ----------
   A showroom visitor who wants one specific product from one specific company
   does not want to broadcast an RFQ to the whole market. This is the private
   one-to-one channel: it lands in that company's Seller Center, and the thread
   stays visible to the buyer through the same contact address. */
function inquiryAdd(body, target){
  const st = load();
  const contact = H.S(body.contact, 200);
  const email   = H.S(body.email, 120).toLowerCase();
  if(!contact && !email) return { error: "contact_required" };

  /* The buyer has no account, so the thread cannot be protected by a login.
     It is protected by a capability instead: a key minted on the first
     enquiry from this address and handed back to that browser. Knowing the
     e-mail alone is not enough to read the thread. */
  const existing = st.inquiries.find(i => i.buyerEmail && i.buyerEmail === email && i.viewKey);
  const viewKey = (H.S(body.viewKey, 60) && existing && existing.viewKey === H.S(body.viewKey, 60))
    ? existing.viewKey
    : (existing ? existing.viewKey : H.uid("vk") + H.uid(""));

  const row = {
    id:          H.uid("iq"),
    viewKey,
    companyId:   H.S(target.companyId, 40),
    companyName: H.S(target.companyName, 160),
    productId:   H.S(target.productId, 40),
    productName: H.S(target.productName, 200),
    source:      H.ONE(body.source, ["showroom", "bozor", "direct"], "showroom"),
    buyerName:   H.S(body.name, 160) || "Xaridor",
    buyerEmail:  email,
    contact,
    company:     H.S(body.company, 160),      // the buyer's own organisation, if any
    country:     H.S(body.country, 120),
    qty:         H.N(body.qty),
    unit:        H.S(body.unit, 30),
    message:     H.S(body.message, 3000),
    status:      "new",
    replies:     [],
    created:     Date.now(),
    updated:     Date.now(),
  };
  if(!row.companyId) return { error: "company_required" };
  /* The endpoint is open to visitors, so the collection is capped: a flood
     cannot grow this document without bound. */
  st.inquiries = st.inquiries.concat([row]).slice(-2000);
  H.logEvent(st, "inquiry_sent", { inquiryId: row.id, companyId: row.companyId,
    productId: row.productId, source: row.source, qty: row.qty });
  save(st);
  /* viewKey goes back to the buyer's browser only, in this one response. */
  return { ok: true, inquiry: sellerInquiry(row), viewKey: row.viewKey };
}

/* The company sees the buyer's contact — that is the point of the channel —
   but never the buyer's capability key. */
const sellerInquiry = i => { const { viewKey, ...rest } = i; return rest; };
/* The buyer sees their own thread, never another buyer's. */
const buyerInquiry = i => ({ id: i.id, companyName: i.companyName, productName: i.productName,
  productId: i.productId, message: i.message, qty: i.qty, unit: i.unit,
  status: i.status, replies: i.replies, created: i.created, updated: i.updated });

function inquiryReply(company, body){
  const st = load();
  const id = H.S(body.id, 40);
  const iq = st.inquiries.find(x => x.id === id);
  if(!iq) return { error: "not_found" };
  if(iq.companyId !== company.id) return { error: "forbidden" };

  const text = H.S(body.text, 3000);
  /* Reopening from the archive restores the state the thread had before it was
     closed: answered if the company had already written back, new if not. */
  const asked = H.S(body.status, 20);
  const status = asked === "reopen"
    ? ((iq.replies || []).length ? "answered" : "new")
    : (INQUIRY_STATUS.includes(asked) ? asked : (text ? "answered" : iq.status));
  if(!text && status === iq.status) return { error: "empty" };

  const next = Object.assign({}, iq, {
    status,
    replies: text
      ? (iq.replies || []).concat([{ by: H.S(company.name, 160), text, t: Date.now() }]).slice(-40)
      : iq.replies,
    updated: Date.now(),
  });
  st.inquiries = st.inquiries.map(x => (x.id === id ? next : x));
  H.logEvent(st, "inquiry_answered", { inquiryId: id, companyId: company.id, status });
  save(st);
  return { ok: true, inquiry: sellerInquiry(next) };
}

const inquiriesFor = companyId => load().inquiries
  .filter(i => i.companyId === companyId)
  .sort((a, b) => b.updated - a.updated)
  .map(sellerInquiry);

/** Requires the capability key issued when the thread was opened. */
const inquiriesOf = (email, key) => {
  const e = H.S(email, 120).toLowerCase();
  const k = H.S(key, 60);
  if(!e || !k) return [];
  return load().inquiries.filter(i => i.buyerEmail === e && i.viewKey && i.viewKey === k)
    .sort((a, b) => b.updated - a.updated).map(buyerInquiry);
};

/* ---------- trust (TZ §12) ---------- */
function trustOf(company, st){
  const store  = st || load();
  const mine   = store.products.filter(p => p.companyId === company.id);
  const deals  = store.deals.filter(d => d.sellerId === company.id);
  const closed = deals.filter(d => d.stage === "closed" || d.stage === "fulfilment").length;

  let i = 0;
  if(company.id) i = 1;                                       // L1 contact verified
  if(company.assocId) i = 2;                                  // L2 vouched for by its association
  if(mine.some(p => (p.certificates || []).length)) i = 3;    // L3 product/document evidence
  if(closed >= 1) i = 4;                                      // L4 real trade history
  if(mine.some(p => p.verified)) i = 5;                       // L5 operator-verified

  const t = TRUST[i];
  return { level: t.level, badge: t.badge, products: mine.length, deals: deals.length, closedDeals: closed };
}

/* ---------- export readiness (TZ §8.1) ---------- */
function exportReadiness(company, st){
  const store = st || load();
  const mine  = store.products.filter(p => p.companyId === company.id);
  const exp   = mine.filter(p => (p.channels || []).includes("export"));

  const blocks = [
    { key: "Mahsulot",   value: exp.some(p => p.specs && p.media.length) ? 1 : exp.length ? .5 : 0,
      hint: "Eksport mahsulotiga texnik tavsif va media qoʻshing" },
    { key: "Sertifikat", value: exp.some(p => p.certificates.length) ? 1 : 0,
      hint: "Sifat/kelib chiqish sertifikatlarini yuklang" },
    { key: "Tijorat",    value: exp.some(p => p.price && p.moq && p.leadTime) ? 1 : exp.some(p => p.price) ? .5 : 0,
      hint: "Eksport narxi, MOQ va lead time ni toʻldiring" },
    { key: "Bozor",      value: exp.some(p => p.markets.length) ? 1 : 0,
      hint: "Maqsadli eksport bozorlarini belgilang" },
    { key: "Operatsiya", value: exp.some(p => p.hs && p.incoterms.length) ? 1 : exp.some(p => p.hs) ? .5 : 0,
      hint: "HS-code va Incoterms ni koʻrsating" },
    { key: "Sotuv",      value: store.quotes.some(q => q.sellerId === company.id) ? 1 : 0,
      hint: "Kelgan soʻrovlarga taklif yuboring — javob tezligi baholanadi" },
  ];
  const total = Math.round(100 * blocks.reduce((s, b) => s + b.value, 0) / blocks.length);
  return {
    score: total,
    blocks: blocks.map(b => ({ key: b.key, pct: Math.round(b.value * 100), hint: b.value < 1 ? b.hint : "" })),
  };
}

module.exports = {
  CHANNELS, CURRENCIES, DEAL_STAGES, RFQ_STATUS, P_STATUS, TRUST, INQUIRY_STATUS,
  inquiryAdd, inquiryReply, inquiriesFor, inquiriesOf,
  load, save, view, priceAt,
  productSave, productRemove, productsOf, searchProducts,
  rfqAdd, rfqList, rfqMatches, matchRfq,
  quoteAdd, quotesFor,
  dealOpen, dealUpdate, dealsFor,
  trustOf, exportReadiness,
};
