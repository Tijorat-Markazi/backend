/* ============================================================
   API surface for the three market modules.

   server.js owns transport (routing prefix, bodies, JSON, TLS);
   this file owns the module routes. It receives what it needs
   through `ctx` rather than importing server.js back, so the
   dependency stays one-directional.

   Identity is supplied by the opaque server session in auth.js. Account IDs
   are resolved from current records; visitor IDs come from the server cookie.
   Contact email addresses are never ownership credentials.
   ============================================================ */
const H = require("./store");
const B = require("./bozor");
const M = require("./moliya");
const K = require("./moliya-capital");
const W = require("./mehnat");
const I = require("./intel");
const CP = require("./copilot");
const R  = require("./register");
const AN = require("./analytics");
const BY = require("./buyer");
const PW = require("./passwords");
const Auth = require("./auth");
const L  = require("./legal");
const RT = require("./rights");

const PREFIXES = ["/api/bozor/", "/api/moliya/", "/api/mehnat/", "/api/market/", "/api/copilot",
                  "/api/register", "/api/analyst", "/api/buyer", "/api/legal"];
const owns = p => PREFIXES.some(x => p === x.replace(/\/$/, "") || p.startsWith(x));

/* ---------- identity ---------- */
/** A company acting as seller / finance provider / employer. */
function company(){const c=Auth.record("company");return c?{id:c.id,name:c.name,sector:c.sector,assocId:c.assocId||"",raw:c}:null;}
function buyer(){const b=Auth.record("buyer");return b?{id:b.id,name:b.name,login:b.login,email:b.email||"",contactName:b.contactName||"",raw:b,type:"buyer"}:null;}
const person=body=>Auth.person(body);
const actor=(ctx,body)=>company()||buyer()||person(body);
const needBuyer=()=>buyer();
const need=(res,ctx,what)=>ctx.json(res,401,{error:what});
const out=(res,ctx,r)=>r&&r.error?ctx.json(res,r.error==="forbidden"?403:400,r):ctx.json(res,200,r);
function approver(){const a=Auth.actor();return a&&["admin","rais","assoc"].includes(a.type)?a:null;}

/* ============================================================
   handler
   ============================================================ */
function currentAnalyst(){
  if(Auth.hasRole("admin"))return {name:"Administrator",org:"",scopes:AN.MODULES};
  const a=Auth.record("analyst");return a?{id:a.id,name:a.name,org:a.org||"",login:a.login,scopes:Array.isArray(a.scopes)?a.scopes.filter(m=>AN.MODULES.includes(m)):[]}:null;
}
async function handle(req, res, pathname, query, ctx){
  const GET  = req.method === "GET";
  const POST = req.method === "POST";
  const body = POST ? await ctx.readBody(req) : {};

  /* ---------------- BOZOR ---------------- */
  if(pathname === "/api/bozor/products" && GET)
    return ctx.json(res, 200, B.searchProducts(query));

  if(pathname === "/api/bozor/product" && POST){
    const c = company(ctx, body);
    if(!c) return need(res, ctx, "company_login_required");
    return out(res, ctx, B.productSave(c, body));
  }
  if(pathname === "/api/bozor/product/delete" && POST){
    const c = company(ctx, body);
    if(!c) return need(res, ctx, "company_login_required");
    return out(res, ctx, B.productRemove(c, H.S(body.id, 40)));
  }
  /* Seller Center in one call: catalogue, trust level, export readiness,
     inbound RFQs worth answering and the deals already in flight. */
  if(pathname === "/api/bozor/seller" && POST){
    const c = company(ctx, body);
    if(!c) return need(res, ctx, "company_login_required");
    const st = B.load();
    const mine = B.productsOf(c.id);
    /* Everything still winnable: an RFQ another seller has been shortlisted on
       is not awarded yet, so it stays in the inbox until it is. */
    const inbox = B.rfqList({})
      .filter(r => r.status === "open" || r.status === "shortlisted")
      .map(r => {
        const m = B.matchRfq(r, st).filter(x => x.product.companyId === c.id)[0];
        return m ? Object.assign({}, r, { score: m.score, reasons: m.reasons, gaps: m.gaps,
          product: m.product.title, productId: m.product.id }) : null;
      })
      .filter(Boolean).sort((a, b) => b.score - a.score).slice(0, 30);
    return ctx.json(res, 200, { ok: true, company: { id: c.id, name: c.name, sector: c.sector },
      products: mine, inbox, quotes: st.quotes.filter(q => q.sellerId === c.id),
      deals: B.dealsFor(c.id), inquiries: B.inquiriesFor(c.id),
      trust: B.trustOf(c, st), exportReadiness: B.exportReadiness(c, st) });
  }

  /* ---- direct buyer → company inquiries (showroom product pages) ---- */
  if(pathname === "/api/bozor/inquiry" && POST){
    /* Deliberately open to visitors: a showroom is a shop window, and requiring
       an account before anyone may ask a question is how shop windows go quiet.
       The company is resolved server-side from the id, never trusted from the
       body, and a reachable contact is mandatory. */
    const o = ctx.core.getOrgs();
    const co = o.companies.find(x => x.id === H.S(body.companyId, 40));
    if(!co) return ctx.json(res, 404, { error: "company_not_found" });
    let productName = H.S(body.productName, 200);
    const pid = H.S(body.productId, 40);
    if(pid){
      const p = (co.showroom || []).find(x => x && x.id === pid);
      if(p) productName = p.name || productName;
    }
    return out(res, ctx, B.inquiryAdd(body, { companyId: co.id, companyName: co.name,
      productId: pid, productName }, buyer()));
  }
  if(pathname === "/api/bozor/inquiries" && POST){
    const c = company(ctx, body);
    if(!c) return need(res, ctx, "company_login_required");
    const items = B.inquiriesFor(c.id);
    return ctx.json(res, 200, { ok: true, items,
      unread: items.filter(i => i.status === "new").length });
  }
  if(pathname === "/api/bozor/inquiry/reply" && POST){
    const c = company(ctx, body);
    if(!c) return need(res, ctx, "company_login_required");
    return out(res, ctx, B.inquiryReply(c, body));
  }
  if(pathname === "/api/bozor/inquiry/mine" && POST){
    const p = person(body);
    if(!p) return need(res, ctx, "email_required");
    return ctx.json(res, 200, { ok: true, items: B.inquiriesOf(p.id) });
  }

  if(pathname === "/api/bozor/rfqs" && GET) return ctx.json(res, 200, { items: B.rfqList(query) });
  if(pathname === "/api/bozor/rfq" && POST){
    const a = actor(ctx, body);
    return out(res, ctx, B.rfqAdd(body, a));
  }
  if(pathname === "/api/bozor/rfq/matches" && GET)
    return out(res, ctx, B.rfqMatches(H.S(query.id, 40)));
  if(pathname === "/api/bozor/rfq/mine" && POST){
    const a = actor(ctx, body);
    if(!a) return need(res, ctx, "identify_first");
    const st = B.load();
    return ctx.json(res, 200, { ok: true, items: st.rfqs.filter(r => r.buyerId === a.id)
      .sort((x, y) => y.created - x.created)
      .map(r => Object.assign({}, r, { quoteCount: st.quotes.filter(q => q.rfqId === r.id).length })) });
  }

  if(pathname === "/api/bozor/quotes" && GET){
    const id=H.S(query.rfqId,40),a=actor(ctx,{}),r=B.load().rfqs.find(x=>x.id===id);
    if(!a||!r||r.buyerId!==a.id)return ctx.json(res,403,{error:"forbidden"});
    return out(res,ctx,B.quotesFor(id));
  }
  if(pathname === "/api/bozor/quote" && POST){
    const c = company(ctx, body);
    if(!c) return need(res, ctx, "company_login_required");
    return out(res, ctx, B.quoteAdd(body, c));
  }

  if(pathname === "/api/bozor/deal" && POST){
    const a = actor(ctx, body);
    if(!a) return need(res, ctx, "identify_first");
    return out(res, ctx, B.dealOpen(body, a));
  }
  if(pathname === "/api/bozor/deal/update" && POST){
    const a = actor(ctx, body);
    if(!a) return need(res, ctx, "identify_first");
    return out(res, ctx, B.dealUpdate(body, a));
  }
  if(pathname === "/api/bozor/deals" && POST){
    const a = actor(ctx, body);
    if(!a) return need(res, ctx, "identify_first");
    return ctx.json(res, 200, { ok: true, items: B.dealsFor(a.id) });
  }
  if(pathname === "/api/bozor/intel" && GET)
    return ctx.json(res, 200, I.marketIntel(query.days));
  if(pathname === "/api/bozor/meta" && GET)
    return ctx.json(res, 200, { channels: B.CHANNELS, currencies: B.CURRENCIES,
      dealStages: B.DEAL_STAGES, trust: B.TRUST });

  /* ---------------- MOLIYA ---------------- */
  if(pathname === "/api/moliya/products" && GET)
    return ctx.json(res, 200, M.searchProducts(query));
  if(pathname === "/api/moliya/product" && POST){
    const c = company(ctx, body);
    if(!c) return need(res, ctx, "company_login_required");
    return out(res, ctx, M.productSave(c, body));
  }
  if(pathname === "/api/moliya/product/delete" && POST){
    const c = company(ctx, body);
    if(!c) return need(res, ctx, "company_login_required");
    return out(res, ctx, M.productRemove(c, H.S(body.id, 40)));
  }
  /* Provider dashboard: own catalogue, open requests it is eligible for, own offers. */
  if(pathname === "/api/moliya/provider" && POST){
    const c = company(ctx, body);
    if(!c) return need(res, ctx, "company_login_required");
    const st = M.load();
    const leads = M.requestList({ status: "" })
      .filter(r => r.status !== "closed")
      .map(r => {
        const full = st.requests.find(x => x.id === r.id);
        const m = M.routeRequest(full, st).filter(x => x.product.providerId === c.id)[0];
        return m ? Object.assign({}, r, { score: m.score, reasons: m.reasons, gaps: m.gaps,
          product: m.product.name, productId: m.product.id }) : null;
      })
      .filter(Boolean).sort((a, b) => b.score - a.score).slice(0, 30);
    return ctx.json(res, 200, { ok: true, provider: { id: c.id, name: c.name },
      products: M.productsOf(c.id), leads, offers: M.offersOf(c.id) });
  }

  if(pathname === "/api/moliya/passport" && POST){
    const a = actor(ctx, body);
    if(!a) return need(res, ctx, "identify_first");
    return out(res, ctx, body.op === "get" ? M.passportOf(a.id) : M.passportSave(a, body));
  }
  if(pathname === "/api/moliya/consent" && POST){
    const a = actor(ctx, body);
    if(!a) return need(res, ctx, "identify_first");
    return out(res, ctx, body.op === "revoke"
      ? M.consentRevoke(a, H.S(body.id, 40)) : M.consentGrant(a, body));
  }

  if(pathname === "/api/moliya/requests" && GET)
    return ctx.json(res, 200, { items: M.requestList(query) });
  if(pathname === "/api/moliya/request" && POST){
    const a = actor(ctx, body);
    return out(res, ctx, M.requestAdd(body, a));
  }
  if(pathname === "/api/moliya/request/matches" && GET)
    return out(res, ctx, M.requestMatches(H.S(query.id, 40)));
  if(pathname === "/api/moliya/request/status" && POST){
    const a = actor(ctx, body);
    if(!a) return need(res, ctx, "identify_first");
    return out(res, ctx, M.requestSetStatus(a, body));
  }
  if(pathname === "/api/moliya/request/mine" && POST){
    const a = actor(ctx, body);
    if(!a) return need(res, ctx, "identify_first");
    return ctx.json(res, 200, { ok: true, items: M.requestsOf(a.id) });
  }
  if(pathname === "/api/moliya/offers" && GET){
    const id=H.S(query.requestId,40),a=actor(ctx,{}),request=M.load().requests.find(r=>r.id===id);
    if(!a||!request||request.ownerId!==a.id)return ctx.json(res,403,{error:"forbidden"});
    return out(res,ctx,M.offerCompare(id));
  }
  if(pathname === "/api/moliya/offer" && POST){
    const c = company(ctx, body);
    if(!c) return need(res, ctx, "company_login_required");
    return out(res, ctx, M.offerAdd(body, c));
  }

  if(pathname === "/api/moliya/investors" && GET)
    return ctx.json(res, 200, { items: K.investorList() });
  if(pathname === "/api/moliya/investor" && POST){
    const a = actor(ctx, body);
    if(!a) return need(res, ctx, "identify_first");
    return out(res, ctx, body.op === "get"
      ? { ok: true, investor: K.investorOf(a.id) } : K.investorSave(a, body));
  }

  if(pathname === "/api/moliya/projects" && GET)
    return ctx.json(res, 200, { items: K.projectList(query), gates: K.GATES, labels: K.GATE_LABEL });
  if(pathname === "/api/moliya/project" && POST){
    const a = actor(ctx, body);
    if(!a) return need(res, ctx, "identify_first");
    return out(res, ctx, K.projectSave(a, body));
  }
  if(pathname === "/api/moliya/project/gate" && POST){
    const a = actor(ctx, body);
    if(!a) return need(res, ctx, "identify_first");
    return out(res, ctx, K.projectGate(a, body));
  }

  if(pathname === "/api/moliya/startups" && GET)
    return ctx.json(res, 200, { items: K.startupList() });
  if(pathname === "/api/moliya/startup" && POST){
    const a = actor(ctx, body);
    if(!a) return need(res, ctx, "identify_first");
    return out(res, ctx, K.startupSave(a, body));
  }

  if(pathname === "/api/moliya/ideas" && GET)
    return ctx.json(res, 200, { items: K.ideaList(), models: K.IDEA_MODELS });
  if(pathname === "/api/moliya/idea" && POST){
    const a = actor(ctx, body);
    if(!a) return need(res, ctx, "identify_first");
    if(body.op === "open") return out(res, ctx, K.ideaOpen(H.S(body.id, 40), a));
    if(body.op === "nda")  return out(res, ctx, K.ideaNda(H.S(body.id, 40), a));
    return out(res, ctx, K.ideaSave(a, body));
  }

  if(pathname === "/api/moliya/match" && GET)
    return out(res, ctx, K.matchFor(H.S(query.kind, 20), H.S(query.id, 40)));
  if(pathname === "/api/moliya/capital-stack" && POST)
    return out(res, ctx, K.capitalStack(body));
  if(pathname === "/api/moliya/intel" && GET)
    return ctx.json(res, 200, I.capitalIntel(query.days));
  if(pathname === "/api/moliya/meta" && GET)
    return ctx.json(res, 200, { categories: M.CATEGORIES, currencies: M.CURRENCIES,
      segments: M.SEGMENTS, islamic: M.ISLAMIC, investorTypes: K.INVESTOR_TYPES,
      stages: K.STAGES, instruments: K.INSTRUMENTS, gates: K.GATES, gateLabels: K.GATE_LABEL,
      ideaModels: K.IDEA_MODELS });

  /* ---------------- MEHNAT ---------------- */
  if(pathname === "/api/mehnat/jobs" && GET)
    return ctx.json(res, 200, W.searchJobs(query));
  if(pathname === "/api/mehnat/talent" && GET)
    return ctx.json(res, 200, W.searchTalent(query));

  if(pathname === "/api/mehnat/candidate" && POST){
    const p = person(body);
    if(!p) return need(res, ctx, "email_required");
    if(body.op === "get"){
      const c = W.candidateOf(p.id);
      return ctx.json(res, 200, { ok: true, candidate: c ? W.candidateView(c, { full: true }) : null });
    }
    return out(res, ctx, W.candidateSave(p, body));
  }
  if(pathname === "/api/mehnat/matches" && POST){
    const p = person(body);
    if(!p) return need(res, ctx, "email_required");
    return out(res, ctx, W.matchesForCandidate(p.id, body.limit));
  }
  if(pathname === "/api/mehnat/apply" && POST){
    const p = person(body);
    if(!p) return need(res, ctx, "email_required");
    return out(res, ctx, W.apply(p, body));
  }
  if(pathname === "/api/mehnat/applications" && POST){
    const p = person(body);
    if(!p) return need(res, ctx, "email_required");
    const c = W.candidateOf(p.id);
    return ctx.json(res, 200, { ok: true, items: c ? W.applicationsOf(c.id) : [] });
  }
  if(pathname === "/api/mehnat/offer/respond" && POST){
    const p = person(body);
    if(!p) return need(res, ctx, "email_required");
    return out(res, ctx, W.offerRespond(p, body));
  }

  if(pathname === "/api/mehnat/vacancy" && POST){
    const c = company(ctx, body);
    if(!c) return need(res, ctx, "company_login_required");
    if(body.op === "close") return out(res, ctx, W.vacancyClose(c, H.S(body.id, 40)));
    return out(res, ctx, W.vacancySave(c, body));
  }
  if(pathname === "/api/mehnat/employer" && POST){
    const c = company(ctx, body);
    if(!c) return need(res, ctx, "company_login_required");
    return ctx.json(res, 200, { ok: true, company: { id: c.id, name: c.name, sector: c.sector },
      vacancies: W.vacanciesOf(c.id), pipeline: W.pipeline(c.id, H.S(body.vacancyId, 40)) });
  }
  if(pathname === "/api/mehnat/vacancy/matches" && POST){
    const c = company(ctx, body);
    if(!c) return need(res, ctx, "company_login_required");
    const r = W.matchesForVacancy(H.S(body.id, 40), body.limit);
    if(r.error) return out(res, ctx, r);
    if(r.vacancy.companyId !== c.id) return ctx.json(res, 403, { error: "forbidden" });
    return ctx.json(res, 200, r);
  }
  if(pathname === "/api/mehnat/stage" && POST){
    const c = company(ctx, body);
    if(!c) return need(res, ctx, "company_login_required");
    return out(res, ctx, W.stageSet(c, body));
  }
  if(pathname === "/api/mehnat/intel" && GET)
    return ctx.json(res, 200, I.laborIntel(query.days, query));
  if(pathname === "/api/mehnat/salary" && GET)
    return ctx.json(res, 200, I.salaryBenchmark(query));
  if(pathname === "/api/mehnat/meta" && GET)
    return ctx.json(res, 200, { seniority: W.SENIORITY, formats: W.FORMATS,
      employment: W.EMPLOYMENT, availability: W.AVAILABILITY, stages: W.STAGES,
      reasons: W.REASONS, visibility: W.VISIBILITY, currencies: W.CURRENCIES });


  /* ---------------- COMPANY REGISTRATION ----------------
     The submit endpoint is deliberately public — a company that does not yet
     have an account is exactly who needs it. Nothing it sends creates access:
     it creates an application that a human has to approve. */
  if(pathname === "/api/register/meta" && GET){
    const o = ctx.core.getOrgs();
    return ctx.json(res, 200, { ok: true,
      associations: (o.associations || [])
        .map(a => ({ id: a.id, name: a.name, i18n: ctx.core.orgNames(a) }))
        .sort((x, y) => String(x.name).localeCompare(String(y.name))),
      sectors: [...new Set((o.companies || []).map(c => c.sector).filter(Boolean))].sort() });
  }
  if(pathname === "/api/register" && POST)
    return out(res, ctx, R.submit(body, ctx.core.getOrgs(), req));
  /* The buyer queue. Same public-by-design reasoning: it creates an
     application, and only oversight can turn one into an account. */
  if(pathname === "/api/register/buyer" && POST)
    return out(res, ctx, R.submitBuyer(body, ctx.core.getOrgs(), req));
  if(pathname === "/api/register/status" && POST)
    return out(res, ctx, R.status(body.email, body.ref));

  if(pathname === "/api/register/list" && POST){
    const a = approver(ctx, body);
    if(!a) return need(res, ctx, "approver_login_required");
    /* listFor() is already company-only, so an association asking for the
       buyer queue gets its own queue, not someone else's. */
    const items = a.type === "assoc" ? R.listFor(a.id, body) : R.listAll(body);
    const kind = a.type === "assoc" ? "company" : H.S(body.kind, 20);
    return ctx.json(res, 200, { ok: true, items,
      counts: R.counts(a.type === "assoc" ? a.id : "", kind), scope: a.type });
  }
  if(pathname === "/api/register/decide" && POST){
    const a = approver(ctx, body);
    if(!a) return need(res, ctx, "approver_login_required");
    const o = ctx.core.getOrgs();
    return out(res, ctx, R.decide(body, a, o, ctx.core.saveOrgs));
  }

  /* ---------------- LEGAL · requisites and the rights of the data subject ----
     The GET is public on purpose: the operator's requisites are exactly the
     information ZRU-792 and Qoidalar 24-band require be shown BEFORE anyone
     transacts, so putting them behind a login would defeat them. Everything
     that touches one person's file is credential-gated instead — an e-mail in
     a public box would turn a right of access into a way to read a stranger's
     record. */
  if(pathname === "/api/legal" && GET)
    return ctx.json(res, 200, Object.assign({ ok: true }, L.publicConfig()));

  if(pathname === "/api/legal/mine" && POST){
    const sub=RT.subjectOf(ctx.core);if(!sub)return need(res,ctx,"login_required");
    return ctx.json(res,200,{ok:true,items:RT.exportFor(sub,ctx.core).rightsRequests});
  }
  if(pathname === "/api/legal/export" && POST){
    const sub = RT.subjectOf(ctx.core, body);
    if(!sub) return need(res, ctx, "login_required");
    return ctx.json(res, 200, { ok: true, data: RT.exportFor(sub, ctx.core) });
  }
  if(pathname === "/api/legal/withdraw" && POST){
    const sub = RT.subjectOf(ctx.core, body);
    if(!sub) return need(res, ctx, "login_required");
    return out(res, ctx, RT.withdraw(sub, ctx.core, req, body));
  }
  if(pathname === "/api/legal/erase" && POST){
    const sub = RT.subjectOf(ctx.core, body);
    if(!sub) return need(res, ctx, "login_required");
    return out(res, ctx, RT.requestErasure(sub, req, body));
  }

  /* The oversight side of the same queue. A deadline nobody can see is a
     deadline nobody meets, so `overdue` rides along on every listing. */
  if(pathname === "/api/legal/requests" && POST){
    const a = approver(ctx, body);
    if(!a || a.type === "assoc") return need(res, ctx, "oversight_login_required");
    return ctx.json(res, 200, { ok: true, items: RT.list(body), overdue: RT.overdueCount() });
  }
  if(pathname === "/api/legal/answer" && POST){
    const a = approver(ctx, body);
    if(!a || a.type === "assoc") return need(res, ctx, "oversight_login_required");
    return out(res, ctx, RT.answer(body.id || body.ref, body, a));
  }


  /* ---------------- XARIDOR · the B2B buyer cabinet ----------------
     Every route below resolves the buyer from credentials and then uses the
     RESOLVED id — never one from the body. That is the whole reason this tier
     exists: buyer-side records used to be keyed on an unverified e-mail, so
     "my RFQs" was really "the RFQs of whoever claims this address".

     The channel is pinned to b2b here rather than accepted as a parameter.
     A buyer that could pass channel:"b2g" would be bidding on public
     procurement through a cabinet that was never approved for it. */
  if(pathname === "/api/buyer/login" && POST){
    const b = needBuyer(ctx, body);
    if(!b) return ctx.json(res, 401, { error: "invalid_credentials" });
    return ctx.json(res, 200, { ok: true, buyer: BY.view(b.raw), channel: BY.CHANNEL });
  }

  /* The whole cabinet in one call: profile, requests, offers, orders, threads
     and the shortlist. Four round trips on every tab switch is how a cabinet
     comes to feel slow. */
  if(pathname === "/api/buyer/home" && POST){
    const b = needBuyer(ctx, body);
    if(!b) return need(res, ctx, "buyer_login_required");
    const st = B.load();
    const rfqs = st.rfqs.filter(r => r.buyerId === b.id)
      .sort((x, y) => y.created - x.created)
      .map(r => Object.assign({}, r, {
        quoteCount: st.quotes.filter(q => q.rfqId === r.id).length }));
    return ctx.json(res, 200, { ok: true,
      buyer:     BY.view(b.raw),
      rfqs,
      deals:     B.dealsFor(b.id),
      inquiries: B.inquiriesOfBuyer(b.id),
      saved:     BY.savedSuppliers(ctx.core.getOrgs(), b),
      meta: { channel: BY.CHANNEL, stages: B.DEAL_STAGES, currencies: B.CURRENCIES } });
  }

  /* The catalogue, permanently narrowed to this tier's one channel. */
  if(pathname === "/api/buyer/products" && GET)
    return ctx.json(res, 200, B.searchProducts(Object.assign({}, query, { channel: BY.CHANNEL })));

  if(pathname === "/api/buyer/profile" && POST){
    const b = needBuyer(ctx, body);
    if(!b) return need(res, ctx, "buyer_login_required");
    const o = ctx.core.getOrgs();
    return out(res, ctx, BY.profileSave(o, b, body, ctx.core.saveOrgs));
  }
  if(pathname === "/api/buyer/saved" && POST){
    const b = needBuyer(ctx, body);
    if(!b) return need(res, ctx, "buyer_login_required");
    const o = ctx.core.getOrgs();
    const r = BY.savedToggle(o, b, body.companyId, ctx.core.saveOrgs);
    if(r.error) return out(res, ctx, r);
    /* Hand back the resolved list, so the cabinet never has to re-fetch to
       learn the name of what it just saved. */
    return ctx.json(res, 200, Object.assign(r,
      { suppliers: BY.savedSuppliers(ctx.core.getOrgs(), { id: b.id, raw: { saved: r.saved } }) }));
  }

  if(pathname === "/api/buyer/rfq" && POST){
    const b = needBuyer(ctx, body);
    if(!b) return need(res, ctx, "buyer_login_required");
    return out(res, ctx, B.rfqAdd(
      Object.assign({}, body, { channel: BY.CHANNEL, buyerType: "company" }), b));
  }

  /* Quotes on ONE of my requests. The ownership test is the route: without it
     this is a public read of every seller's pricing on every tender. */
  if(pathname === "/api/buyer/quotes" && POST){
    const b = needBuyer(ctx, body);
    if(!b) return need(res, ctx, "buyer_login_required");
    const rfqId = H.S(body.rfqId, 40);
    const mine = B.load().rfqs.find(r => r.id === rfqId && r.buyerId === b.id);
    if(!mine) return ctx.json(res, 403, { error: "forbidden" });
    return out(res, ctx, B.quotesFor(rfqId));
  }

  if(pathname === "/api/buyer/deal" && POST){
    const b = needBuyer(ctx, body);
    if(!b) return need(res, ctx, "buyer_login_required");
    return out(res, ctx, B.dealOpen(body, b));
  }
  if(pathname === "/api/buyer/deal/update" && POST){
    const b = needBuyer(ctx, body);
    if(!b) return need(res, ctx, "buyer_login_required");
    return out(res, ctx, B.dealUpdate(body, b));
  }

  /* A private question about one product. The product is looked up in the
     Bozor catalogue rather than trusted from the body, which is also where
     the b2b restriction bites: a product not sold on this channel cannot be
     enquired about from this cabinet at all. */
  if(pathname === "/api/buyer/inquiry" && POST){
    const b = needBuyer(ctx, body);
    if(!b) return need(res, ctx, "buyer_login_required");
    const prod = B.load().products.find(p => p.id === H.S(body.productId, 40));
    if(!prod) return ctx.json(res, 404, { error: "product_not_found" });
    if(prod.status !== "live" || !(prod.channels || []).includes(BY.CHANNEL))
      return ctx.json(res, 403, { error: "not_b2b" });
    const co = (ctx.core.getOrgs().companies || []).find(x => x.id === prod.companyId);
    if(!co) return ctx.json(res, 404, { error: "company_not_found" });
    return out(res, ctx, B.inquiryAdd(Object.assign({}, body, { source: "bozor" }),
      { companyId: co.id, companyName: co.name, productId: prod.id, productName: prod.title }, b));
  }
  if(pathname === "/api/buyer/inquiry/ask" && POST){
    const b = needBuyer(ctx, body);
    if(!b) return need(res, ctx, "buyer_login_required");
    return out(res, ctx, B.inquiryAsk(b, body));
  }


  /* ---------------- ANALYST WORKBENCH ----------------
     A read-only cabinet over aggregated data. Analysts hold their own
     accounts precisely so that reading intelligence never requires the
     rights that let someone change operational records. */
  if(pathname === "/api/analyst/login" && POST){
    const a = currentAnalyst();
    if(!a) return ctx.json(res, 401, { error: "invalid_credentials" });
    return ctx.json(res, 200, { ok: true, analyst: { name: a.name, org: a.org, scopes: a.scopes },
      modules: AN.MODULES, dimensions: AN.DIMENSIONS, metrics: AN.METRICS });
  }

  /* Oversight can open the workbench without a separate account. */
  const analyst = () => currentAnalyst();

  if(pathname === "/api/analyst/overview" && POST){
    const a = analyst();
    if(!a) return need(res, ctx, "analyst_login_required");
    return ctx.json(res, 200, Object.assign({ ok: true, scopes: a.scopes },
      AN.overview(body.days, ctx.core.getOrgs())));
  }
  if(pathname === "/api/analyst/segment" && POST){
    const a = analyst();
    if(!a) return need(res, ctx, "analyst_login_required");
    if(!AN.canSee(a, H.S(body.module, 10))) return ctx.json(res, 403, { error: "out_of_scope" });
    return ctx.json(res, 200, Object.assign({ ok: true }, AN.segment(body)));
  }
  if(pathname === "/api/analyst/series" && POST){
    const a = analyst();
    if(!a) return need(res, ctx, "analyst_login_required");
    if(!AN.canSee(a, H.S(body.module, 10))) return ctx.json(res, 403, { error: "out_of_scope" });
    return ctx.json(res, 200, Object.assign({ ok: true }, AN.series(body)));
  }

  /* The download is a real file, so it bypasses the JSON helper. */
  if(pathname === "/api/analyst/export" && POST){
    const a = analyst();
    if(!a) return need(res, ctx, "analyst_login_required");
    const kind = H.ONE(body.kind, ["xlsx", "doc"], "xlsx");
    const sheets = AN.sheets({ days: body.days, scopes: a.scopes }, ctx.core.getOrgs());
    const stamp = new Date().toISOString().slice(0, 10);
    if(kind === "doc"){
      const html = AN.toDoc(sheets, "TIJORAT MARKAZI — tahliliy hisobot " + stamp);
      res.writeHead(200, { "Content-Type": "application/msword",
        "Content-Disposition": 'attachment; filename="tijorat-markazi-tahlil-' + stamp + '.doc"' });
      return res.end(html);
    }
    const buf = await AN.toXlsx(sheets);
    res.writeHead(200, { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": 'attachment; filename="tijorat-markazi-tahlil-' + stamp + '.xlsx"',
      "Content-Length": buf.length });
    return res.end(buf);
  }

  /* Account management belongs to the admin, next to companies and associations. */
  if(pathname === "/api/analyst/accounts" && POST){
    if(!ctx.isAdmin()) return ctx.json(res, 403, { error: "forbidden" });
    const o = ctx.core.getOrgs();
    o.analysts = Array.isArray(o.analysts) ? o.analysts : [];
    if(body.op === "add"){
      const login = H.S(body.alogin, 60).trim().toLowerCase();
      if(!login || !body.apassword) return ctx.json(res, 400, { error: "login_password_required" });
      const clash = o.analysts.some(x => x.login === login)
        || (o.companies || []).some(c => String(c.login).toLowerCase() === login)
        || (o.associations || []).some(x => String(x.login).toLowerCase() === login);
      if(clash) return ctx.json(res, 409, { error: "login_exists" });
      const scopes = H.SUBSET(body.scopes, AN.MODULES, 3);
      /* An account that may read no market cannot do anything; refusing it here
         is clearer than minting one that silently fails every request. */
      if(!scopes.length) return ctx.json(res, 400, { error: "no_scopes" });
      o.analysts.push(PW.set({ id: H.uid("an"), name: H.S(body.name, 160) || login,
        org: H.S(body.org, 160), login, scopes, created: Date.now() },
        H.S(body.apassword, 120)));
      ctx.core.saveOrgs(o);
    } else if(body.op === "del"){
      o.analysts = o.analysts.filter(x => x.id !== H.S(body.id, 40));
      ctx.core.saveOrgs(o);
    }
    return ctx.json(res, 200, { ok: true, analysts: o.analysts.map(x =>
      ({ id: x.id, name: x.name, org: x.org, login: x.login,
         scopes: x.scopes, created: x.created })) });
  }

  /* ---------------- cross-module ---------------- */
  /* One call for the landing strip: the headline number of each market. */
  if(pathname === "/api/market/pulse" && GET){
    const b = I.marketIntel(90), m = I.capitalIntel(90), w = I.laborIntel(90, {});
    return ctx.json(res, 200, { ok: true,
      bozor:  { products: b.headline.liveProducts, rfqs: b.headline.rfqs,
                deals: b.headline.deals, matchRate: b.headline.matchRate },
      moliya: { providers: m.headline.providers, products: m.headline.products,
                requests: m.headline.requests, offers: m.headline.offers,
                investors: m.headline.investors },
      mehnat: { vacancies: w.headline.openVacancies, candidates: w.headline.activeCandidates,
                applications: w.headline.applications, hires: w.headline.hires } });
  }

  /* ---------------- AI copilots ----------------
     Metered on the same counter as every other AI call on the platform, so
     the copilots cannot be used to bypass the free tier. */
  if(pathname === "/api/copilot" && POST){
    const privileged = ctx.isPrivileged(ctx.core.getOrgs(), body.auth || body) || !!company(ctx, body);
    const meter = Auth.owner();
    if(!privileged){
      if(!meter) return ctx.json(res, 401, { error: "identify_first" });
      if(ctx.core.aiUsageCount(meter) >= ctx.core.AI_FREE_LIMIT)
        return ctx.json(res, 200, { ok: false, limit: true, error: "ai_limit" });
    }
    if(!privileged&&meter){ctx.core.aiUsageInc(meter);await require("../db").flush();}
    const r = await CP.run(body.agent, body);
    return ctx.json(res, r.ok ? 200 : 200, r);
  }
  if(pathname === "/api/copilot/agents" && GET)
    return ctx.json(res, 200, { agents: CP.agentNames(), ai: CP.ready() });

  return ctx.json(res, 404, { error: "unknown_endpoint" });
}

/* The unified sign-in in server.js resolves every tier in one request, and
   the analyst and buyer tiers live under this module — expose just the checks
   it needs, rather than the modules themselves. */
const analystAuth = (orgs, login, password) => AN.authenticate(orgs, login, password);
const buyerAuth   = (orgs, login, password) => BY.authenticate(orgs, login, password);

module.exports = { owns, handle, PREFIXES, analystAuth, buyerAuth };
